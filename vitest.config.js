import { defineConfig } from "vitest/config";
import path from "node:path";
import { webcrypto } from "node:crypto";

// Polyfill for crypto.getRandomValues
if (!global.crypto) {
  global.crypto = webcrypto;
}

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/helpers/setup.js"],
    include: ["tests/**/*.test.js"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/core/**", "src/db/**", "src/shared/**"],
      exclude: [
        "src/shared/demo-data.js",
        "src/db/content-db-proxy.js", // covered via bus tests w/ chrome mock
        // automator.js drives chrome.scripting.executeScript + chrome.tabs.sendMessage
        // round-trips into the LBC ad-page DOM (pay/message forms). Meaningful
        // coverage requires an e2e harness (Playwright with the extension
        // loaded); mocking the DOM + executeScript responses in unit tests
        // would verify only the mocks, not the production behaviour. Excluded
        // from unit-coverage gates rather than inflating the %.
        "src/core/automator.js",
      ],
      thresholds: {
        // Thresholds locked against the 4-tier pyramid + deep poller e2e suite
        // (223 tests across unit / idb / bus / integration):
        //   • matcher.js, reporter.js                  → 100% lines
        //   • pricer.js                                → 95%+ lines
        //   • poller.js                                → 93%+ lines (first-poll
        //     seed, incremental alerts, no_tab/auth/network errors, backfill
        //     pagination, inflight coalescing, stale-snapshot recovery,
        //     runPollCycle mutex + interval gate + backfill bypass)
        //   • indexeddb.js                             → 85%+ lines
        //   • shared/utils.js                          → 96%+ lines
        //   • notifier.js                              → ~72% (badge + lite
        //     notifs mutex; fireAlert content rendering partially — the
        //     remainder is Chrome notifications API driven by offscreen doc)
        "src/core/**": { lines: 85, branches: 65, functions: 80 },
        "src/db/**": { lines: 85, branches: 85, functions: 68 },
        "src/shared/**": { lines: 95, branches: 89, functions: 90 },
      },
    },
  },
});
