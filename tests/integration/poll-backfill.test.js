// Tier 4 — INTEGRATION: pollWatchlist BACKFILL branch.
// End-user scenarios:
//   • Multi-page pagination — loops until API exhausted or cutoff reached
//   • Atomic bulk persist — all pages committed in a single IDB tx
//   • pending_backfill_days cleared on success
//   • Page failure → pending_backfill_days preserved for retry
//   • backfill_start / backfill_done / backfill_error broadcast
//   • Re-backfill preserves user flags on re-fetched ads
//   • Price-history seeded with multi-page prices, not just page-1
//   • Backfill does NOT alert (silent seed) — no notifications fired

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeWatchlist } from "../helpers/factories.js";
import { installFetchStub, seedLbcTab, mkApiAd } from "../helpers/poller-harness.js";

let mods;
beforeEach(async () => {
  mods = await freshModules(["@/core/poller.js"]);
  seedLbcTab();
  await mods.db.saveSession("KEY", "UA/1.0");
});

// Helper: build N ads spaced 1 day apart so first_publication_date walks
// backwards from `now`. Page `p` returns ads offset by p*35 days.
function genPage(startDayOffset, count) {
  const now = Date.now();
  const DAY = 86_400_000;
  return Array.from({ length: count }, (_, i) =>
    mkApiAd({
      list_id: `bf-${startDayOffset}-${i}`,
      price: [100 + i],
      first_publication_date: new Date(now - (startDayOffset + i) * DAY).toISOString(),
    }),
  );
}

