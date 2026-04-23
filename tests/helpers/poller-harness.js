// Tier 4 — Shared test utilities for poller integration tests.
// Factorised to avoid duplicating the fetch-stub + LBC-tab-seed scaffolding
// across every poll-path test file.

import { vi } from "vitest";

/**
 * Build a synthetic LBC API ad payload. Only the fields poll_watchlist
 * reads are populated; extra fields are preserved via spread.
 */
export function mkApiAd(overrides = {}) {
  const id = overrides.list_id ?? overrides.id ?? String(Math.floor(Math.random() * 1e9));
  const ts = overrides.first_publication_date ?? overrides.index_date ?? new Date().toISOString();
  return {
    list_id: id,
    id,
    subject: "Test Ad",
    body: "Description",
    price: [100],
    index_date: ts,
    first_publication_date: ts,
    category_id: "30",
    location: { lat: 48.85, lng: 2.35, city: "Paris", zipcode: "75000" },
    owner: { type: "private", user_id: "user-" + id, name: "X" },
    images: { urls_large: ["http://x/img.jpg"] },
    ...overrides,
  };
}

/**
 * Stub EXECUTE_FETCH + PING on chrome.tabs.sendMessage.
 *   mode = 'success' | 'auth-401' | 'auth-403' | 'network' | 'timeout'
 *   responseFactory(msg) returns the `data` payload when mode is 'success'.
 */
export function installFetchStub(responseFactory, { mode = "success", fail = null } = {}) {
  let callCount = 0;
  const errCb = (cb, err) => cb?.({ ok: false, error: err });
  chrome.tabs.sendMessage = vi.fn((_tabId, msg, cb) => {
    if (msg?.type === "PING") return cb?.({ pong: true });
    if (msg?.type !== "EXECUTE_FETCH") return cb?.({ ok: false, error: "unknown" });
    callCount++;
    // Per-call failure override wins over `mode`.
    const effective = fail?.(callCount, msg) ?? mode;
    switch (effective) {
      case "success":
        return cb?.({ ok: true, data: responseFactory(msg, callCount) });
      case "auth-401":
        return errCb(cb, "HTTP 401");
      case "auth-403":
        return errCb(cb, "HTTP 403");
      case "network":
        return errCb(cb, "Failed to fetch");
      case "timeout":
        return; // never call cb — FETCH_TIMEOUT after 20s
      default:
        return errCb(cb, "unknown mode");
    }
  });
}

/** Inject a fully-loaded, non-discarded LBC tab so _getPollTabId Step 1 succeeds. */
export function seedLbcTab() {
  chrome.tabs._list.set(1, {
    id: 1,
    url: "https://www.lbc.fr/",
    status: "complete",
    active: true,
    discarded: false,
    lastAccessed: Date.now(),
  });
  chrome.tabs._nextId = 2;
}

/** Remove all LBC tabs; disables the happy path for _getPollTabId Step 1. */
export function removeAllLbcTabs() {
  chrome.tabs._list.clear();
  chrome.tabs._nextId = 1;
}
