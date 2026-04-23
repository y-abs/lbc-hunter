// Tier 2 — deleteWatchlist cascade (ads yes, purchases/price_history no)

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";
import { makeAd, makeWatchlist, makePurchase } from "../helpers/factories.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

describe("deleteWatchlist", () => {
  it("removes the watchlist row", async () => {
    await db.saveWatchlist(makeWatchlist({ id: "wl-1" }));
    await db.deleteWatchlist("wl-1");
    const all = await db.getWatchlists();
    expect(all.find((w) => w.id === "wl-1")).toBeUndefined();
  });

  it("cascade-deletes ads belonging to that watchlist", async () => {
    await db.saveWatchlist(makeWatchlist({ id: "wl-1" }));
    await db.saveWatchlist(makeWatchlist({ id: "wl-2" }));
    await db.bulkSaveAds([
      { id: "a1", mergeFn: () => makeAd({ id: "a1", list_id: "wl-1" }) },
      { id: "a2", mergeFn: () => makeAd({ id: "a2", list_id: "wl-1" }) },
      { id: "a3", mergeFn: () => makeAd({ id: "a3", list_id: "wl-2" }) },
    ]);
    await db.deleteWatchlist("wl-1");
    expect(await db.getAd("a1")).toBeUndefined();
    expect(await db.getAd("a2")).toBeUndefined();
    expect((await db.getAd("a3")).id).toBe("a3"); // unrelated watchlist preserved
  });

  it("preserves purchases linked to the deleted watchlist", async () => {
    await db.saveWatchlist(makeWatchlist({ id: "wl-1" }));
    await db.savePurchase(makePurchase({ id: "p1", list_id: "wl-1", buy_price: 100 }));
    await db.deleteWatchlist("wl-1");
    const purchases = await db.getPurchases();
    expect(purchases.find((p) => p.id === "p1")).toBeDefined();
  });

  it("preserves price_history entries (keyword-keyed, shared across watchlists)", async () => {
    await db.saveWatchlist(makeWatchlist({ id: "wl-1", keywords: "switch" }));
    await db.savePriceHistory({
      id: "ph-1",
      keyword: "switch",
      category_id: "30",
      timestamp: Date.now(),
      median_price: 300,
      sample_count: 10,
    });
    await db.deleteWatchlist("wl-1");
    const history = await db.getPriceHistory("switch", "30");
    expect(history).toHaveLength(1);
  });
});
