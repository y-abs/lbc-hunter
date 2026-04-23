// Tier 4 — INTEGRATION: pollWatchlist ERROR PATHS.
// End-user scenarios:
//   • No LBC tab open → alert surfaced, backfill preserved, retry next cycle
//   • Auth failure (401/403) → session-refresh alarm scheduled (self-healing)
//   • Transient network error → failure counter bumps, telemetry recorded
//   • Zero ads returned → last_polled_at updated, pending_backfill cleared
//   • Ghost / disabled / deleted-mid-poll guards

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeWatchlist } from "../helpers/factories.js";
import { installFetchStub, seedLbcTab, removeAllLbcTabs, mkApiAd } from "../helpers/poller-harness.js";

let mods;
beforeEach(async () => {
  mods = await freshModules(["@/core/poller.js"]);
  await mods.db.saveSession("KEY", "UA/1.0");
});

describe("pollWatchlist — NO_LBC_TAB", () => {
  // Force the proxy-tab path AND make its PING fail so the real NO_LBC_TAB
  // branch fires (vs. a generic fetch error from tabs.create rejection).
  function forceNoLbcTab() {
    removeAllLbcTabs();
    // Default chrome.tabs.sendMessage never invokes the callback, which would
    // force the test to wait for _pingTab's 2000ms timeout 3× over. Respond
    // synchronously with `pong: false` so ping fails fast (≤1ms).
    chrome.tabs.sendMessage = vi.fn((_id, _msg, cb) => cb?.({ pong: false }));
  }

  it('returns status:"no_tab" and bumps consecutive_poll_failures', async () => {
    forceNoLbcTab();
    const wl = makeWatchlist({ id: "wl-no-tab" });
    await mods.db.saveWatchlist(wl);

    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("no_tab");

    const saved = (await mods.db.getWatchlists())[0];
    expect(saved.consecutive_poll_failures).toBe(1);
    expect(saved.last_poll_error?.message).toBe("NO_LBC_TAB");
    expect(saved.last_poll_attempt_at).toBeGreaterThan(0);
  });

  it("broadcasts backfill_error when a backfill is pending (user sees why seed is stuck)", async () => {
    forceNoLbcTab();
    const wl = makeWatchlist({
      id: "wl-bf-stuck",
      pending_backfill_days: 30,
    });
    await mods.db.saveWatchlist(wl);

    const msgSpy = vi.spyOn(chrome.runtime, "sendMessage");
    await mods["@/core/poller.js"].pollWatchlist(wl);

    const bfErr = msgSpy.mock.calls.find((c) => c[0]?.phase === "backfill_error");
    expect(bfErr).toBeTruthy();
    expect(bfErr[0].reason).toBe("no_tab");
    expect(bfErr[0].days).toBe(30);
    expect(bfErr[0].message).toMatch(/aucun onglet/i);
  });
});

describe("pollWatchlist — auth failure (401/403)", () => {
  it("schedules startup-session-check alarm so the user is not stuck", async () => {
    seedLbcTab();
    installFetchStub(() => ({ ads: [] }), { mode: "auth-401" });
    const wl = makeWatchlist({ id: "wl-401" });
    await mods.db.saveWatchlist(wl);

    const alarmSpy = vi.spyOn(chrome.alarms, "create");
    const result = await mods["@/core/poller.js"].pollWatchlist(wl);

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/401/);
    expect(alarmSpy).toHaveBeenCalledWith(
      "startup-session-check",
      expect.objectContaining({ delayInMinutes: expect.any(Number) }),
    );
  });

  it("also fires the refresh alarm on HTTP 403 (revoked key)", async () => {
    seedLbcTab();
    installFetchStub(() => ({ ads: [] }), { mode: "auth-403" });
    const wl = makeWatchlist({ id: "wl-403" });
    await mods.db.saveWatchlist(wl);

    const alarmSpy = vi.spyOn(chrome.alarms, "create");
    await mods["@/core/poller.js"].pollWatchlist(wl);

    expect(alarmSpy).toHaveBeenCalledWith("startup-session-check", expect.any(Object));
  });

  it("bumps failure counter and records the error in telemetry", async () => {
    seedLbcTab();
    installFetchStub(() => ({ ads: [] }), { mode: "auth-401" });
    const wl = makeWatchlist({ id: "wl-401-tel", consecutive_poll_failures: 2 });
    await mods.db.saveWatchlist(wl);

    await mods["@/core/poller.js"].pollWatchlist(wl);

    const saved = (await mods.db.getWatchlists())[0];
    expect(saved.consecutive_poll_failures).toBe(3);
    expect(saved.last_poll_error?.message).toMatch(/401/);
    // Success timestamp untouched — this was a failure
    expect(saved.last_successful_poll_at).toBeFalsy();
  });
});

describe("pollWatchlist — generic fetch error", () => {
  it('returns status:"error" and records telemetry, preserves last_seen_ad_id', async () => {
    seedLbcTab();
    installFetchStub(() => ({ ads: [] }), { mode: "network" });
    const wl = makeWatchlist({ id: "wl-net", last_seen_ad_id: "a99" });
    await mods.db.saveWatchlist(wl);

    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/Failed to fetch/);

    const saved = (await mods.db.getWatchlists())[0];
    // CRITICAL: last_seen_ad_id MUST survive a failed poll — otherwise a flaky
    // network would silently re-seed and re-alert every previously-seen ad.
    expect(saved.last_seen_ad_id).toBe("a99");
    expect(saved.consecutive_poll_failures).toBe(1);
  });
});

