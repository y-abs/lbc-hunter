// Tier 1 — buildSearchBody (poller.js private, exposed via __test__)

import { describe, it, expect } from "vitest";
import { __test__ as poller } from "@/core/poller.js";
import { makeWatchlist } from "../helpers/factories.js";

const { buildSearchBody } = poller;

describe("buildSearchBody — structure", () => {
  it("always includes ad_type=offer and sort_by=time", () => {
    const body = buildSearchBody(makeWatchlist());
    expect(body.filters.enums.ad_type).toEqual(["offer"]);
    expect(body.sort_by).toBe("time");
    expect(body.sort_order).toBe("desc");
    expect(body.limit).toBe(35);
  });
  it("propagates keywords", () => {
    const body = buildSearchBody(makeWatchlist({ keywords: "steam deck" }));
    expect(body.filters.keywords).toEqual({ text: "steam deck", type: "all" });
  });
});

describe("buildSearchBody — price range", () => {
  it("includes range when price_min set", () => {
    const body = buildSearchBody(makeWatchlist({ price_min: 50, price_max: null }));
    expect(body.filters.ranges.price).toEqual({ min: 50, max: 99999 });
  });
  it("includes range when price_max set", () => {
    const body = buildSearchBody(makeWatchlist({ price_min: null, price_max: 300 }));
    expect(body.filters.ranges.price).toEqual({ min: 0, max: 300 });
  });
  it("omits ranges when neither is set", () => {
    const body = buildSearchBody(makeWatchlist({ price_min: null, price_max: null }));
    expect(body.filters.ranges).toBeUndefined();
  });
});

describe("buildSearchBody — shipping filter", () => {
  it("delivery_only sets shipping.enabled=true", () => {
    const body = buildSearchBody(makeWatchlist({ shipping_filter: "delivery_only" }));
    expect(body.filters.shipping).toEqual({ enabled: true });
  });
  it("local_only sets shipping.enabled=false", () => {
    const body = buildSearchBody(makeWatchlist({ shipping_filter: "local_only" }));
    expect(body.filters.shipping).toEqual({ enabled: false });
  });
  it('"any" omits shipping filter entirely', () => {
    const body = buildSearchBody(makeWatchlist({ shipping_filter: "any" }));
    expect(body.filters.shipping).toBeUndefined();
  });
});

describe("buildSearchBody — location / radius", () => {
  it("km → meters conversion", () => {
    const body = buildSearchBody(
      makeWatchlist({
        location_zip: "75001",
        location_lat: 48.85,
        location_lng: 2.35,
        location_radius_km: 25,
      }),
    );
    expect(body.filters.location.area.radius).toBe(25000);
    expect(body.filters.location.zipcode).toEqual(["75001"]);
  });
  it("no radius → zipcode only", () => {
    const body = buildSearchBody(
      makeWatchlist({
        location_zip: "75001",
        location_lat: 48.85,
        location_lng: 2.35,
        location_radius_km: 0,
      }),
    );
    expect(body.filters.location.zipcode).toEqual(["75001"]);
    expect(body.filters.location.area).toBeUndefined();
  });
  it("no zip → omits location", () => {
    const body = buildSearchBody(
      makeWatchlist({
        location_zip: null,
        location_lat: null,
        location_lng: null,
        location_radius_km: 0,
      }),
    );
    expect(body.filters.location).toBeUndefined();
  });
});

describe("buildSearchBody — seller type", () => {
  it('"all" omits owner_type', () => {
    const body = buildSearchBody(makeWatchlist({ seller_type: "all" }));
    expect(body.filters.enums.owner_type).toBeUndefined();
  });
  it('"private" sets owner_type=[private]', () => {
    const body = buildSearchBody(makeWatchlist({ seller_type: "private" }));
    expect(body.filters.enums.owner_type).toEqual(["private"]);
  });
  it('"pro" sets owner_type=[pro]', () => {
    const body = buildSearchBody(makeWatchlist({ seller_type: "pro" }));
    expect(body.filters.enums.owner_type).toEqual(["pro"]);
  });
});

describe("buildSearchBody — category", () => {
  it("stringifies category_id", () => {
    const body = buildSearchBody(makeWatchlist({ category_id: 30 }));
    expect(body.filters.category).toEqual({ id: "30" });
  });
  it("omits category when null", () => {
    const body = buildSearchBody(makeWatchlist({ category_id: null }));
    expect(body.filters.category).toBeUndefined();
  });
});
