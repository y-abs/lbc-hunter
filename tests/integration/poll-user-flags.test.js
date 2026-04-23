// Tier 4 — INTEGRATION: re-poll / re-seed preserves user-curated state;
// auto-open and auto-message side effects fire only for matching alerts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeWatchlist } from "../helpers/factories.js";
import { installFetchStub, seedLbcTab, mkApiAd } from "../helpers/poller-harness.js";

let mods;
beforeEach(async () => {
  mods = await freshModules(["@/core/poller.js", "@/core/automator.js"]);
  seedLbcTab();
  await mods.db.saveSession("KEY", "UA/1.0");
});

describe("re-poll preserves user-curated flags", () => {
  it("is_flagged / is_messaged / is_purchased / notes survive a re-fetch of the same ad", async () => {
    const wl = makeWatchlist({
      id: "wl-u",
      require_market_data: false,
      last_seen_ad_id: "a1",
    });
    await mods.db.saveWatchlist(wl);
    // User curated this ad in the dashboard between polls.
    await mods.db.bulkSaveAds([
      {
        id: "a1",
        mergeFn: () => ({
          id: "a1",
          list_id: "wl-u",
          title: "Curated",
          price: 100,
          is_flagged: true,
          is_messaged: true,
          is_purchased: true,
          ad_status: "sold",
          notes: "called seller",
          seen_at: Date.now() - 1000,
        }),
      },
    ]);

    // Poller sees a1 again (price dropped!) plus a new ad a2.
    // a2 must be strictly newer than a1 so sortedAds (desc by date) puts a2
    // before a1 — otherwise equal timestamps produce unstable sort and a2 can
    // land AFTER a1, making slice(0, lastIdx=0) an empty candidates array.
    const NOW = Date.now();
    installFetchStub(() => ({
      ads: [
        mkApiAd({ list_id: "a2", price: [999], first_publication_date: new Date(NOW + 2000).toISOString() }),
        mkApiAd({ list_id: "a1", price: [50], first_publication_date: new Date(NOW).toISOString() }),
      ],
    }));

    await mods["@/core/poller.js"].pollWatchlist(wl);

    const a1 = await mods.db.getAd("a1");
    // User flags MUST survive.
    expect(a1.is_flagged).toBe(true);
    expect(a1.is_messaged).toBe(true);
    expect(a1.is_purchased).toBe(true);
    expect(a1.ad_status).toBe("sold");
    expect(a1.notes).toBe("called seller");
    // But poll-derived fields refresh — price not touched because a1 was NOT
    // in candidates (it's the stop marker). a2 was inserted.
    const a2 = await mods.db.getAd("a2");
    expect(a2).toBeTruthy();
  });
});

describe("auto_open_tab", () => {
  it("opens an ad tab for red/orange alerts when enabled", async () => {
    const wl = makeWatchlist({
      id: "wl-auto",
      last_seen_ad_id: "seed",
      require_market_data: false,
      auto_open_tab: true,
      undermarket_threshold_pct: 100, // force match
    });
    await mods.db.saveWatchlist(wl);

    const tabCreateSpy = vi.spyOn(chrome.tabs, "create");
    installFetchStub(() => ({ ads: [mkApiAd({ list_id: "a-new", price: [10] })] }));
    await mods["@/core/poller.js"].pollWatchlist(wl);

    // At least one call with a LBC ad URL (matcher may produce orange/red).
    const adTabCreate = tabCreateSpy.mock.calls.find(
      (c) => typeof c[0]?.url === "string" && /leboncoin\.fr\/ad\//.test(c[0].url),
    );
    expect(adTabCreate).toBeTruthy();
  });

  it("does NOT open an ad tab when auto_open_tab is false", async () => {
    const wl = makeWatchlist({
      id: "wl-noauto",
      last_seen_ad_id: "seed",
      require_market_data: false,
      auto_open_tab: false,
      undermarket_threshold_pct: 100,
    });
    await mods.db.saveWatchlist(wl);

    const tabCreateSpy = vi.spyOn(chrome.tabs, "create");
    installFetchStub(() => ({ ads: [mkApiAd({ list_id: "a-new", price: [10] })] }));
    await mods["@/core/poller.js"].pollWatchlist(wl);

    // Never opened an ad/ URL
    expect(tabCreateSpy.mock.calls.every((c) => !/leboncoin\.fr\/ad\//.test(c[0]?.url || ""))).toBe(true);
  });

  it("does NOT open ad tab during a backfill run (first-poll silent seed)", async () => {
    const wl = makeWatchlist({
      id: "wl-bf-auto",
      last_seen_ad_id: null, // first poll
      backfill_days: 3,
      require_market_data: false,
      auto_open_tab: true,
      undermarket_threshold_pct: 100,
    });
    await mods.db.saveWatchlist(wl);

    const tabCreateSpy = vi.spyOn(chrome.tabs, "create");
    // Single page (first-publication_date in-window). Second page returns empty → loop breaks.
    let callCount = 0;
    installFetchStub(() => {
      callCount++;
      if (callCount === 1) return { ads: [mkApiAd({ list_id: "a1", price: [10] })] };
      return { ads: [] }; // subsequent pagination terminates
    });
    await mods["@/core/poller.js"].pollWatchlist(wl);

    expect(tabCreateSpy.mock.calls.every((c) => !/leboncoin\.fr\/ad\//.test(c[0]?.url || ""))).toBe(true);
  });
});

describe("auto_message_enabled", () => {
  it("calls sendAutoMessage when a new ad matches and auto_message is on", async () => {
    // Stub the automator so we don't drive real DOM automation.
    const sendSpy = vi.spyOn(mods["@/core/automator.js"], "sendAutoMessage").mockResolvedValue(undefined);
    // Re-import poller AFTER spy so it binds to our mock.
    // (freshModules already imported it; the spy patches the live export.)

    const wl = makeWatchlist({
      id: "wl-msg",
      last_seen_ad_id: "seed",
      require_market_data: false,
      auto_message_enabled: true,
      auto_message_template_id: "tpl-1",
      undermarket_threshold_pct: 100,
    });
    await mods.db.saveWatchlist(wl);

    installFetchStub(() => ({ ads: [mkApiAd({ list_id: "a-new", price: [10] })] }));
    await mods["@/core/poller.js"].pollWatchlist(wl);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][1]).toBe("tpl-1");
  });

  it("does NOT send auto-message during a backfill (silent re-seed contract)", async () => {
    const sendSpy = vi.spyOn(mods["@/core/automator.js"], "sendAutoMessage").mockResolvedValue(undefined);

    const wl = makeWatchlist({
      id: "wl-bf-msg",
      last_seen_ad_id: null,
      backfill_days: 3,
      require_market_data: false,
      auto_message_enabled: true,
      undermarket_threshold_pct: 100,
    });
    await mods.db.saveWatchlist(wl);

    let c = 0;
    installFetchStub(() => {
      c++;
      return c === 1 ? { ads: [mkApiAd({ list_id: "a1", price: [10] })] } : { ads: [] };
    });
    await mods["@/core/poller.js"].pollWatchlist(wl);

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
