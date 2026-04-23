// Tier 1 — matcher.evaluateDeal
// Uses freshIdbModule to isolate the blacklist read per test.

import { describe, it, expect, beforeEach } from "vitest";
import { makeAd, makeWatchlist, makeMarketStats } from "../helpers/factories.js";
import { freshIdbModule } from "../helpers/fresh-modules.js";

let db, matcher;
beforeEach(async () => {
  db = await freshIdbModule();
  matcher = await import("@/core/matcher.js");
});

describe("evaluateDeal — price sanity (guard 0)", () => {
  it("rejects price=[] (à débattre)", async () => {
    const r = await matcher.evaluateDeal(makeAd({ price: [] }), makeWatchlist(), makeMarketStats());
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/invalid price/);
  });
  it("rejects price=0 (free/gift listing)", async () => {
    const r = await matcher.evaluateDeal(makeAd({ price: [0] }), makeWatchlist(), makeMarketStats());
    expect(r.is_match).toBe(false);
  });
  it("rejects NaN price", async () => {
    const r = await matcher.evaluateDeal(makeAd({ price: NaN }), makeWatchlist(), makeMarketStats());
    expect(r.is_match).toBe(false);
  });
  it("rejects negative price", async () => {
    const r = await matcher.evaluateDeal(makeAd({ price: [-10] }), makeWatchlist(), makeMarketStats());
    expect(r.is_match).toBe(false);
  });
});

describe("evaluateDeal — price range", () => {
  it("rejects below price_min", async () => {
    const wl = makeWatchlist({ price_min: 100, require_market_data: false });
    const r = await matcher.evaluateDeal(makeAd({ price: [50] }), wl, null);
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/< min/);
  });
  it("rejects above price_max", async () => {
    const wl = makeWatchlist({ price_max: 200, require_market_data: false });
    const r = await matcher.evaluateDeal(makeAd({ price: [500] }), wl, null);
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/> max/);
  });
  it("accepts within range", async () => {
    const wl = makeWatchlist({ price_min: 100, price_max: 300, require_market_data: false });
    const r = await matcher.evaluateDeal(makeAd({ price: [200] }), wl, null);
    expect(r.is_match).toBe(true);
  });
});

describe("evaluateDeal — seller type", () => {
  it("rejects pro when watchlist wants private", async () => {
    const wl = makeWatchlist({ seller_type: "private", require_market_data: false });
    const ad = makeAd({ owner: { type: "pro", store_id: "store-1" } });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/seller type/);
  });
  it("accepts all", async () => {
    const wl = makeWatchlist({ seller_type: "all", require_market_data: false });
    const ad = makeAd({ owner: { type: "pro", store_id: "store-1" } });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(true);
  });
});

describe("evaluateDeal — blacklist", () => {
  it("rejects blacklisted seller", async () => {
    await db.addToBlacklist("bad-seller-1", "scam");
    const wl = makeWatchlist({ require_market_data: false });
    const ad = makeAd({ owner: { type: "private", user_id: "bad-seller-1" } });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/blacklisted/);
  });
  it("allows non-blacklisted seller", async () => {
    const wl = makeWatchlist({ require_market_data: false });
    const ad = makeAd({ owner: { type: "private", user_id: "good-seller" } });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(true);
  });
  it("handles missing seller id (no crash)", async () => {
    const wl = makeWatchlist({ require_market_data: false });
    const ad = makeAd({ owner: {} });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(true);
  });
});

describe("evaluateDeal — radius filter (Greenwich meridian regression)", () => {
  it("rejects ad outside radius", async () => {
    // Paris watchlist, ad in Marseille (~660 km)
    const wl = makeWatchlist({
      location_zip: "75001",
      location_lat: 48.8566,
      location_lng: 2.3522,
      location_radius_km: 50,
      require_market_data: false,
    });
    const ad = makeAd({ location: { lat: 43.2965, lng: 5.3698 } });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/distance.*>/);
  });
  it("accepts ad inside radius", async () => {
    const wl = makeWatchlist({
      location_zip: "75001",
      location_lat: 48.8566,
      location_lng: 2.3522,
      location_radius_km: 20,
      require_market_data: false,
    });
    const ad = makeAd({ location: { lat: 48.87, lng: 2.4 } });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(true);
  });
  it("watchlist with lat=0 still applies radius filter (Greenwich regression)", async () => {
    // If the code used `&& watchlist.location_lat` (truthy), lat=0 would
    // disable the filter. Fix: `!= null`. This test locks that in.
    const wl = makeWatchlist({
      location_zip: "12345",
      location_lat: 0,
      location_lng: 0,
      location_radius_km: 10,
      require_market_data: false,
    });
    const ad = makeAd({ location: { lat: 48.8566, lng: 2.3522 } });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/distance/);
  });
});