describe("backfill — multi-page pagination", () => {
  it("fetches subsequent pages until API returns <35 ads, persists all", async () => {
    const wl = makeWatchlist({
      id: "wl-bf",
      last_seen_ad_id: null,
      backfill_days: 100,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);

    // Page 1: 35 ads (days 0-34). Page 2: 35 ads (days 35-69). Page 3: 10 ads → LBC exhausted.
    let call = 0;
    installFetchStub(() => {
      call++;
      if (call === 1) return { ads: genPage(0, 35) };
      if (call === 2) return { ads: genPage(35, 35) };
      return { ads: genPage(70, 10) };
    });

    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("ok");
    expect(result.backfillCount).toBe(80);

    const allAds = await mods.db.dbGetAll("ads");
    expect(allAds).toHaveLength(80);
    // is_backfill marker set on every seeded ad (silent-seed contract)
    expect(allAds.every((a) => a.is_backfill === true)).toBe(true);
  });

  it("stops early when the oldest ad on a page predates the cutoff", async () => {
    const wl = makeWatchlist({
      id: "wl-bf-cut",
      last_seen_ad_id: null,
      backfill_days: 30,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);

    let call = 0;
    // Page 1: ads from today back to day 34 (some outside cutoff → trimmed)
    installFetchStub(() => {
      call++;
      if (call === 1) return { ads: genPage(0, 35) };
      // Should NEVER be reached — oldest on page 1 = day 34 > 30-day cutoff,
      // so the loop's early-exit fires before the second fetch.
      return { ads: genPage(35, 35) };
    });

    await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(call).toBe(1);

    const allAds = await mods.db.dbGetAll("ads");
    // Ads beyond the 30-day window are clipped post-fetch.
    expect(allAds.every((a) => a.created_at >= Date.now() - 31 * 86_400_000)).toBe(true);
  });

  it("clears pending_backfill_days on success", async () => {
    const wl = makeWatchlist({
      id: "wl-bf-clear",
      last_seen_ad_id: "seed", // not first poll — pending triggers re-seed
      pending_backfill_days: 30,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);

    let call = 0;
    installFetchStub(() => {
      call++;
      return call === 1 ? { ads: genPage(0, 5) } : { ads: [] };
    });

    await mods["@/core/poller.js"].pollWatchlist(wl);

    const saved = (await mods.db.getWatchlists())[0];
    expect(saved.pending_backfill_days).toBe(0);
    expect(saved.last_backfill_at).toBeGreaterThan(0);
    expect(saved.last_backfill_count).toBeGreaterThan(0);
  });

  it("PRESERVES pending_backfill_days when a page fails all retries", async () => {
    const wl = makeWatchlist({
      id: "wl-bf-fail",
      last_seen_ad_id: "seed",
      pending_backfill_days: 60,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);

    // Page 1 succeeds; page 2 always fails → pagination breaks, pending survives.
    installFetchStub((_msg, n) => (n === 1 ? { ads: genPage(0, 35) } : null), {
      fail: (n) => (n >= 2 ? "network" : "success"),
    });

    const msgSpy = vi.spyOn(chrome.runtime, "sendMessage");
    await mods["@/core/poller.js"].pollWatchlist(wl);

    const saved = (await mods.db.getWatchlists())[0];
    // CRITICAL: user's seed request must NOT be lost — retry next cycle.
    expect(saved.pending_backfill_days).toBe(60);

    const errMsg = msgSpy.mock.calls.find((c) => c[0]?.reason === "page_failed");
    expect(errMsg).toBeTruthy();
    expect(errMsg[0].count).toBe(35); // page-1 ads still persisted
  });
});

describe("backfill — progress broadcasts", () => {
  it("emits backfill_start then backfill_done exactly once", async () => {
    const wl = makeWatchlist({
      id: "wl-bf-bcast",
      last_seen_ad_id: null,
      backfill_days: 7,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);

    let call = 0;
    installFetchStub(() => {
      call++;
      return call === 1 ? { ads: genPage(0, 3) } : { ads: [] };
    });

    const msgSpy = vi.spyOn(chrome.runtime, "sendMessage");
    await mods["@/core/poller.js"].pollWatchlist(wl);

    const starts = msgSpy.mock.calls.filter((c) => c[0]?.phase === "backfill_start");
    const dones = msgSpy.mock.calls.filter((c) => c[0]?.phase === "backfill_done");
    expect(starts).toHaveLength(1);
    expect(dones).toHaveLength(1);
    expect(starts[0][0].days).toBe(7);
    expect(dones[0][0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("emits NO backfill_start on a normal (non-backfill) poll", async () => {
    const wl = makeWatchlist({
      id: "wl-inc",
      last_seen_ad_id: "a1",
      backfill_days: 0,
      pending_backfill_days: 0,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);

    installFetchStub(() => ({ ads: [mkApiAd({ list_id: "a2" })] }));

    const msgSpy = vi.spyOn(chrome.runtime, "sendMessage");
    await mods["@/core/poller.js"].pollWatchlist(wl);

    const bfPhases = msgSpy.mock.calls.filter(
      (c) => c[0]?.phase === "backfill_start" || c[0]?.phase === "backfill_done",
    );
    expect(bfPhases).toHaveLength(0);
  });
});

describe("backfill — price history seeding", () => {
  it("saves multiple price_history rows from the full multi-page sample", async () => {
    const wl = makeWatchlist({
      id: "wl-bf-price",
      keywords: "nintendo switch",
      last_seen_ad_id: null,
      backfill_days: 30,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);

    let call = 0;
    installFetchStub(() => {
      call++;
      if (call === 1) return { ads: genPage(0, 10) };
      return { ads: [] };
    });

    await mods["@/core/poller.js"].pollWatchlist(wl);

    const history = await mods.db.getPriceHistory("nintendo switch", "30", 100);
    // ≥5 prices, so the seed loop creates min(20, backfillDays=30) = 20 points.
    expect(history.length).toBeGreaterThanOrEqual(20);
    // All rows share keyword+category_id.
    expect(history.every((r) => r.keyword === "nintendo switch")).toBe(true);
    expect(history.every((r) => r.category_id === "30")).toBe(true);
  });
});

describe("backfill — re-seed preserves user flags", () => {
  it("re-backfill does NOT wipe is_flagged / notes / is_purchased", async () => {
    const wl = makeWatchlist({
      id: "wl-reseed",
      last_seen_ad_id: "seed",
      pending_backfill_days: 30,
      require_market_data: false,
    });
    await mods.db.saveWatchlist(wl);
    // Pre-existing user-curated ad with the same id the API will return.
    await mods.db.bulkSaveAds([
      {
        id: "bf-0-0",
        mergeFn: () => ({
          id: "bf-0-0",
          list_id: "wl-reseed",
          is_flagged: true,
          is_purchased: true,
          notes: "keep-me",
          price: 999,
          seen_at: Date.now() - 10_000_000,
        }),
      },
    ]);

    let call = 0;
    installFetchStub(() => {
      call++;
      return call === 1 ? { ads: genPage(0, 5) } : { ads: [] };
    });

    await mods["@/core/poller.js"].pollWatchlist(wl);

    const a = await mods.db.getAd("bf-0-0");
    expect(a.is_flagged).toBe(true);
    expect(a.is_purchased).toBe(true);
    expect(a.notes).toBe("keep-me");
    // Poll-derived fields refreshed:
    expect(a.is_backfill).toBe(true);
    expect(a.price).toBe(100); // API returned price[0]=100
  });
});
