// ─────────────────────────────────────────────
//  Vitest global setup — installs chrome.* mock + fake-indexeddb
//  Loaded BEFORE any `src/…` module import so module-level code
//  (e.g. `const DB = 'lbc-hunter-db'`) sees the mocked globals.
// ─────────────────────────────────────────────

import "fake-indexeddb/auto";
import { beforeEach } from "vitest";
import { installChromeMock, resetChromeMock } from "./chrome-mock.js";
import { webcrypto } from "node:crypto";

if (!global.crypto) {
  global.crypto = webcrypto;
}

installChromeMock();

beforeEach(() => {
  resetChromeMock();
  // IDB reset is the responsibility of tests that use it (via freshIdbModule).
  // Pure unit tests that never touch IDB pay no cost.
});
