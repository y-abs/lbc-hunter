// Tier 5 — E2E: full backfill feature in REAL Chrome via Playwright.
//
// Scenarios covered (end-to-end through SW → content-script proxy → API):
//   1. First-poll backfill: multi-page pagination + LBC exhaustion + silent-seed
//   2. Cutoff early-exit + window clipping
//   3. Re-backfill via pending_backfill_days PRESERVES user flags
//   4. Page failure after all retries → pending preserved + backfill_error(page_failed)
//   5. Retry recovers on 2nd attempt → pagination continues
//   6. Auth 401 mid-backfill → startup-session-check alarm + backfill_error(fetch_error)
//   7. Zero-result backfill → backfill_done(count=0) + pending cleared
//   8. Price history seeded with ≥min(20, backfillDays) rows from multi-page prices
//   9. Silent seed: zero is_alerted=true ads even when they'd match
//  10. Telemetry fields (last_backfill_at / count / days / duration) written
//  11. Options UI renders "📋 Chargement historique N derniers jours…" when pending>0

import { test, expect } from "@playwright/test";
import {
  launchWithExtension,
  swEval,
  openExtensionPage,
  installBroadcastSpy,
  resetStores,
} from "./helpers/launch-extension.js";
import { E2E_API_SEARCH_MATCH, E2E_WEB_ORIGIN } from "./helpers/domains.js";

test.describe.configure({ mode: "serial" });

let env;
let extPage;
let apiResponder = () => ({ ads: [] });
let apiCallCount = 0;

// ── Fixtures ───────────────────────────────────────────────────────────
const DAY = 86_400_000;

function mkAd(id, { price = 100, dayOffset = 0, categoryId = "30" } = {}) {
  const ts = Date.now() - dayOffset * DAY;
  return {
    list_id: String(id),
    subject: `Ad ${id}`,
    body: "desc",
    price: [price],
    index_date: new Date(ts).toISOString(),
    first_publication_date: new Date(ts).toISOString(),
    category_id: categoryId,
    location: { city: "Paris", zipcode: "75000", lat: 48.85, lng: 2.35 },
    owner: { type: "private", user_id: `u${id}`, name: "Alice" },
    images: { urls_large: [`http://x/${id}.jpg`] },
  };
}

function pageOf(startId, count, startDayOffset = 0) {
  return Array.from({ length: count }, (_, i) => mkAd(startId + i, { dayOffset: startDayOffset + i, price: 100 + i }));
}

// ── Harness ────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  env = await launchWithExtension({
    routes: {
      [E2E_API_SEARCH_MATCH]: async (route) => {
        apiCallCount++;
        const res = await apiResponder(route.request(), apiCallCount);
        if (res?.__status) {
          return route.fulfill({
            status: res.__status,
            contentType: "application/json",
            body: JSON.stringify({ error: res.__status }),
          });
        }
        if (res?.__abort) return route.abort("failed");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(res ?? { ads: [] }),
        });
      },
    },
  });

  // Seed session via a real LBC tab load.
  const lbc = await env.context.newPage();
  await lbc.goto(`${E2E_WEB_ORIGIN}/`);
  for (let i = 0; i < 30; i++) {
    await lbc.waitForTimeout(100);
    const ok = await swEval(
      env.serviceWorker,
      async () =>
        new Promise((r) => {
          const req = indexedDB.open("lbc-hunter-db");
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("session")) {
              db.close();
              return r(false);
            }
            const g = db.transaction("session").objectStore("session").get("current");
            g.onsuccess = () => {
              db.close();
              r(!!g.result?.api_key);
            };
          };
          req.onerror = () => r(false);
        }),
    );
    if (ok) break;
  }

  extPage = await openExtensionPage(env.context, env.extensionId, "src/dashboard/dashboard.html");
});

test.afterAll(async () => {
  await env?.cleanup();
});

// ── Per-test helpers ───────────────────────────────────────────────────

async function resetState() {
  apiCallCount = 0;
  apiResponder = () => ({ ads: [] });
  await resetStores(extPage, ["ads", "watchlists", "price_history", "blacklist"]);
  // Clear notification/alert state too by wiping badge-counter key in chrome.storage.
  await extPage.evaluate(() => chrome.storage.local.clear().catch(() => {}));
}

async function putWatchlist(wl) {
  return extPage.evaluate(
    async (w) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const tx = req.result.transaction("watchlists", "readwrite");
          tx.objectStore("watchlists").put(w);
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    wl,
  );
}

async function putAd(ad) {
  return extPage.evaluate(
    async (a) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const tx = req.result.transaction("ads", "readwrite");
          tx.objectStore("ads").put(a);
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    ad,
  );
}

