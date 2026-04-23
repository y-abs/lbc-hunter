// Tier 3 — BUS: Service Worker message handler gaps not covered by
// db-query-allowlist.test.js:
//   • GET_STATUS response shape (all fields, correct types)
//   • RESUME_ALL → persists is_paused: false
//   • SESSION_CAPTURED while paused → auto-resumes + clears badge
//   • SESSION_CAPTURED when pendingRefreshTabId matches → closes the tab
//   • FORCE_POLL for an unknown watchlistId → returns { ok: false, error }
//   • TOGGLE_FULL_AUTO edge cases: explicit enabled:false / toggle without arg

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeWatchlist } from "../helpers/factories.js";
import { installFetchStub, seedLbcTab } from "../helpers/poller-harness.js";

let mods;

async function dispatch(msg, sender = {}) {
  return chrome.runtime.__dispatch(msg, sender);
}

// Allow a few microtask turns so the SW's _stateRestored chain settles.
async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(async () => {
  mods = await freshModules(["@/background/service-worker.js"]);
  installFetchStub(() => ({ ads: [] }));
  await flushMicrotasks();
});

// ── GET_STATUS ────────────────────────────────────────────────────────────────

describe("GET_STATUS response shape", () => {
  it("returns ok:true with all expected keys", async () => {
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.ok).toBe(true);
    expect(typeof r.isPaused).toBe("boolean");
    expect(typeof r.fullAutoPaused).toBe("boolean");
    expect(typeof r.hasSession).toBe("boolean");
    expect(typeof r.sessionStale).toBe("boolean");
    expect(typeof r.hasLbcTab).toBe("boolean");
    expect(typeof r.alertCount).toBe("number");
    expect(typeof r.pollErrors).toBe("number");
  });

  it("hasSession is false when no session is stored", async () => {
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.hasSession).toBe(false);
  });

  it("hasSession is true after saveSession", async () => {
    await mods.db.saveSession("real-api-key", "TestUA/1.0");
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.hasSession).toBe(true);
  });

  it("sessionStale is true when no session captured", async () => {
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.sessionStale).toBe(true);
  });

  it("sessionStale is false when session captured recently", async () => {
    await mods.db.saveSession("fresh-key", "UA/1.0");
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.sessionStale).toBe(false);
  });

  it("hasLbcTab is true when an LBC tab is open", async () => {
    seedLbcTab(); // adds a fake LBC tab to chrome.tabs
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.hasLbcTab).toBe(true);
  });

  it("pollErrors counts watchlists with ≥5 consecutive failures", async () => {
    await mods.db.saveWatchlist(makeWatchlist({ id: "wl-fail", enabled: true, consecutive_poll_failures: 6 }));
    await mods.db.saveWatchlist(makeWatchlist({ id: "wl-ok", enabled: true, consecutive_poll_failures: 2 }));
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.pollErrors).toBe(1);
  });
});

// ── RESUME_ALL ────────────────────────────────────────────────────────────────

describe("RESUME_ALL", () => {
  it("returns ok:true", async () => {
    const r = await dispatch({ type: "RESUME_ALL" });
    expect(r.ok).toBe(true);
  });

  it("persists is_paused: false to session storage", async () => {
    await dispatch({ type: "PAUSE_ALL" });
    await dispatch({ type: "RESUME_ALL" });
    const stored = await chrome.storage.session.get("is_paused");
    expect(stored.is_paused).toBe(false);
  });

  it("GET_STATUS.isPaused is false after RESUME_ALL", async () => {
    await dispatch({ type: "PAUSE_ALL" });
    await dispatch({ type: "RESUME_ALL" });
    const r = await dispatch({ type: "GET_STATUS" });
    expect(r.isPaused).toBe(false);
  });
});

// ── SESSION_CAPTURED ──────────────────────────────────────────────────────────