describe("pollWatchlist — zero-result poll", () => {
  it("updates last_polled_at, resets failures, and does not crash", async () => {
    seedLbcTab();
    installFetchStub(() => ({ ads: [] }));
    const wl = makeWatchlist({ id: "wl-empty", consecutive_poll_failures: 5 });
    await mods.db.saveWatchlist(wl);

    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("ok");
    expect(result.newCount).toBe(0);

    const saved = (await mods.db.getWatchlists())[0];
    expect(saved.last_polled_at).toBeGreaterThan(0);
    expect(saved.last_successful_poll_at).toBeGreaterThan(0);
    expect(saved.consecutive_poll_failures).toBe(0);
    expect(saved.last_poll_error).toBeNull();
  });

  it("clears pending_backfill_days even when LBC returns 0 ads (no stuck seed)", async () => {
    seedLbcTab();
    installFetchStub(() => ({ ads: [] }));
    const wl = makeWatchlist({ id: "wl-empty-bf", pending_backfill_days: 30 });
    await mods.db.saveWatchlist(wl);

    const msgSpy = vi.spyOn(chrome.runtime, "sendMessage");
    await mods["@/core/poller.js"].pollWatchlist(wl);

    const saved = (await mods.db.getWatchlists())[0];
    expect(saved.pending_backfill_days).toBe(0);
    // UI must be told the backfill "completed" (with 0 ads) or the Seed badge
    // sticks forever on narrow-search watchlists.
    const done = msgSpy.mock.calls.find((c) => c[0]?.phase === "backfill_done");
    expect(done).toBeTruthy();
  });
});

describe("pollWatchlist — ghost watchlist guards", () => {
  it('status:"deleted" when the watchlist no longer exists (snapshot is stale)', async () => {
    seedLbcTab();
    // Pass the poller a snapshot that was saved, then deleted before poll runs.
    const wl = makeWatchlist({ id: "wl-ghost" });
    await mods.db.saveWatchlist(wl);
    await mods.db.deleteWatchlist("wl-ghost");

    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("deleted");
    // No resurrection: the watchlist must stay deleted.
    expect(await mods.db.dbGet("watchlists", "wl-ghost")).toBeUndefined();
  });

  it('status:"disabled" when the watchlist was toggled off mid-cycle', async () => {
    seedLbcTab();
    const wl = makeWatchlist({ id: "wl-dis", enabled: true });
    await mods.db.saveWatchlist(wl);
    // User toggled off after runPollCycle read the snapshot.
    await mods.db.saveWatchlist({ ...wl, enabled: false });

    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("disabled");
  });
});

describe("pollWatchlist — inflight coalescing", () => {
  it("FORCE_POLL + master-poll concurrent calls trigger ONE fetch (no duplicate API hits)", async () => {
    seedLbcTab();
    let fetches = 0;
    // Slow stub: await microtasks so both callers see the inflight promise.
    chrome.tabs.sendMessage = vi.fn((_id, msg, cb) => {
      if (msg?.type === "PING") return cb?.({ pong: true });
      if (msg?.type !== "EXECUTE_FETCH") return cb?.({ ok: false, error: "x" });
      fetches++;
      // Delay response so both callers race
      setTimeout(() => cb?.({ ok: true, data: { ads: [mkApiAd({ list_id: "a1" })] } }), 30);
    });
    const wl = makeWatchlist({ id: "wl-race", require_market_data: false });
    await mods.db.saveWatchlist(wl);

    const [r1, r2] = await Promise.all([
      mods["@/core/poller.js"].pollWatchlist(wl),
      mods["@/core/poller.js"].pollWatchlist(wl),
    ]);

    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    expect(fetches).toBe(1); // coalesced — single LBC API call
  });
});

describe("pollWatchlist — stale snapshot, user edits survive", () => {
  it("re-reads the watchlist at end-of-poll so user edits during fetch are not clobbered", async () => {
    seedLbcTab();
    // Slow fetch gives us a window to edit the watchlist mid-poll
    chrome.tabs.sendMessage = vi.fn((_id, msg, cb) => {
      if (msg?.type === "PING") return cb?.({ pong: true });
      if (msg?.type !== "EXECUTE_FETCH") return cb?.({ ok: false, error: "x" });
      // While the fetch is outstanding, simulate the user editing keywords.
      setTimeout(async () => {
        const cur = await mods.db.dbGet("watchlists", "wl-edit");
        await mods.db.saveWatchlist({ ...cur, keywords: "edited-mid-poll", budget: 999 });
        cb?.({ ok: true, data: { ads: [] } });
      }, 20);
    });

    const wl = makeWatchlist({ id: "wl-edit", keywords: "original" });
    await mods.db.saveWatchlist(wl);

    await mods["@/core/poller.js"].pollWatchlist(wl);

    const saved = (await mods.db.getWatchlists())[0];
    // User edit MUST survive — poll-derived fields merge on latest.
    expect(saved.keywords).toBe("edited-mid-poll");
    expect(saved.budget).toBe(999);
    // Runtime telemetry still applied
    expect(saved.last_polled_at).toBeGreaterThan(0);
  });

  it("deletion-during-poll → end-of-poll save is skipped (no resurrection)", async () => {
    seedLbcTab();
    chrome.tabs.sendMessage = vi.fn((_id, msg, cb) => {
      if (msg?.type === "PING") return cb?.({ pong: true });
      if (msg?.type !== "EXECUTE_FETCH") return cb?.({ ok: false, error: "x" });
      setTimeout(async () => {
        await mods.db.deleteWatchlist("wl-kill");
        cb?.({ ok: true, data: { ads: [mkApiAd({ list_id: "a1" })] } });
      }, 20);
    });

    const wl = makeWatchlist({ id: "wl-kill", last_seen_ad_id: "old", require_market_data: false });
    await mods.db.saveWatchlist(wl);

    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("ok");
    // Deleted watchlist MUST stay deleted.
    expect(await mods.db.dbGet("watchlists", "wl-kill")).toBeUndefined();
  });
});
