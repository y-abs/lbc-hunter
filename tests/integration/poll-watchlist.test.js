// Tier 4 — INTEGRATION: pollWatchlist end-to-end.
// Exercises the full pipeline: LBC tab discovery → fetch proxy →
// dedup → persist → market stats → evaluate → alert → watchlist save.
// The fetch layer is stubbed at chrome.tabs.sendMessage (PING + EXECUTE_FETCH)
// so every other production path runs for real against fake-IDB.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeWatchlist } from "../helpers/factories.js";

let mods;

function mkApiAd(overrides = {}) {
  const id = overrides.list_id ?? overrides.id ?? String(Math.floor(Math.random() * 1e9));
  const ts = overrides.index_date ?? new Date().toISOString();
  return {
    list_id: id,
    id,
    subject: "Nintendo Switch OLED",
    body: "Parfait état",
    price: [200],
    index_date: ts,
    first_publication_date: ts,
    category_id: "30",
    location: { lat: 48.85, lng: 2.35, city: "Paris", zipcode: "75000" },
    owner: { type: "private", user_id: "user-" + id, name: "X" },
    images: { urls_large: ["http://x/img.jpg"] },
    ...overrides,
  };
}

function installFetchStub(responseFactory) {
  // responseFactory(msg) → data returned by EXECUTE_FETCH.
  chrome.tabs.sendMessage = vi.fn((_tabId, msg, cb) => {
    if (msg?.type === "PING") return cb?.({ pong: true });
    if (msg?.type === "EXECUTE_FETCH") return cb?.({ ok: true, data: responseFactory(msg) });
    return cb?.({ ok: false, error: "unknown" });
  });
}

function seedLbcTab() {
  // Inject a fully-loaded, non-discarded LBC tab so _getPollTabId → Step 1+2.
  chrome.tabs._list.set(1, {
    id: 1,
    url: "https://www.leboncoin.fr/",
    status: "complete",
    active: true,
    discarded: false,
    lastAccessed: Date.now(),
  });
  chrome.tabs._nextId = 2;
}

beforeEach(async () => {
  mods = await freshModules(["@/core/poller.js", "@/core/notifier.js"]);
  seedLbcTab();
  await mods.db.saveSession("KEY", "UA/1.0");
});

describe("pollWatchlist — first poll (seed, no alerts)", () => {
  it("persists all ads silently; no notifications; last_seen_ad_id set", async () => {
    const wl = makeWatchlist({
      id: "wl-seed",
      last_seen_ad_id: null,
      require_market_data: false, // don't block on empty market stats
      backfill_days: 0,
    });
    await mods.db.saveWatchlist(wl);

    installFetchStub(() => ({
      ads: [
        mkApiAd({ list_id: "a1", price: [100] }),
        mkApiAd({ list_id: "a2", price: [150] }),
        mkApiAd({ list_id: "a3", price: [250] }),
      ],
    }));

    const notifSpy = vi.spyOn(chrome.notifications, "create");
    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("ok");

    // All 3 ads persisted (stored by API list_id as primary key `id`;
    // the record's `list_id` field is the watchlist id — counterintuitive
    // but documented at src/core/poller.js:1067).
    const all = await mods.db.dbGetAll("ads");
    expect(all.map((a) => a.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(all.every((a) => a.list_id === "wl-seed")).toBe(true);

    // None flagged as alerted (first-poll seed contract)
    expect(all.every((a) => a.is_alerted !== true)).toBe(true);

    // No Chrome notifications fired
    expect(notifSpy).not.toHaveBeenCalled();

    // Watchlist advanced: last_seen_ad_id set to newest ad
    const saved = (await mods.db.getWatchlists()).find((w) => w.id === "wl-seed");
    expect(saved.last_seen_ad_id).toBeTruthy();
    expect(saved.last_polled_at).toBeGreaterThan(0);
    expect(saved.consecutive_poll_failures).toBe(0);
  });
});

describe("pollWatchlist — subsequent poll fires alerts for new ads only", () => {
  it("alerts on newly-introduced ads, never re-alerts existing ones", async () => {
    const wl = makeWatchlist({
      id: "wl-live",
      last_seen_ad_id: "a3", // pre-seed: last poll saw a3 as newest
      require_market_data: false,
      backfill_days: 0,
      undermarket_threshold_pct: 100, // every ad matches (always red-tier)
      auto_open_tab: false,
      auto_message_enabled: false,
      purchase_mode: "manual",
    });
    await mods.db.saveWatchlist(wl);
    // Old ad already in IDB (simulating prior poll). Note the
    // record's `list_id` holds the WATCHLIST id, not the ad's API id.
    await mods.db.bulkSaveAds([
      {
        id: "a3",
        mergeFn: () => ({
          id: "a3",
          list_id: "wl-live",
          title: "old",
          price: 250,
          seen_at: Date.now() - 10_000,
        }),
      },
    ]);

    installFetchStub(() => ({
      ads: [
        mkApiAd({ list_id: "a5", price: [80] }), // NEW (newest, top of list)
        mkApiAd({ list_id: "a4", price: [120] }), // NEW
        mkApiAd({ list_id: "a3", price: [250] }), // existing — stop marker
      ],
    }));

    const notifSpy = vi.spyOn(chrome.notifications, "create");
    const result = await mods["@/core/poller.js"].pollWatchlist(wl);
    expect(result.status).toBe("ok");
    expect(result.newCount).toBe(2); // a5 + a4

    // a3 NOT re-marked alerted
    const a3 = await mods.db.getAd("a3");
    expect(a3.is_alerted).not.toBe(true);

    // Two alerts fired
    expect(notifSpy).toHaveBeenCalledTimes(2);

    // Both new ads persisted with is_alerted = true
    const [a4, a5] = await Promise.all([mods.db.getAd("a4"), mods.db.getAd("a5")]);
    expect(a4?.is_alerted).toBe(true);
    expect(a5?.is_alerted).toBe(true);

    // last_seen_ad_id advanced to newest (a5)
    const saved = (await mods.db.getWatchlists()).find((w) => w.id === "wl-live");
    expect(saved.last_seen_ad_id).toBe("a5");
  });
});

describe("pollWatchlist — no session is non-destructive", () => {
  it('returns {status:"no_session"} and records failure telemetry', async () => {
    // Wipe session we seeded in beforeEach.
    await mods.db.clearSession?.(); // fallback if helper exists
    // Fallback: overwrite with null-like record via raw IDB. Simpler: skip
    // the session save path by using a watchlist on a NEW DB without session.
    const dbMod = mods.db;
    // If no clearSession, do a direct IDBFactory reset via freshIdbModule and
    // re-wire poller. Instead, use a fresh per-test DB:
    const fresh = await freshModules(["@/core/poller.js"]);
    seedLbcTab();
    await fresh.db.saveWatchlist(makeWatchlist({ id: "wl-no-sess" }));

    const result = await fresh["@/core/poller.js"].pollWatchlist({ id: "wl-no-sess", name: "x" });
    expect(result.status).toBe("no_session");

    const saved = (await fresh.db.getWatchlists()).find((w) => w.id === "wl-no-sess");
    expect(saved.consecutive_poll_failures).toBe(1);
    expect(saved.last_poll_error?.message).toBe("no_session");
    // silence unused
    void dbMod;
  });
});
