// Tier 4 — INTEGRATION: runPollCycle — cycle-level guarantees.
//
// End-user scenarios:
//   • Only enabled watchlists are polled
//   • Interval gate respects poll_interval_seconds (no over-polling)
//   • Pending backfill bypasses the interval gate (user-requested seed)
//   • Module mutex prevents concurrent cycles from the 30s master alarm
//   • Proxy-tab-cleanup alarm is suspended during a cycle, re-armed after

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeWatchlist } from "../helpers/factories.js";
import { installFetchStub, seedLbcTab } from "../helpers/poller-harness.js";

let mods;
beforeEach(async () => {
  mods = await freshModules(["@/core/poller.js"]);
  seedLbcTab();
  await mods.db.saveSession("KEY", "UA/1.0");
  installFetchStub(() => ({ ads: [] }));
});

describe("runPollCycle — watchlist selection", () => {
  it("iterates ONLY enabled watchlists", async () => {
    await mods.db.saveWatchlist(makeWatchlist({ id: "wl-on", enabled: true, require_market_data: false }));
    await mods.db.saveWatchlist(makeWatchlist({ id: "wl-off", enabled: false, require_market_data: false }));

    await mods["@/core/poller.js"].runPollCycle();

    const on = await mods.db.dbGet("watchlists", "wl-on");
    const off = await mods.db.dbGet("watchlists", "wl-off");
    expect(on.last_polled_at).toBeGreaterThan(0);
    expect(off.last_polled_at ?? 0).toBe(0);
  });

  it("no-ops cleanly when there are zero enabled watchlists", async () => {
    await expect(mods["@/core/poller.js"].runPollCycle()).resolves.toBeUndefined();
  });
});

describe("runPollCycle — interval gate", () => {
  it("skips watchlists polled within the interval window", async () => {
    const recent = Date.now() - 5000; // 5s ago
    await mods.db.saveWatchlist(
      makeWatchlist({
        id: "wl-recent",
        enabled: true,
        poll_interval_seconds: 60,
        last_polled_at: recent,
        require_market_data: false,
      }),
    );
    await mods["@/core/poller.js"].runPollCycle();

    const wl = await mods.db.dbGet("watchlists", "wl-recent");
    expect(wl.last_polled_at).toBe(recent); // not re-polled
  });

  it("polls watchlists whose interval has elapsed", async () => {
    const stale = Date.now() - 120_000;
    await mods.db.saveWatchlist(
      makeWatchlist({
        id: "wl-stale",
        enabled: true,
        poll_interval_seconds: 60,
        last_polled_at: stale,
        require_market_data: false,
      }),
    );
    await mods["@/core/poller.js"].runPollCycle();

    const wl = await mods.db.dbGet("watchlists", "wl-stale");
    expect(wl.last_polled_at).toBeGreaterThan(stale);
  });

  it("pending_backfill_days BYPASSES the interval gate (user-requested seed)", async () => {
    const recent = Date.now() - 1000; // well within interval
    await mods.db.saveWatchlist(
      makeWatchlist({
        id: "wl-bf-bypass",
        enabled: true,
        poll_interval_seconds: 3600, // 1h — would block otherwise
        last_polled_at: recent,
        pending_backfill_days: 30,
        require_market_data: false,
      }),
    );

    await mods["@/core/poller.js"].runPollCycle();

    const wl = await mods.db.dbGet("watchlists", "wl-bf-bypass");
    // Cycle ran — last_polled_at advanced past the original.
    expect(wl.last_polled_at).toBeGreaterThan(recent);
  });
});

describe("runPollCycle — concurrency mutex", () => {
  it("a second concurrent call is a no-op (no duplicate API hits)", async () => {
    // Slow each poll so cycle 1 is still running when cycle 2 starts.
    let fetchCount = 0;
    chrome.tabs.sendMessage = vi.fn((_id, msg, cb) => {
      if (msg?.type === "PING") return cb?.({ pong: true });
      if (msg?.type !== "EXECUTE_FETCH") return cb?.({ ok: false, error: "x" });
      fetchCount++;
      setTimeout(() => cb?.({ ok: true, data: { ads: [] } }), 50);
    });

    await mods.db.saveWatchlist(
      makeWatchlist({
        id: "wl-mutex",
        enabled: true,
        require_market_data: false,
      }),
    );

    const [r1, r2] = await Promise.all([
      mods["@/core/poller.js"].runPollCycle(),
      mods["@/core/poller.js"].runPollCycle(),
    ]);

    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    // Exactly one cycle did the work → exactly one fetch.
    expect(fetchCount).toBe(1);
  });

  it("a subsequent cycle runs fine after the previous completes (mutex released)", async () => {
    await mods.db.saveWatchlist(
      makeWatchlist({
        id: "wl-sequential",
        enabled: true,
        require_market_data: false,
      }),
    );

    await mods["@/core/poller.js"].runPollCycle();
    // Force the interval gate open by rewinding last_polled_at.
    const wl = await mods.db.dbGet("watchlists", "wl-sequential");
    await mods.db.saveWatchlist({ ...wl, last_polled_at: Date.now() - 120_000 });

    await mods["@/core/poller.js"].runPollCycle();
    const after = await mods.db.dbGet("watchlists", "wl-sequential");
    expect(after.last_polled_at).toBeGreaterThan(wl.last_polled_at);
  });
});

describe("runPollCycle — proxy-tab cleanup alarm", () => {
  it("clears the cleanup alarm at cycle start", async () => {
    const clearSpy = vi.spyOn(chrome.alarms, "clear");
    await mods.db.saveWatchlist(
      makeWatchlist({
        id: "wl-alarm",
        enabled: true,
        require_market_data: false,
      }),
    );
    await mods["@/core/poller.js"].runPollCycle();

    expect(clearSpy).toHaveBeenCalledWith("proxy-poll-tab-cleanup");
  });
});

describe("pollWatchlist — burst alert protection", () => {
  it("caps per-poll individual notifications under alert storms", async () => {
    const wl = makeWatchlist({
      id: "wl-burst",
      enabled: true,
      require_market_data: false,
      backfill_days: 0,
      pending_backfill_days: 0,
      last_seen_ad_id: "anchor-not-in-page",
    });
    await mods.db.saveWatchlist(wl);

    const nowIso = new Date().toISOString();
    installFetchStub(() => ({
      ads: Array.from({ length: 120 }, (_, i) => ({
        list_id: `burst-${i}`,
        subject: `Burst ad ${i}`,
        first_publication_date: nowIso,
        price: [150 + i],
        category_id: "30",
        owner: { type: "private", user_id: `seller-${i}` },
        location: { lat: 48.85, lng: 2.35, city: "Paris", zipcode: "75000" },
        images: { urls_large: [] },
      })),
    }));

    const notifSpy = vi.spyOn(chrome.notifications, "create");

    await mods["@/core/poller.js"].pollWatchlist(wl);

    // Under burst load, poller must cap individual push notifications.
    // Expected ceiling is enforced in poller.js constants.
    expect(notifSpy).toHaveBeenCalledTimes(10);
  });
});
