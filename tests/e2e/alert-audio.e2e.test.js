// Tier 7 — E2E: Alert pipeline + offscreen audio.

import { test, expect } from "@playwright/test";
import { launchWithExtension, swEval, openExtensionPage, resetStores } from "./helpers/launch-extension.js";
import { E2E_API_SEARCH_MATCH, E2E_WEB_ORIGIN } from "./helpers/domains.js";

test.describe.configure({ mode: "serial" });

let env;
let extPage;
let apiResponder = () => ({ ads: [] });

function mkAd(id, { price = 99 } = {}) {
  const iso = new Date().toISOString();
  return {
    list_id: String(id),
    subject: `Switch OLED ${id}`,
    body: "switch console neuve",
    price: [price],
    index_date: iso,
    first_publication_date: iso,
    category_id: "30",
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
  await lbc.close();

  extPage = await openExtensionPage(env.context, env.extensionId, "src/dashboard/dashboard.html");
});

test.afterAll(async () => {
  await env?.cleanup();
});

// (Re-)install SW spy on notifications.create + runtime.sendMessage.
// Idempotent. MV3 SW may restart between tests — re-install before each use.
async function installSpies() {
  await swEval(env.serviceWorker, () => {
    if (self.__spyInstalled) {
      self.__spy.notifs = [];
      self.__spy.sentMsgs = [];
      return;
    }
    self.__spyInstalled = true;
    self.__spy = { notifs: [], sentMsgs: [] };
    const origCreate = chrome.notifications.create.bind(chrome.notifications);
    chrome.notifications.create = function (id, opts, cb) {
      try {
        const rec = typeof id === "string" ? { id, opts } : { id: "(auto)", opts: id };
        self.__spy.notifs.push(JSON.parse(JSON.stringify(rec)));
      } catch (_) {
        /* non-cloneable */
      }
      return origCreate(id, opts, cb);
    };
    const origSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (msg, ...rest) {
      try {
        self.__spy.sentMsgs.push(JSON.parse(JSON.stringify(msg)));
      } catch (_) {
        /* */
      }
      return origSend(msg, ...rest);
    };
  });
}

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

async function sendToSW(msg) {
  return extPage.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

async function readSpies() {
  const snap = await swEval(env.serviceWorker, () => ({
    notifs: (self.__spy?.notifs || []).slice(),
    sentMsgs: (self.__spy?.sentMsgs || []).slice(),
  }));
  const hasOffscreen = await swEval(env.serviceWorker, async () => {
    try {
      return await chrome.offscreen.hasDocument();
    } catch (_) {
      return false;
    }
  });
  return { ...snap, hasOffscreen };
}

async function resetState() {
  apiResponder = () => ({ ads: [] });
  await resetStores(extPage, ["ads", "watchlists", "price_history", "blacklist", "templates", "purchases"]);
  await extPage.evaluate(() => chrome.storage.local.clear().catch(() => {}));
  await extPage.evaluate(() =>
    chrome.storage.session
      .remove(["alert_count", "lite_purchase_notifs", "full_auto_paused", "is_paused"])
      .catch(() => {}),
  );
  await swEval(env.serviceWorker, async () => {
    try {
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    } catch (_) {
      /* */
    }
  });
  await installSpies();
}

function baseWatchlist(overrides = {}) {
  return {
    id: "wl-alert",
    name: "Alerts",
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

// ── Tests ──────────────────────────────────────────────────────────────

test("alert fires: notification created, PLAY_SOUND dispatched, offscreen doc present, badge persisted", async () => {
  await resetState();
  await putInStore("watchlists", baseWatchlist());
  apiResponder = () => ({ ads: [mkAd("800001")] });

  const res = await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-alert" });
  expect(res?.ok).toBe(true);
  await extPage.waitForTimeout(500);

  const spy = await readSpies();
  const alertNotif = spy.notifs.find((n) => n.id?.startsWith("alert-"));
  expect(alertNotif, "chrome.notifications.create was not called").toBeTruthy();
  expect(alertNotif.opts.title).toMatch(/Nouvelle annonce|DEAL/);

  const playSound = spy.sentMsgs.find((m) => m?.type === "PLAY_SOUND");
  expect(playSound, "MSG.PLAY_SOUND was not dispatched").toBeTruthy();
  expect(["red", "orange"]).toContain(playSound.tier);

  expect(spy.hasOffscreen).toBe(true);

  const stored = await extPage.evaluate(() => chrome.storage.session.get("alert_count"));
  expect(stored.alert_count).toBeGreaterThanOrEqual(1);
});

test("sound_pref=none: no PLAY_SOUND dispatched, no offscreen document created", async () => {
  await resetState();
  await extPage.evaluate(() => chrome.storage.local.set({ sound_pref: "none" }));
  await putInStore("watchlists", baseWatchlist({ id: "wl-silent" }));
  apiResponder = () => ({ ads: [mkAd("800010")] });

  const res = await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-silent" });
  expect(res?.ok).toBe(true);
  await extPage.waitForTimeout(500);

  const spy = await readSpies();
  expect(spy.notifs.some((n) => n.id?.startsWith("alert-"))).toBe(true);
  expect(spy.sentMsgs.some((m) => m?.type === "PLAY_SOUND")).toBe(false);
  expect(spy.hasOffscreen).toBe(false);
});

test("CLEAR_BADGE + DECREMENT_BADGE update persisted alert_count", async () => {
  await resetState();
  await putInStore("watchlists", baseWatchlist({ id: "wl-badge" }));

  apiResponder = () => ({ ads: [mkAd("800100"), mkAd("800101", { price: 105 })] });
  await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-badge" });
  await extPage.waitForTimeout(500);

  let stored = await extPage.evaluate(() => chrome.storage.session.get("alert_count"));
  expect(stored.alert_count).toBeGreaterThanOrEqual(2);

  await sendToSW({ type: "DECREMENT_BADGE" });
  await extPage.waitForTimeout(300);
  stored = await extPage.evaluate(() => chrome.storage.session.get("alert_count"));
  expect(stored.alert_count).toBeGreaterThanOrEqual(1);

  await sendToSW({ type: "CLEAR_BADGE" });
  await extPage.waitForTimeout(300);
  stored = await extPage.evaluate(() => chrome.storage.session.get("alert_count"));
  expect(stored.alert_count).toBe(0);
});