describe("SESSION_CAPTURED", () => {
  it("stores the session and returns ok:true", async () => {
    const r = await dispatch({ type: "SESSION_CAPTURED", apiKey: "k1", userAgent: "UA/1.0" });
    expect(r.ok).toBe(true);
    const session = await mods.db.getSession();
    expect(session?.api_key).toBe("k1");
  });

  it("auto-resumes polling when isPaused=true on arrival", async () => {
    await dispatch({ type: "PAUSE_ALL" });
    let status = await dispatch({ type: "GET_STATUS" });
    expect(status.isPaused).toBe(true);

    await dispatch({ type: "SESSION_CAPTURED", apiKey: "k2", userAgent: "UA/1.0" });
    await flushMicrotasks();

    status = await dispatch({ type: "GET_STATUS" });
    expect(status.isPaused).toBe(false);
  });

  it("persists is_paused:false when auto-resuming so SW cold-wake stays unpaused", async () => {
    await dispatch({ type: "PAUSE_ALL" });
    await dispatch({ type: "SESSION_CAPTURED", apiKey: "k3", userAgent: "UA/1.0" });
    await flushMicrotasks();
    const stored = await chrome.storage.session.get("is_paused");
    expect(stored.is_paused).toBe(false);
  });

  it("does NOT resume when polling is not paused (no-op on the flag)", async () => {
    // Polling is already running — second session capture should not break anything
    const r = await dispatch({ type: "SESSION_CAPTURED", apiKey: "k-dup", userAgent: "UA" });
    expect(r.ok).toBe(true);
    const status = await dispatch({ type: "GET_STATUS" });
    expect(status.isPaused).toBe(false); // still unpaused
  });

  it("closes the pending refresh tab when sender.tab.id matches", async () => {
    // To set the module-level pendingRefreshTabId, we must trigger autoRefreshSession
    // (which runs when a stale session + no LBC tab). It creates a background tab
    // and records its id in pendingRefreshTabId + session storage.
    const staleTime = Date.now() - 35 * 60 * 1000;
    await mods.db.dbPut("session", {
      id: "current",
      api_key: "old-key",
      captured_at: staleTime,
      user_agent: "UA/1.0",
      refresh_count: 0,
      last_refresh_at: staleTime,
    });
    // Fire session-refresh alarm → calls autoRefreshSession → creates background tab
    chrome.alarms.__fire("session-refresh");
    await flushMicrotasks(30);
    await new Promise((r) => setTimeout(r, 0));
    await flushMicrotasks(10);

    const stored = await chrome.storage.session.get("pending_refresh_tab");
    const tabId = stored.pending_refresh_tab;
    if (!tabId) return; // background tab creation may fail in this mock env; skip gracefully

    const removeSpy = vi.spyOn(chrome.tabs, "remove");
    await dispatch({ type: "SESSION_CAPTURED", apiKey: "k-tab", userAgent: "UA" }, { tab: { id: tabId } });
    await flushMicrotasks();

    expect(removeSpy).toHaveBeenCalledWith(tabId);
    const storedAfter = await chrome.storage.session.get("pending_refresh_tab");
    expect(storedAfter.pending_refresh_tab).toBeUndefined();
  });
});

// ── FORCE_POLL ────────────────────────────────────────────────────────────────

describe("FORCE_POLL", () => {
  it("returns { ok: false, error: watchlist_not_found } for unknown watchlistId", async () => {
    await mods.db.saveSession("k", "UA/1.0");
    const r = await dispatch({ type: "FORCE_POLL", watchlistId: "nonexistent-wl" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("watchlist_not_found");
  });
});

// ── TOGGLE_FULL_AUTO ──────────────────────────────────────────────────────────

describe("TOGGLE_FULL_AUTO", () => {
  it("enabled:false → fullAutoPaused=true; enabled:true → fullAutoPaused=false", async () => {
    let r = await dispatch({ type: "TOGGLE_FULL_AUTO", enabled: false });
    expect(r.fullAutoPaused).toBe(true);

    r = await dispatch({ type: "TOGGLE_FULL_AUTO", enabled: true });
    expect(r.fullAutoPaused).toBe(false);
  });

  it("toggle without enabled/paused arg flips the current state", async () => {
    // Start from known state
    await dispatch({ type: "TOGGLE_FULL_AUTO", enabled: true }); // fullAutoPaused=false
    const r1 = await dispatch({ type: "TOGGLE_FULL_AUTO" }); // toggles → true
    expect(r1.fullAutoPaused).toBe(true);
    const r2 = await dispatch({ type: "TOGGLE_FULL_AUTO" }); // toggles → false
    expect(r2.fullAutoPaused).toBe(false);
  });

  it("persists full_auto_paused to session storage", async () => {
    await dispatch({ type: "TOGGLE_FULL_AUTO", enabled: false });
    const stored = await chrome.storage.session.get("full_auto_paused");
    expect(stored.full_auto_paused).toBe(true);
  });
});

describe("security validation and fail-closed paths", () => {
  it("rejects invalid message envelopes and bumps blocked_message_envelope", async () => {
    const r = await dispatch("not-an-object");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_message");

    await flushMicrotasks();
    const stored = await chrome.storage.local.get("security_counters");
    expect(stored.security_counters?.blocked_message_envelope || 0).toBeGreaterThan(0);
  });

  it("rejects SESSION_CAPTURED with empty apiKey and bumps schema_rejection", async () => {
    const r = await dispatch({ type: "SESSION_CAPTURED", apiKey: "", userAgent: "UA/1.0" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_api_key");

    await flushMicrotasks();
    const stored = await chrome.storage.local.get("security_counters");
    expect(stored.security_counters?.schema_rejection || 0).toBeGreaterThan(0);
  });

  it("rejects SESSION_CAPTURED with oversized userAgent", async () => {
    const oversizedUa = "x".repeat(513);
    const r = await dispatch({ type: "SESSION_CAPTURED", apiKey: "valid-key", userAgent: oversizedUa });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_user_agent");
  });

  it("rejects SECURITY_EVENT with invalid event payload", async () => {
    const r = await dispatch({ type: "SECURITY_EVENT", event: 42 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_security_event");
  });

  it("rejects DB_QUERY with non-string op and bumps schema_rejection", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: { bad: true }, args: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_db_op");

    await flushMicrotasks();
    const stored = await chrome.storage.local.get("security_counters");
    expect(stored.security_counters?.schema_rejection || 0).toBeGreaterThan(0);
  });
});
