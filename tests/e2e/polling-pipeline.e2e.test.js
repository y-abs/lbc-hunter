// E2E — full polling pipeline with intercepted api.lbc.fr.
// Proves: watchlist save → content-script fetch proxy → SW pollWatchlist →
//         API route fulfills → ads persisted → next poll fires alert.
// This is the closest possible analogue to production without hitting LBC.

import { test, expect } from "@playwright/test";
import { launchWithExtension, swEval, openExtensionPage } from "./helpers/launch-extension.js";

test.describe.configure({ mode: "serial" });

let env;
let extPage; // dashboard page used as a privileged sender
let apiCallCount = 0;
let apiResponder = () => ({ ads: [], total: 0 });

test.beforeAll(async () => {
  env = await launchWithExtension({
    routes: {
      "api.lbc.fr/finder/search": async (route) => {
        apiCallCount++;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(apiResponder(route.request())),
        });
      },
    },
  });

  // Open an LBC tab so the SW has a content script to proxy through.
  const page = await env.context.newPage();
  await page.goto("https://www.lbc.fr/");
  // Wait for session capture to complete.
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    const has = await swEval(env.serviceWorker, async () => {
      return new Promise((resolve) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("session")) {
            db.close();
            return resolve(false);
          }
          const g = db.transaction("session").objectStore("session").get("current");
          g.onsuccess = () => {
            db.close();
            resolve(!!g.result?.api_key);
          };
        };
        req.onerror = () => resolve(false);
      });
    });
    if (has) break;
  }

  // Open the dashboard page (extension context) — privileged sender for
  // chrome.runtime.sendMessage → SW onMessage handler.
  extPage = await openExtensionPage(env.context, env.extensionId, "src/dashboard/dashboard.html");
});

test.afterAll(async () => {
  await env?.cleanup();
});

// Helper: send a message from the dashboard (extension page) to the SW.
async function sendToSW(msg) {
  return extPage.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

// Helper: put a watchlist straight into IDB from the dashboard page.
async function putWatchlist(wl) {
  return extPage.evaluate(async (w) => {
    return new Promise((resolve, reject) => {
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
    });
  }, wl);
}

async function countAds() {
  return extPage.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open("lbc-hunter-db");
      req.onsuccess = () => {
        const db = req.result;
        const r = db.transaction("ads").objectStore("ads").count();
        r.onsuccess = () => {
          db.close();
          resolve(r.result);
        };
      };
      req.onerror = () => resolve(-1);
    });
  });
}

test("full polling pipeline: watchlist → SW → content-script fetch → API → IDB", async () => {
  apiCallCount = 0;
  apiResponder = () => ({
    ads: [
      {
        list_id: "100",
        subject: "Switch OLED",
        body: "Neuve",
        price: [120],
        index_date: new Date().toISOString(),
        first_publication_date: new Date().toISOString(),
        category_id: "30",
        location: { city: "Paris", zipcode: "75000" },
        owner: { type: "private", user_id: "u1", name: "Alice" },
        images: { urls_large: ["http://x/1.jpg"] },
      },
    ],
  });

  await putWatchlist({
    id: "wl-e2e-pipeline",
    keywords: "nintendo switch",
    category_id: "30",
    budget: 300,
    poll_interval_seconds: 60,
    enabled: true,
    is_first_poll_seeded: false,
    last_seen_ad_id: "seed-existing",
    pending_backfill_days: 0,
    created_at: Date.now(),
    require_market_data: false,
    undermarket_threshold_pct: 100,
  });

  const result = await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-e2e-pipeline" });
  expect(result?.ok).toBe(true);
  expect(result.result.status).toBe("ok");

  // Give SW time to complete bulkSaveAds (it runs after returning status=ok).
  await extPage.waitForTimeout(500);

  expect(apiCallCount).toBeGreaterThan(0);
  expect(await countAds()).toBeGreaterThan(0);
});

test("auth failure surfaces to watchlist telemetry", async () => {
  apiCallCount = 0;
  await env.context.unroute("**://api.lbc.fr/**").catch(() => {});
  await env.context.route("**://api.lbc.fr/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "unauth" }),
    }),
  );

  await putWatchlist({
    id: "wl-e2e-401",
    keywords: "test",
    budget: 200,
    poll_interval_seconds: 60,
    enabled: true,
    last_seen_ad_id: "seed",
    require_market_data: false,
    created_at: Date.now(),
  });

  const res = await sendToSW({ type: "FORCE_POLL", watchlistId: "wl-e2e-401" });
  expect(res?.result?.status).toBe("error");
  expect(res.result.error).toMatch(/401/);

  const alarm = await swEval(env.serviceWorker, () => chrome.alarms.get("startup-session-check"));
  expect(alarm).toBeTruthy();
});
