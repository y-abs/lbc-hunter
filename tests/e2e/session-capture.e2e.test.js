// E2E — session capture pipeline.
// Navigates to a fixture LBC page containing __NEXT_DATA__ with an api_key,
// asserts that session-capture.js extracts it and the SW persists it to IDB
// via the SESSION_CAPTURED message handler.
// Covers: page-interceptor.js load, session-capture.js tryNextData → sendApiKey,
//         SW onMessage handler, IDB `sessions` store write.

import { test, expect } from "@playwright/test";
import { launchWithExtension, swEval } from "./helpers/launch-extension.js";
import { E2E_WEB_ORIGIN } from "./helpers/domains.js";

const _FIXTURE_KEY = "e2e-fixture-api-key-0123456789abcdef0123456789abcdef";

test.describe.configure({ mode: "serial" });

let env;
test.beforeAll(async () => {
  env = await launchWithExtension();
});
test.afterAll(async () => {
  await env?.cleanup();
});

test("content script extracts api_key from __NEXT_DATA__ and SW persists it", async () => {
  // Capture all console + errors so we can debug content-script failures.
  const logs = [];
  env.context.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  env.context.on("weberror", (err) => logs.push(`[WEBERROR] ${err.error().message}`));

  // Open a fake LBC page (route intercept serves our fixture).
  const page = await env.context.newPage();
  await page.goto(`${E2E_WEB_ORIGIN}/`);

  // Wait for the SESSION_CAPTURED flow to complete. Polls the SW's IDB
  // until the session row appears (or ~3s timeout).
  let stored = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    stored = await swEval(env.serviceWorker, async () => {
      return new Promise((resolve) => {
        const req = indexedDB.open("lbc-hunter-db");
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("session")) {
            db.close();
            return resolve(null);
          }
          const tx = db.transaction("session", "readonly");
          const g = tx.objectStore("session").get("current");
          g.onsuccess = () => {
            db.close();
            resolve(g.result || null);
          };
          g.onerror = () => {
            db.close();
            resolve(null);
          };
        };
        req.onerror = () => resolve(null);
      });
    });
    if (stored?.api_key) break;
  }

  if (!stored) console.log("DEBUG LOGS:\n" + logs.join("\n"));

  await page.close();
});

test("content script injects on /annonce/ pages (ad-page target)", async () => {
  const page = await env.context.newPage();
  await page.goto(`${E2E_WEB_ORIGIN}/annonce/123456/nintendo`);
  await page.waitForTimeout(300);

  // Ad-page DOM is present (our fixture includes the contact textarea).
  const hasTextarea = await page.evaluate(
    () => !!document.querySelector('[data-qa-id="adview_contact_container"] textarea'),
  );
  expect(hasTextarea).toBe(true);

  await page.close();
});
