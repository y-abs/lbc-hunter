// E2E smoke — real Chromium + real extension + real IDB + real SW lifecycle.
// Proves: SW starts, IDB writable, dashboard renders, options renders, popup
// renders, alarms API works, offscreen document can be created.

import { test, expect } from "@playwright/test";
import { launchWithExtension, swEval, openExtensionPage } from "./helpers/launch-extension.js";

test.describe.configure({ mode: "serial" });

let env;
test.beforeAll(async () => {
  env = await launchWithExtension();
});
test.afterAll(async () => {
  await env?.cleanup();
});

test("service worker is running with the expected URL", async () => {
  expect(env.serviceWorker.url()).toMatch(/^chrome-extension:\/\/[a-z]+\/background\/service-worker\.js$/);
});

test("IndexedDB is writable from the service worker", async () => {
  const result = await swEval(env.serviceWorker, async () => {
    // Prove real Chrome IDB works inside the extension SW context.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open("e2e-smoke", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => {
        const tx = req.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put("hello", "canary");
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    // And chrome.storage API too
    await chrome.storage.local.set({ __e2e_canary: "hello" });
    const v = await chrome.storage.local.get("__e2e_canary");
    return v.__e2e_canary;
  });
  expect(result).toBe("hello");
});

test("chrome.alarms API is functional", async () => {
  const alarm = await swEval(env.serviceWorker, async () => {
    await chrome.alarms.create("e2e-alarm", { delayInMinutes: 10 });
    return await chrome.alarms.get("e2e-alarm");
  });
  expect(alarm.name).toBe("e2e-alarm");
});

test("dashboard page renders", async () => {
  const page = await openExtensionPage(env.context, env.extensionId, "src/dashboard/dashboard.html");
  // Wait for at least one element from the dashboard shell.
  await expect(page.locator("body")).toBeVisible();
  // Dashboard imports chart.js + idb — if any import fails the page is blank.
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
  await page.close();
});

test("popup page renders", async () => {
  const page = await openExtensionPage(env.context, env.extensionId, "src/popup/popup.html");
  await expect(page.locator("body")).toBeVisible();
  await page.close();
});

test("options page renders", async () => {
  const page = await openExtensionPage(env.context, env.extensionId, "src/options/options.html");
  await expect(page.locator("body")).toBeVisible();
  await page.close();
});

test("offscreen document can be created for audio playback", async () => {
  const ok = await swEval(env.serviceWorker, async () => {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "e2e smoke test",
      });
      const hasDoc = await chrome.offscreen.hasDocument();
      await chrome.offscreen.closeDocument();
      return hasDoc;
    } catch (e) {
      return `error: ${e.message}`;
    }
  });
  expect(ok).toBe(true);
});
