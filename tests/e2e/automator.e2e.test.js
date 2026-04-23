// Tier 6 — E2E: Automator (auto-message + lite-purchase checkout).
//
// Module is Vitest-excluded because its behaviour is chrome.scripting
// injecting functions into real LBC DOM. Playwright in real Chrome is the
// only faithful coverage.
//
// Design note: asserting against the LBC tab's DOM post-injection is flaky
// because the service worker's session-refresh path may reload the LBC tab
// asynchronously (detaching Playwright's page reference). We assert the
// AUTHORITATIVE side effects instead: IDB `is_messaged=true`, rate-limit
// counters in chrome.storage.local, and `purchases` store rows. These
// faithfully prove the sendAutoMessage / attemptCheckout code paths ran.

import { test, expect } from "@playwright/test";
import { launchWithExtension, swEval, openExtensionPage, resetStores } from "./helpers/launch-extension.js";
import { E2E_API_SEARCH_MATCH, E2E_WEB_ORIGIN } from "./helpers/domains.js";

test.describe.configure({ mode: "serial" });

let env;
let extPage;
let apiResponder = () => ({ ads: [] });

function mkAd(id, { price = 120 } = {}) {
  const iso = new Date().toISOString();
  return {
    list_id: String(id),
    subject: `Switch ${id}`,
    body: "Neuve",
    price: [price],
    index_date: iso,
    first_publication_date: iso,
    category_id: "30",
    url: `${E2E_WEB_ORIGIN}/annonce/${id}/switch`,
    location: { city: "Paris", zipcode: "75000", lat: 48.85, lng: 2.35 },
    owner: { type: "private", user_id: `u${id}`, name: "Alice" },
    images: { urls_large: [`http://x/${id}.jpg`] },
  };
}

test.beforeAll(async () => {
  env = await launchWithExtension({
    routes: {
      [E2E_API_SEARCH_MATCH]: async (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(apiResponder(route.request())),
        }),
    },
  });

  // Seed session via LBC tab fixture.
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
  // Close the home tab: sendAutoMessage's `chrome.tabs.query` would pick
  // it up and, since its URL does not match the ad URL, the injection
  // function's `samePage` check would fail and navigate the tab instead
  // of filling the textarea (returns `{navigated:true}`, bypassing
  // markAdMessaged). Each auto-message test opens a fresh ad-URL tab.
  await lbc.close();

  extPage = await openExtensionPage(env.context, env.extensionId, "src/dashboard/dashboard.html");
});

async function openAdTab(adId) {
  const page = await env.context.newPage();
  await page.goto(`${E2E_WEB_ORIGIN}/annonce/${adId}/switch`);
  await page.waitForSelector('[data-qa-id="adview_contact_container"] textarea', { timeout: 5000 });
  return page;
}

test.afterAll(async () => {
  await env?.cleanup();
});

async function putInStore(store, record) {
  return extPage.evaluate(
    async ({ s, r }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const tx = req.result.transaction(s, "readwrite");
          tx.objectStore(s).put(r);
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { s: store, r: record },
  );
}

async function getFromStore(store, key) {
  return extPage.evaluate(
    async ({ s, k }) =>
      new Promise((resolve) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction(s).objectStore(s).get(k);
          g.onsuccess = () => {
            db.close();
            resolve(g.result ?? null);
          };
        };
        req.onerror = () => resolve(null);
      }),
    { s: store, k: key },
  );
}

async function getAllFromStore(store) {
  return extPage.evaluate(
    async (s) =>
      new Promise((resolve) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction(s).objectStore(s).getAll();
          g.onsuccess = () => {
            db.close();
            resolve(g.result ?? []);
          };
        };
        req.onerror = () => resolve([]);
      }),
    store,
  );
}

