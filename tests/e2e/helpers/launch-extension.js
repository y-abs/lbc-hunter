// Playwright E2E harness — loads the BUILT extension (dist/) into a real
// Chromium instance with a persistent context. All api.lbc.fr traffic
// is intercepted and served by the fixture server — zero real LBC hits.

import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../../..");
const DIST = path.join(ROOT, "dist");

/**
 * Launch Chromium with the built extension loaded.
 * Returns { context, extensionId, serviceWorker, cleanup }.
 */
export async function launchWithExtension({ routes = {} } = {}) {
  if (!fs.existsSync(DIST)) {
    throw new Error(`dist/ missing — run 'npm run build' before e2e tests.`);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lbc-hunter-e2e-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // MV3 extensions do not load in headless
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 800 },
  });

  // Wait for the SW to register. MV3 exposes service workers as context.serviceWorkers().
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  const extensionId = serviceWorker.url().split("/")[2];

  // Route ALL api.lbc.fr traffic. Default = 200 empty ads.
  await context.route("**://api.lbc.fr/**", async (route) => {
    const url = route.request().url();
    const handler = Object.entries(routes).find(([pattern]) => url.includes(pattern));
    if (handler) return handler[1](route);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ads: [], total: 0 }),
    });
  });

  // Route www.lbc.fr HTML pages to local fixtures so content scripts
  // inject against realistic markup without touching the real site.
  const FIX = path.join(__dirname, "..", "fixtures");
  await context.route("**://www.lbc.fr/**", async (route) => {
    const url = new URL(route.request().url());
    let file;
    if (url.pathname.startsWith("/annonce/") || url.pathname.startsWith("/ad/")) {
      file = path.join(FIX, "lbc-ad.html");
    } else {
      file = path.join(FIX, "lbc-home.html");
    }
    if (fs.existsSync(file)) {
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: fs.readFileSync(file, "utf8"),
      });
    }
    return route.fulfill({ status: 404, body: "" });
  });

  const cleanup = async () => {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };

  return { context, extensionId, serviceWorker, cleanup };
}

/** Evaluate code in the service-worker context (extension runtime). */
export async function swEval(serviceWorker, fn, ...args) {
  return serviceWorker.evaluate(fn, ...args);
}

/** Open an extension page (dashboard, popup, options) and return the Page. */
export async function openExtensionPage(context, extensionId, relPath) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${relPath}`);
  return page;
}

/**
 * Install a broadcast spy on an extension page. Captures every message
 * received via chrome.runtime.onMessage. Returns an async getter.
 * Usage: const getMsgs = await installBroadcastSpy(page); ...; const msgs = await getMsgs();
 */
export async function installBroadcastSpy(page) {
  await page.evaluate(() => {
    window.__bcMsgs = [];
    chrome.runtime.onMessage.addListener((msg) => {
      try {
        window.__bcMsgs.push(JSON.parse(JSON.stringify(msg)));
      } catch (_) {
        /* non-cloneable */
      }
    });
  });
  return () => page.evaluate(() => window.__bcMsgs.slice());
}

/**
 * Wipe named IDB stores. Keeps `session` untouched so the api_key
 * captured from the LBC tab survives test-to-test.
 */
export async function resetStores(page, storeNames) {
  return page.evaluate(async (stores) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("lbc-hunter-db");
      req.onsuccess = () => {
        const db = req.result;
        const available = stores.filter((s) => db.objectStoreNames.contains(s));
        if (!available.length) {
          db.close();
          return resolve();
        }
        const tx = db.transaction(available, "readwrite");
        for (const s of available) tx.objectStore(s).clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, storeNames);
}