async function getWatchlist(id) {
  return extPage.evaluate(
    async (wlId) =>
      new Promise((resolve) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction("watchlists").objectStore("watchlists").get(wlId);
          g.onsuccess = () => {
            db.close();
            resolve(g.result ?? null);
          };
        };
        req.onerror = () => resolve(null);
      }),
    id,
  );
}

async function getAllAds() {
  return extPage.evaluate(
    async () =>
      new Promise((resolve) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction("ads").objectStore("ads").getAll();
          g.onsuccess = () => {
            db.close();
            resolve(g.result ?? []);
          };
        };
        req.onerror = () => resolve([]);
      }),
  );
}

async function getPriceHistory() {
  return extPage.evaluate(
    async () =>
      new Promise((resolve) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction("price_history").objectStore("price_history").getAll();
          g.onsuccess = () => {
            db.close();
            resolve(g.result ?? []);
          };
        };
        req.onerror = () => resolve([]);
      }),
  );
}

async function forcePoll(watchlistId) {
  return extPage.evaluate((m) => chrome.runtime.sendMessage(m), { type: "FORCE_POLL", watchlistId });
}

function baseWatchlist(overrides = {}) {
  return {
    id: "wl-bf",
    name: "Test",
    keywords: "nintendo switch",
    category_id: "30",
    budget: 500,
    price_min: 0,
    price_max: 500,
    poll_interval_seconds: 60,
    enabled: true,
    require_market_data: false,
    undermarket_threshold_pct: 100, // be permissive — test whether alerts fire
    backfill_days: 0,
    pending_backfill_days: 0,
    last_seen_ad_id: null,
    is_first_poll_seeded: false,
    created_at: Date.now(),
    ...overrides,
  };
}

// ── Scenarios ──────────────────────────────────────────────────────────

test("1. first-poll backfill: multi-page pagination + LBC exhaustion + silent seed", async () => {
  await resetState();
  const getMsgs = await installBroadcastSpy(extPage);

  // Pages 1–3: 35, 35, 10 ads. Spread over days so cutoff (60d) does NOT
  // trigger early-exit before LBC exhaustion.
  apiResponder = (_req, n) => {
    if (n === 1) return { ads: pageOf(1, 35, 0) }; // days 0-34
    if (n === 2) return { ads: pageOf(100, 35, 35) }; // days 35-69 (within 60d until oldest=69 > 60 → cutoff fires after this page)
    if (n === 3) return { ads: pageOf(200, 10, 70) };
    return { ads: [] };
  };

  await putWatchlist(baseWatchlist({ backfill_days: 60, last_seen_ad_id: null }));
  const res = await forcePoll("wl-bf");
  expect(res.ok).toBe(true);
  expect(res.result.status).toBe("ok");

  await extPage.waitForTimeout(300);

  // At least the first page fetched; cutoff may stop at page 2.
  expect(apiCallCount).toBeGreaterThanOrEqual(2);

  const ads = await getAllAds();
  expect(ads.length).toBeGreaterThanOrEqual(35);
  // Every seeded ad marked is_backfill: true (silent seed contract).
  expect(ads.every((a) => a.is_backfill === true)).toBe(true);
  // CRITICAL: no alerts fired during backfill.
  expect(ads.every((a) => a.is_alerted === false)).toBe(true);

  // Telemetry written.
  const wl = await getWatchlist("wl-bf");
  expect(wl.pending_backfill_days).toBe(0);
  expect(wl.last_backfill_at).toBeGreaterThan(0);
  expect(wl.last_backfill_count).toBeGreaterThan(0);
  expect(wl.last_backfill_days).toBe(60);
  expect(wl.last_backfill_duration).toBeGreaterThanOrEqual(0);

  // Broadcasts: exactly one backfill_start, exactly one backfill_done.
  const msgs = await getMsgs();
  const starts = msgs.filter((m) => m.phase === "backfill_start");
  const dones = msgs.filter((m) => m.phase === "backfill_done");
  expect(starts).toHaveLength(1);
  expect(dones).toHaveLength(1);
  expect(starts[0].days).toBe(60);
  expect(dones[0].count).toBeGreaterThan(0);
});

test("2. cutoff early-exit + out-of-window clipping", async () => {
  await resetState();

  // 30-day backfill. Page 1 ads span days 0-34 — oldest (day 34) already
  // older than cutoff → loop breaks after page 1. Ads outside the 30-day
  // window are clipped from the persisted set.
  apiResponder = (_req, n) => {
    if (n === 1) return { ads: pageOf(1, 35, 0) };
    // Any subsequent call indicates the cutoff didn't fire — fail loudly.
    return { ads: pageOf(1000, 35, 100) };
  };

  await putWatchlist(baseWatchlist({ id: "wl-cut", backfill_days: 30, last_seen_ad_id: null }));
  await forcePoll("wl-cut");
  await extPage.waitForTimeout(300);

  expect(apiCallCount).toBe(1); // cutoff fires → no page 2

  const ads = await getAllAds();
  // All persisted ads within the 30-day window (clipping guarantees this).
  const cutoff = Date.now() - 31 * DAY;
  expect(ads.every((a) => a.created_at >= cutoff)).toBe(true);
});