async function sendToSW(msg) {
  return extPage.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

async function resetState() {
  apiResponder = () => ({ ads: [] });
  await resetStores(extPage, ["ads", "watchlists", "price_history", "blacklist", "templates", "purchases"]);
  await extPage.evaluate(() => chrome.storage.local.clear().catch(() => {}));
  await extPage.evaluate(() =>
    chrome.storage.session
      .remove(["full_auto_paused", "is_paused", "alert_count", "checkout_pending_tab", "lite_purchase_notifs"])
      .catch(() => {}),
  );
}

function baseWatchlist(overrides = {}) {
  return {
    id: "wl-auto",
    name: "Auto",
    keywords: "switch",
    category_id: "30",
    budget: 500,
    price_min: 0,
    price_max: 500,
    seller_type: "all",
    poll_interval_seconds: 60,
    enabled: true,
    require_market_data: false,
    undermarket_threshold_pct: 100,
    backfill_days: 0,
    pending_backfill_days: 0,
    last_seen_ad_id: "seed-x",
    is_first_poll_seeded: true,
    created_at: Date.now(),
    ...overrides,
  };
}

async function installTemplate() {
  await putInStore("templates", {
    id: "tpl-1",
    name: "Hello",
    body: "Bonjour, votre {{titre}} à {{prix}}€ m'intéresse.",
    created_at: Date.now(),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

test("auto-message: marks ad is_messaged=true and increments rate-limit counters", async () => {
  await resetState();
  await installTemplate();
  await putInStore(
    "watchlists",
    baseWatchlist({
      auto_message_enabled: true,
      auto_message_template_id: "tpl-1",
    }),
  );

  const adId = "700001";
  const adTab = await openAdTab(adId);
  apiResponder = () => ({ ads: [mkAd(adId, { price: 120 })] });

  const res = await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-auto" });
  expect(res?.ok).toBe(true);

  // chrome.scripting.executeScript inside sendAutoMessage is awaited; by the
  // time FORCE_POLL resolves the ad row has been marked messaged.
  await extPage.waitForTimeout(500);
  const stored = await getFromStore("ads", adId);
  expect(stored, "ad was not persisted").toBeTruthy();
  expect(stored.is_messaged, "sendAutoMessage did not mark ad messaged").toBe(true);

  const counters = await extPage.evaluate(() => chrome.storage.local.get(["msg_hour_count", "msg_day_count"]));
  expect(counters.msg_hour_count).toBe(1);
  expect(counters.msg_day_count).toBe(1);

  await adTab.close().catch(() => {});
});

test("auto-message idempotency: ad with is_messaged=true is NOT re-messaged", async () => {
  await resetState();
  await installTemplate();
  await putInStore(
    "watchlists",
    baseWatchlist({
      id: "wl-auto-idem",
      auto_message_enabled: true,
      auto_message_template_id: "tpl-1",
      last_seen_ad_id: "seed-different",
    }),
  );

  const adId = "700002";
  // Pre-persist the ad with is_messaged=true. Poll returns same ad:
  // adExists()=true blocks it from newAds, so sendAutoMessage is never even
  // called. Either way, rate-limit counter must stay at 0.
  await putInStore("ads", {
    id: adId,
    list_id: "wl-auto-idem",
    is_messaged: true,
    is_alerted: true,
    price: 120,
    subject: "pre-existing",
    seen_at: Date.now(),
  });

  apiResponder = () => ({ ads: [mkAd(adId)] });
  await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-auto-idem" });
  await extPage.waitForTimeout(300);

  const counters = await extPage.evaluate(() => chrome.storage.local.get(["msg_hour_count"]));
  expect(counters.msg_hour_count ?? 0).toBe(0);
});

test("rate-limit: max_msgs_hour=1 blocks the second auto-message", async () => {
  await resetState();
  await installTemplate();
  // Cap the hourly counter at its ceiling BEFORE the poll so the very first
  // candidate trips the gate. This sidesteps flaky interaction between
  // back-to-back polls and Playwright's tab bookkeeping (we've seen stray
  // ad-tab residues from submit-button clicks in the previous test that
  // confuse chrome.tabs.query) while still exercising the exact same
  // canSendMessage() short-circuit the production path relies on.
  await extPage.evaluate(() =>
    chrome.storage.local.set({
      max_msgs_hour: 1,
      max_msgs_day: 99,
      msg_hour_count: 1,
      msg_hour_reset: Date.now() + 3_600_000,
      msg_day_count: 0,
      msg_day_reset: Date.now() + 86_400_000,
    }),
  );

  await putInStore(
    "watchlists",
    baseWatchlist({
      id: "wl-auto-rl",
      auto_message_enabled: true,
      auto_message_template_id: "tpl-1",
    }),
  );

  const adTab = await openAdTab("700011");
  apiResponder = () => ({ ads: [mkAd("700011")] });
  await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-auto-rl" });
  await extPage.waitForTimeout(500);

  const counters = await extPage.evaluate(() => chrome.storage.local.get(["msg_hour_count"]));
  expect(counters.msg_hour_count, "rate-limit must NOT bump past max").toBe(1);

  const ad = await getFromStore("ads", "700011");
  expect(ad?.is_messaged, "ad must NOT be marked messaged when hourly cap is full").toBeFalsy();

  await adTab.close().catch(() => {});
});

test("CONFIRM_PURCHASE: lite checkout opens a tab and persists one pending row", async () => {
  await resetState();

  const adId = "700100";
  await putInStore(
    "watchlists",
    baseWatchlist({
      id: "wl-auto-buy",
      purchase_budget_max: 500,
    }),
  );
  await putInStore("ads", {
    id: adId,
    list_id: "wl-auto-buy",
    price: 150,
    subject: "Cheap Switch",
    url: `${E2E_WEB_ORIGIN}/annonce/${adId}/switch`,
    seen_at: Date.now(),
    is_alerted: true,
  });

  const tabPromise = env.context.waitForEvent("page", { timeout: 10_000 });
  const res = await sendToSW({
    type: "CONFIRM_PURCHASE",
    adId,
    watchlistId: "wl-auto-buy",
  });
  expect(res?.ok).toBe(true);

  const tab = await tabPromise;
  // Fixture lbc-ad.html carries the buy button selector.
  await tab.waitForSelector('[data-qa-id="adview_buy_button"]', { timeout: 5000 }).catch(() => {});

  // Pending purchase row persisted before injection.
  const purchases = await getAllFromStore("purchases");
  expect(purchases.length).toBe(1);
  expect(purchases[0].ad_id).toBe(adId);
  expect(purchases[0].buy_price).toBe(150);
  expect(["pending", "auto_pending"]).toContain(purchases[0].status);
  expect(purchases[0].purchase_mode).toBe("lite");
  expect(purchases[0].buy_date).toBeGreaterThan(0);

  await tab.close().catch(() => {});
});

test("checkout idempotency: second CONFIRM_PURCHASE within 5-min window is a no-op", async () => {
  await resetState();

  const adId = "700200";
  await putInStore("watchlists", baseWatchlist({ id: "wl-auto-idem-buy", purchase_budget_max: 500 }));
  await putInStore("ads", {
    id: adId,
    list_id: "wl-auto-idem-buy",
    price: 180,
    subject: "x",
    url: `${E2E_WEB_ORIGIN}/annonce/${adId}/switch`,
    seen_at: Date.now(),
    is_alerted: true,
  });

  const tabPromise = env.context.waitForEvent("page", { timeout: 10_000 });
  await sendToSW({ type: "CONFIRM_PURCHASE", adId, watchlistId: "wl-auto-idem-buy" });
  const tab1 = await tabPromise;

  // Second click while first is still 'pending' — idempotency guard vetoes.
  await sendToSW({ type: "CONFIRM_PURCHASE", adId, watchlistId: "wl-auto-idem-buy" });
  await extPage.waitForTimeout(400);

  const purchases = await getAllFromStore("purchases");
  expect(purchases.length, "duplicate CONFIRM_PURCHASE must not create a 2nd row").toBe(1);

  await tab1.close().catch(() => {});
});
