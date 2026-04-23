// Tier 1 — pricer.updateMarketStats
// IDB-backed: use freshModules to reset both db and pricer binding.

import { describe, it, expect, beforeEach } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";

let _db, pricer;
beforeEach(async () => {
  const m = await freshModules(["@/core/pricer.js"]);
  _db = m.db;
  pricer = m["@/core/pricer.js"];
});

const mkAds = (prices) =>
  prices.map((p, i) => ({
    id: `ad-${i}`,
    price: [p],
    subject: "x",
    category_id: "30",
  }));

describe("updateMarketStats — sample threshold", () => {
  it("returns null with < 5 priced ads", async () => {
    const r = await pricer.updateMarketStats("switch", "30", mkAds([100, 120, 140]));
    expect(r).toBeNull();
  });
  it("returns null when all prices are invalid", async () => {
    const ads = [{ price: [] }, { price: [0] }, { price: [-5] }, { price: [NaN] }];
    const r = await pricer.updateMarketStats("switch", "30", ads);
    expect(r).toBeNull();
  });
  it("accepts exactly 5 valid prices", async () => {
    const r = await pricer.updateMarketStats("switch", "30", mkAds([100, 110, 120, 130, 140]));
    expect(r).not.toBeNull();
    expect(r.sample_count).toBeGreaterThan(0);
  });
});

describe("updateMarketStats — 5/95 percentile trim", () => {
  it("drops bottom 5% and top 5% from a 20-sample pool", async () => {
    // 20 prices: 1 through 20. Bottom 5% = index 0..0 (removed). Top 5% via
    // Math.ceil(20 * 0.95) = 19, so `slice(1, 19)` keeps indexes 1..18 (18 items).
    const prices = Array.from({ length: 20 }, (_, i) => i + 1);
    const r = await pricer.updateMarketStats("switch", "30", mkAds(prices));
    expect(r.sample_count).toBe(18);
    expect(r.min_price).toBe(2);
    expect(r.max_price).toBe(19);
  });
  it("median of 1..20 trimmed pool equals 10.5", async () => {
    const prices = Array.from({ length: 20 }, (_, i) => i + 1);
    const r = await pricer.updateMarketStats("switch", "30", mkAds(prices));
    expect(r.median_price).toBe(10.5);
  });
});

describe("updateMarketStats — persistence", () => {
  it("writes a price-history row and getMarketStats reads it back", async () => {
    await pricer.updateMarketStats("switch", "30", mkAds([100, 110, 120, 130, 140, 150]));
    const latest = await pricer.getMarketStats("switch", "30");
    expect(latest).not.toBeNull();
    expect(latest.keyword).toBe("switch");
    expect(latest.category_id).toBe("30");
  });
  it('category null-strict: null category stats are not returned for category "30"', async () => {
    await pricer.updateMarketStats("switch", null, mkAds([100, 110, 120, 130, 140, 150]));
    const typed = await pricer.getMarketStats("switch", "30");
    expect(typed).toBeNull();
    const nullCat = await pricer.getMarketStats("switch", null);
    expect(nullCat).not.toBeNull();
  });
});

describe("updateMarketStats — output shape", () => {
  it("returns the full stats object", async () => {
    const r = await pricer.updateMarketStats("switch", "30", mkAds([100, 110, 120, 130, 140, 150, 160]));
    expect(r).toMatchObject({
      keyword: "switch",
      category_id: "30",
    });
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof r.timestamp).toBe("number");
    expect(typeof r.avg_price).toBe("number");
    expect(typeof r.median_price).toBe("number");
    expect(r.min_price).toBeLessThanOrEqual(r.max_price);
  });
});

// ── getMarketChart ────────────────────────────────────────────────────────────

describe("getMarketChart", () => {
  it("returns an empty array when no price history exists", async () => {
    const result = await pricer.getMarketChart("no-history-kw", null);
    expect(result).toEqual([]);
  });

  it("returns records ordered newest-first", async () => {
    // Save two price history records with different timestamps
    await pricer.updateMarketStats("chart-kw", "30", mkAds([100, 110, 120, 130, 140]));
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 2));
    await pricer.updateMarketStats("chart-kw", "30", mkAds([200, 210, 220, 230, 240]));
    const result = await pricer.getMarketChart("chart-kw", "30");
    expect(result.length).toBe(2);
    expect(result[0].timestamp).toBeGreaterThanOrEqual(result[1].timestamp);
  });

  it("respects the limit parameter", async () => {
    // Save 5 records
    for (let i = 0; i < 5; i++) {
      await pricer.updateMarketStats("limit-kw", null, mkAds([100, 110, 120, 130, 140]));
      await new Promise((r) => setTimeout(r, 1));
    }
    const limited = await pricer.getMarketChart("limit-kw", null, 3);
    expect(limited).toHaveLength(3);
  });

  it("uses strict null category — null category does not return category-30 records", async () => {
    await pricer.updateMarketStats("cat-kw", "30", mkAds([100, 110, 120, 130, 140]));
    await pricer.updateMarketStats("cat-kw", null, mkAds([200, 210, 220, 230, 240]));

    const typed = await pricer.getMarketChart("cat-kw", "30");
    const nullC = await pricer.getMarketChart("cat-kw", null);

    expect(typed.every((r) => r.category_id === "30")).toBe(true);
    expect(nullC.every((r) => (r.category_id ?? null) === null)).toBe(true);
  });
});
