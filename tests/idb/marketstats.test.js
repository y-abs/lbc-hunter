// Tier 2 — market stats category null-strict semantics.
// A null category watchlist MUST NOT read/write the baseline of a
// category-filtered watchlist that shares the keyword, and vice versa.

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

const mkStat = (over = {}) => ({
  id: "s-" + Math.random().toString(36).slice(2),
  keyword: "switch",
  category_id: "30",
  timestamp: Date.now(),
  median_price: 250,
  avg_price: 250,
  min_price: 200,
  max_price: 300,
  sample_count: 10,
  ...over,
});

describe("getLatestMarketStats — null-strict category", () => {
  it('(keyword, "30") returns only category=30 rows', async () => {
    await db.savePriceHistory(mkStat({ category_id: "30", timestamp: 2 }));
    await db.savePriceHistory(mkStat({ category_id: null, timestamp: 3 }));
    const r = await db.getLatestMarketStats("switch", "30");
    expect(r.category_id).toBe("30");
  });

  it("(keyword, null) returns only null-category rows", async () => {
    await db.savePriceHistory(mkStat({ category_id: "30", timestamp: 5 }));
    await db.savePriceHistory(mkStat({ category_id: null, timestamp: 1 }));
    const r = await db.getLatestMarketStats("switch", null);
    expect(r.category_id).toBeNull();
    expect(r.timestamp).toBe(1);
  });

  it("returns null when no rows match the category bucket", async () => {
    await db.savePriceHistory(mkStat({ category_id: "30" }));
    const r = await db.getLatestMarketStats("switch", "40");
    expect(r).toBeNull();
  });

  it("returns newest row in the bucket (timestamp reducer)", async () => {
    await db.savePriceHistory(mkStat({ category_id: "30", timestamp: 100 }));
    await db.savePriceHistory(mkStat({ category_id: "30", timestamp: 500 }));
    await db.savePriceHistory(mkStat({ category_id: "30", timestamp: 300 }));
    const r = await db.getLatestMarketStats("switch", "30");
    expect(r.timestamp).toBe(500);
  });
});

describe("getPriceHistory — null-strict category", () => {
  it("isolates buckets like getLatestMarketStats", async () => {
    await db.savePriceHistory(mkStat({ category_id: "30", timestamp: 1 }));
    await db.savePriceHistory(mkStat({ category_id: null, timestamp: 2 }));
    const cat = await db.getPriceHistory("switch", "30");
    const nulls = await db.getPriceHistory("switch", null);
    expect(cat).toHaveLength(1);
    expect(nulls).toHaveLength(1);
    expect(cat[0].category_id).toBe("30");
    expect(nulls[0].category_id).toBeNull();
  });

  it("orders newest first and respects limit", async () => {
    for (let i = 1; i <= 5; i++) {
      await db.savePriceHistory(mkStat({ category_id: "30", timestamp: i * 100 }));
    }
    const r = await db.getPriceHistory("switch", "30", 3);
    expect(r).toHaveLength(3);
    expect(r[0].timestamp).toBeGreaterThan(r[r.length - 1].timestamp);
  });
});

describe("purgePriceHistory", () => {
  it("deletes rows older than cutoff", async () => {
    const now = Date.now();
    const YEAR = 366 * 24 * 60 * 60 * 1000;
    await db.savePriceHistory(mkStat({ id: "stale", timestamp: now - 2 * YEAR }));
    await db.savePriceHistory(mkStat({ id: "fresh", timestamp: now }));
    const n = await db.purgePriceHistory(YEAR);
    expect(n).toBe(1);
    const remaining = await db.getPriceHistory("switch", "30", 100);
    expect(remaining.find((r) => r.id === "fresh")).toBeDefined();
    expect(remaining.find((r) => r.id === "stale")).toBeUndefined();
  });
});