test("3. re-backfill via pending_backfill_days PRESERVES user flags", async () => {
  await resetState();

  // Pre-existing user-curated ad.
  await putAd({
    id: "42",
    list_id: "wl-rb",
    title: "old",
    price: 999,
    is_flagged: true,
    is_archived: true,
    is_messaged: true,
    is_purchased: true,
    ad_status: "sold",
    notes: "keep-me",
    is_backfill: false,
    is_alerted: true,
    seen_at: Date.now() - 10_000_000,
    created_at: Date.now() - 10_000_000,
  });

  apiResponder = (_req, n) => (n === 1 ? { ads: [mkAd(42, { price: 100 })] } : { ads: [] });

  await putWatchlist(
    baseWatchlist({
      id: "wl-rb",
      pending_backfill_days: 30,
      last_seen_ad_id: "seed", // not first-poll → pending is the trigger
    }),
  );

  await forcePoll("wl-rb");
  await extPage.waitForTimeout(300);

  const ads = await getAllAds();
  const a = ads.find((x) => x.id === "42");
  expect(a).toBeTruthy();
  // User flags preserved.
  expect(a.is_flagged).toBe(true);
  expect(a.is_archived).toBe(true);
  expect(a.is_messaged).toBe(true);
  expect(a.is_purchased).toBe(true);
  expect(a.ad_status).toBe("sold");
  expect(a.notes).toBe("keep-me");
  // Poll-derived fields refreshed.
  expect(a.is_backfill).toBe(true);
  expect(a.price).toBe(100);

  // pending_backfill_days cleared on success.
  const wl = await getWatchlist("wl-rb");
  expect(wl.pending_backfill_days).toBe(0);
});

test("4. page failure after all retries → pending PRESERVED + backfill_error(page_failed)", async () => {
  await resetState();
  const getMsgs = await installBroadcastSpy(extPage);

  // Page 1 succeeds with full 35; page 2+ all calls fail. The retry loop
  // attempts page 2 up to 3 times (1 initial + 2 retries), then breaks.
  apiResponder = (_req, n) => (n === 1 ? { ads: pageOf(1, 35, 0) } : { __abort: true });

  await putWatchlist(
    baseWatchlist({
      id: "wl-pf",
      pending_backfill_days: 60,
      last_seen_ad_id: "seed",
    }),
  );

  await forcePoll("wl-pf");
  await extPage.waitForTimeout(4_000); // retries + linear backoff (1s + 2s)

  // CRITICAL: user's seed request MUST survive — retry on next cycle.
  const wl = await getWatchlist("wl-pf");
  expect(wl.pending_backfill_days).toBe(60);

  // Page-1 ads still persisted (bulk write committed before page-2 failure).
  const ads = await getAllAds();
  expect(ads.length).toBeGreaterThanOrEqual(35);
  expect(ads.every((a) => a.is_backfill === true)).toBe(true);

  // backfill_error broadcast with reason 'page_failed'.
  const msgs = await getMsgs();
  const errs = msgs.filter((m) => m.phase === "backfill_error" && m.reason === "page_failed");
  expect(errs.length).toBeGreaterThanOrEqual(1);
  expect(errs[0].count).toBe(35);
});

test("5. retry recovers on 2nd attempt → pagination continues", async () => {
  await resetState();

  // Page 1 ok. Page 2 first call fails, second call succeeds. Page 3 exhausts.
  const page2State = { attempts: 0 };
  apiResponder = (_req, n) => {
    if (n === 1) return { ads: pageOf(1, 35, 0) };
    if (n === 2) {
      page2State.attempts++;
      return { __abort: true };
    }
    if (n === 3) return { ads: pageOf(100, 35, 35) };
    return { ads: [] };
  };

  await putWatchlist(
    baseWatchlist({
      id: "wl-retry",
      backfill_days: 100,
      last_seen_ad_id: null,
    }),
  );

  await forcePoll("wl-retry");
  await extPage.waitForTimeout(3_500);

  // Retry kicked in (≥1 attempt was spent on the failing call).
  expect(page2State.attempts).toBeGreaterThanOrEqual(1);

  const wl = await getWatchlist("wl-retry");
  expect(wl.pending_backfill_days).toBe(0); // recovered → cleared
  const ads = await getAllAds();
  expect(ads.length).toBeGreaterThanOrEqual(70);
});