describe("evaluateDeal — market delta & tier", () => {
  const wl = (o = {}) => makeWatchlist({ require_market_data: true, ...o });

  it("suppresses alert when market required but unavailable", async () => {
    const r = await matcher.evaluateDeal(makeAd({ price: [100] }), wl(), null);
    expect(r.is_match).toBe(false);
    expect(r.reasons[0]).toMatch(/market data unavailable/);
  });
  it("suppresses when sample_count < 5", async () => {
    const stats = makeMarketStats({ median_price: 200, sample_count: 3 });
    const r = await matcher.evaluateDeal(makeAd({ price: [100] }), wl(), stats);
    expect(r.is_match).toBe(false);
  });
  it("fires RED when pct >= threshold (default 15%)", async () => {
    // median 200, price 150 → 25% below
    const stats = makeMarketStats({ median_price: 200, sample_count: 10 });
    const r = await matcher.evaluateDeal(makeAd({ price: [150] }), wl(), stats);
    expect(r.is_match).toBe(true);
    expect(r.alert_tier).toBe("red");
    expect(r.pct_below_market).toBeCloseTo(25, 0);
  });
  it("fires ORANGE when pct < threshold but within range", async () => {
    // median 200, price 190 → 5% below
    const stats = makeMarketStats({ median_price: 200, sample_count: 10 });
    const r = await matcher.evaluateDeal(makeAd({ price: [190] }), wl(), stats);
    expect(r.alert_tier).toBe("orange");
  });
  it("clamps absurd pct to null (>150%)", async () => {
    // median 1000, price 1 → +99.9% below → under 150, OK.
    // For >150: set price > median * 2.5 (negative pct beyond -150).
    // median 100, price 300 → -200% → null.
    const stats = makeMarketStats({ median_price: 100, sample_count: 10 });
    const r = await matcher.evaluateDeal(
      makeAd({ price: [300] }),
      wl({ require_market_data: false, price_max: 99999 }),
      stats,
    );
    expect(r.pct_below_market).toBeNull();
  });
  it("respects custom undermarket_threshold_pct", async () => {
    const stats = makeMarketStats({ median_price: 200, sample_count: 10 });
    const customWl = wl({ undermarket_threshold_pct: 30 });
    // 25% below → under the 30% threshold → ORANGE, not RED
    const r = await matcher.evaluateDeal(makeAd({ price: [150] }), customWl, stats);
    expect(r.alert_tier).toBe("orange");
  });
  it("handles zero median defensively", async () => {
    const stats = makeMarketStats({ median_price: 0, sample_count: 10 });
    const r = await matcher.evaluateDeal(makeAd({ price: [100] }), wl(), stats);
    // hasUsableMarket is false → require_market_data=true suppresses
    expect(r.is_match).toBe(false);
  });
});

describe("evaluateDeal — shipping pass-through", () => {
  it("populates estimated_total with shipping cost", async () => {
    const wl = makeWatchlist({ require_market_data: false });
    const ad = makeAd({ price: [100], shipping_cost: 5.5 });
    const r = await matcher.evaluateDeal(ad, wl, null);
    expect(r.is_shipping).toBe(true);
    expect(r.shipping_cost).toBe(5.5);
    expect(r.estimated_total).toBe(105.5);
  });
  it("estimated_total equals price when no shipping", async () => {
    const wl = makeWatchlist({ require_market_data: false });
    const r = await matcher.evaluateDeal(makeAd({ price: [100] }), wl, null);
    expect(r.is_shipping).toBe(false);
    expect(r.estimated_total).toBe(100);
  });
});

describe("evaluateDeal — orange + no market data", () => {
  it("returns orange tier when require_market_data=false and no market stats provided", async () => {
    // With require_market_data: false and null marketStats, the deal should match
    // as orange (default tier when price is in range but no market comparison).
    const wl = makeWatchlist({ require_market_data: false, price_min: 50, price_max: 500 });
    const r = await matcher.evaluateDeal(makeAd({ price: [200] }), wl, null);
    expect(r.is_match).toBe(true);
    // pct_below_market must be null since there's no market data
    expect(r.pct_below_market).toBeNull();
  });

  it("alert_tier is orange when no market stats are available (no market comparison possible)", async () => {
    const wl = makeWatchlist({ require_market_data: false });
    const r = await matcher.evaluateDeal(makeAd({ price: [150] }), wl, null);
    expect(r.is_match).toBe(true);
    expect(r.alert_tier).toBe("orange");
    expect(r.pct_below_market).toBeNull();
  });
});
