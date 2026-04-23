import { vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

// Track the last-issued module so we can close its IDB connection before
// re-importing — otherwise `deleteDatabase` can block if the previous
// test's connection is still open.
let _lastDbModule = null;

function closePrevious() {
  if (_lastDbModule?.__test__?.close) {
    try {
      _lastDbModule.__test__.close();
    } catch {
      /* ignore */
    }
  }
  _lastDbModule = null;
}

function resetIdbFactory() {
  // Swap the global IDB factory for a pristine one. This is the canonical
  // reset mechanism for fake-indexeddb — any lingering connection from the
  // previous test becomes unreachable without a blocking delete round-trip.
  globalThis.indexedDB = new IDBFactory();
}

export async function freshIdbModule() {
  closePrevious();
  resetIdbFactory();
  vi.resetModules();
  const mod = await import("@/db/indexeddb.js");
  _lastDbModule = mod;
  return mod;
}

export async function freshModules(extras = []) {
  closePrevious();
  resetIdbFactory();
  vi.resetModules();
  const db = await import("@/db/indexeddb.js");
  _lastDbModule = db;
  const out = { db };
  for (const path of extras) {
    out[path] = await import(path);
  }
  return out;
}