test("6. auth 401 mid-backfill → startup-session-check alarm + backfill_error(fetch_error)", async () => {
  await resetState();
  const getMsgs = await installBroadcastSpy(extPage);

  apiResponder = () => ({ __status: 401 });

  await putWatchlist(
    baseWatchlist({
      id: "wl-401",
      pending_backfill_days: 30,
      last_seen_ad_id: "seed",
    }),
  );

  await forcePoll("wl-401");
  await extPage.waitForTimeout(500);

  // Alarm scheduled for session self-heal.
  const alarm = await swEval(env.serviceWorker, () => chrome.alarms.get("startup-session-check"));
  expect(alarm).toBeTruthy();

  // pending preserved (never reached checkpoint).
  const wl = await getWatchlist("wl-401");
  expect(wl.pending_backfill_days).toBe(30);

  const msgs = await getMsgs();
  const errs = msgs.filter((m) => m.phase === "backfill_error" && m.reason === "fetch_error");
  expect(errs.length).toBeGreaterThanOrEqual(1);
  expect(errs[0].message).toMatch(/401/);
});

test("7. zero-result backfill → backfill_done(count=0) + pending cleared", async () => {
  await resetState();
  const getMsgs = await installBroadcastSpy(extPage);

  apiResponder = () => ({ ads: [] });

  await putWatchlist(
    baseWatchlist({
      id: "wl-zero",
      pending_backfill_days: 15,
      last_seen_ad_id: "seed",
    }),
  );

  await forcePoll("wl-zero");
  await extPage.waitForTimeout(300);

  // Zero ads is STILL a successful poll — pending cleared via the
  // "ads.length === 0" branch, and a backfill_done broadcast fires so the
  // popup badge ("📋 Seed en cours…") clears immediately.
  const wl = await getWatchlist("wl-zero");
  expect(wl.pending_backfill_days).toBe(0);

  const msgs = await getMsgs();
  const dones = msgs.filter((m) => m.phase === "backfill_done");
  expect(dones.length).toBeGreaterThanOrEqual(1);
  expect(dones[0].count).toBe(0);
});

test("8. price_history seeded with ≥min(20, days) rows from multi-page prices", async () => {
  await resetState();

  apiResponder = (_req, n) =>
    n === 1
      ? { ads: pageOf(1, 10, 0) } // 10 prices → ≥5 trigger the seed loop
      : { ads: [] };

  await putWatchlist(
    baseWatchlist({
      id: "wl-ph",
      keywords: "unique-kw-price",
      category_id: "30",
      backfill_days: 30,
      last_seen_ad_id: null,
    }),
  );

  await forcePoll("wl-ph");
  await extPage.waitForTimeout(500);

  const rows = (await getPriceHistory()).filter((r) => r.keyword === "unique-kw-price");
  // min(20, backfillDays=30) = 20 points.
  expect(rows.length).toBeGreaterThanOrEqual(20);
  // All share category + sane numeric fields.
  expect(rows.every((r) => r.category_id === "30")).toBe(true);
  expect(rows.every((r) => r.sample_count >= 5)).toBe(true);
  expect(rows.every((r) => r.median_price > 0 && r.min_price <= r.max_price)).toBe(true);
});

test("9. silent seed: zero alerted ads even when criteria would match", async () => {
  await resetState();

  // 5 cheap ads well under budget — any non-seed poll would fire red-tier alerts.
  apiResponder = (_req, n) => (n === 1 ? { ads: pageOf(1, 5, 0).map((a) => ({ ...a, price: [10] })) } : { ads: [] });

  await putWatchlist(
    baseWatchlist({
      id: "wl-silent",
      backfill_days: 10,
      last_seen_ad_id: null,
      budget: 500,
      undermarket_threshold_pct: 99, // would tag red if evaluated
    }),
  );

  await forcePoll("wl-silent");
  await extPage.waitForTimeout(300);

  const ads = await getAllAds();
  expect(ads.length).toBeGreaterThanOrEqual(5);
  const alerted = ads.filter((a) => a.is_alerted === true);
  expect(alerted).toHaveLength(0);
});

test("10. options UI renders pending-backfill indicator while pending_backfill_days > 0", async () => {
  await resetState();

  // Seed watchlist with pending >0 but DON'T trigger a poll — we test the
  // renderer only. The indicator string is the exact one from options.js.
  await putWatchlist(
    baseWatchlist({
      id: "wl-ui",
      name: "UI-test",
      pending_backfill_days: 45,
      last_seen_ad_id: "seed",
    }),
  );

  // Block any poll that SW tries to run while options loads.
  apiResponder = () => ({ __abort: true });

  const options = await openExtensionPage(env.context, env.extensionId, "src/options/options.html");
  await options.waitForSelector(".wl-card__backfill--pending", { timeout: 5_000 });
  const text = await options.textContent(".wl-card__backfill--pending");
  expect(text).toMatch(/Chargement historique 45 derniers jours/);
  await options.close();
});
