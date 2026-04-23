// Tier 1 — Pure unit tests for src/shared/utils.js
// No IDB, no chrome.* (except what setup.js installs). Deterministic.

import { describe, it, expect } from "vitest";
import {
  haversineKm,
  mean,
  median,
  deepSearch,
  interpolateTemplate,
  clamp,
  adUrl,
  lbcAdUrl,
  safeUrl,
  csvCell,
  resolveShipping,
  relativeTime,
  uuid,
} from "@/shared/utils.js";

describe("haversineKm", () => {
  it("returns 0 for identical points", () => {
    expect(haversineKm(48.85, 2.35, 48.85, 2.35)).toBe(0);
  });
  it("matches known Paris → Lyon distance (~392km) within 2%", () => {
    const d = haversineKm(48.8566, 2.3522, 45.764, 4.8357);
    expect(d).toBeGreaterThan(385);
    expect(d).toBeLessThan(400);
  });
});

describe("mean / median", () => {
  it("mean handles empty", () => {
    expect(mean([])).toBe(0);
  });
  it("median handles empty", () => {
    expect(median([])).toBe(0);
  });
  it("median odd length picks middle", () => {
    expect(median([1, 2, 3])).toBe(2);
  });
  it("median even length averages middle pair", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("median does not mutate input", () => {
    const arr = [3, 1, 2];
    median(arr);
    expect(arr).toEqual([3, 1, 2]);
  });
});

describe("deepSearch", () => {
  it("finds first matching key at any depth", () => {
    expect(deepSearch({ a: { b: { c: 42 } } }, "c")).toBe(42);
  });
  it("bails at depth 10 (circular safety)", () => {
    const obj = {};
    let cur = obj;
    for (let i = 0; i < 20; i++) {
      cur.next = {};
      cur = cur.next;
    }
    cur.target = "deep";
    expect(deepSearch(obj, "target")).toBeNull();
  });
  it("returns null on non-object", () => {
    expect(deepSearch(null, "x")).toBeNull();
    expect(deepSearch("str", "x")).toBeNull();
  });
});

describe("interpolateTemplate", () => {
  it("substitutes variables", () => {
    expect(interpolateTemplate("Bonjour {name}", { name: "Alice" })).toBe("Bonjour Alice");
  });
  it("empty-string fallback for missing vars", () => {
    expect(interpolateTemplate("Hi {x}", {})).toBe("Hi ");
  });
});

describe("clamp", () => {
  it("respects bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("adUrl / lbcAdUrl", () => {
  it("adUrl returns canonical path", () => {
    expect(adUrl("12345")).toBe("https://www.lbc.fr/ad/collection/12345");
  });
  it("lbcAdUrl accepts real lbc.fr URL", () => {
    const url = "https://www.lbc.fr/ad/foo/99";
    expect(lbcAdUrl(url, "99")).toBe(url);
  });
  it("lbcAdUrl rejects non-lbc.fr hostname", () => {
    expect(lbcAdUrl("https://evil.example/ad/1", "1")).toBe("https://www.lbc.fr/ad/collection/1");
  });
  it("lbcAdUrl rejects http (non-https)", () => {
    expect(lbcAdUrl("http://www.lbc.fr/ad/1", "1")).toBe("https://www.lbc.fr/ad/collection/1");
  });
  it("lbcAdUrl rejects javascript: protocol", () => {
    expect(lbcAdUrl("javascript:alert(1)", "1")).toBe("https://www.lbc.fr/ad/collection/1");
  });
  it("lbcAdUrl rejects lookalike domain (lbc.fr.evil.com)", () => {
    expect(lbcAdUrl("https://www.lbc.fr.evil.com/ad/1", "1")).toBe("https://www.lbc.fr/ad/collection/1");
  });
  it("lbcAdUrl accepts subdomain (m.lbc.fr)", () => {
    expect(lbcAdUrl("https://m.lbc.fr/ad/1", "1")).toBe("https://m.lbc.fr/ad/1");
  });
});

describe("safeUrl", () => {
  it("passes http/https through", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
  });
  it("normalises protocol-relative to https", () => {
    expect(safeUrl("//example.com")).toBe("https://example.com");
  });
  it("blocks javascript:", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
  });
  it("blocks data:", () => {
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
  });
  it("blocks blob:", () => {
    expect(safeUrl("blob:https://example.com/x")).toBe("#");
  });
  it("blocks relative paths (not expected for ad URLs)", () => {
    expect(safeUrl("/path")).toBe("#");
  });
  it("handles non-string input", () => {
    expect(safeUrl(null)).toBe("#");
    expect(safeUrl(undefined, "fallback")).toBe("fallback");
  });
});

describe("csvCell — CWE-1236 formula-injection defense", () => {
  it("wraps plain text in double quotes", () => {
    expect(csvCell("hello")).toBe('"hello"');
  });
  it("escapes embedded double quotes (RFC-4180)", () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
  });
  it("prefixes leading = (formula)", () => {
    expect(csvCell("=cmd|/c calc")).toBe('"\'=cmd|/c calc"');
  });
  it("prefixes leading +", () => {
    expect(csvCell("+SUM(A1)")).toBe('"\'+SUM(A1)"');
  });
  it("prefixes leading -", () => {
    expect(csvCell("-2+3")).toBe('"\'-2+3"');
  });
  it("prefixes leading @", () => {
    expect(csvCell("@SUM(1)")).toBe('"\'@SUM(1)"');
  });
  it("prefixes leading tab", () => {
    expect(csvCell("\t=EVIL")).toBe('"\'\t=EVIL"');
  });
  it("prefixes leading CR", () => {
    expect(csvCell("\r=EVIL")).toBe('"\'\r=EVIL"');
  });
  it("handles null/undefined cleanly", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
});

describe("resolveShipping — 6-path detection + cost inference", () => {
  it("detects via pre-processed db field", () => {
    expect(resolveShipping({ is_shipping_enabled: true, shipping_cost: 7.5 })).toEqual({ enabled: true, cost: 7.5 });
  });
  it("detects via legacy attribute is_shipping_enabled=1", () => {
    expect(resolveShipping({ attributes: [{ key: "is_shipping_enabled", value: "1" }] })).toEqual({
      enabled: true,
      cost: null,
    });
  });
  it("detects via modern attribute shipping_type", () => {
    expect(resolveShipping({ attributes: [{ key: "shipping_type", value: "courier" }] })).toEqual({
      enabled: true,
      cost: null,
    });
  });
  it('rejects shipping_type value "none"', () => {
    expect(resolveShipping({ attributes: [{ key: "shipping_type", value: "none" }] })).toEqual({
      enabled: false,
      cost: null,
    });
  });
  it("detects via options.shippable feature flag", () => {
    expect(resolveShipping({ options: { shippable: true } })).toMatchObject({ enabled: true });
  });
  it("detects via has_options.shippable", () => {
    expect(resolveShipping({ has_options: { shippable: true } })).toMatchObject({ enabled: true });
  });
  it("detects via nested shipping.enabled", () => {
    expect(resolveShipping({ shipping: { enabled: true, cost: 3 } })).toEqual({ enabled: true, cost: 3 });
  });
  it("infers enabled=true from cost presence alone (path 6)", () => {
    expect(resolveShipping({ shipping_cost: 5 })).toEqual({ enabled: true, cost: 5 });
  });
  it("self-heal: stored false overridden by attribute", () => {
    // Legacy DB record with stale is_shipping_enabled=false must be
    // self-healed when raw API attribute says shippable.
    const ad = {
      is_shipping_enabled: false,
      attributes: [{ key: "is_shipping_enabled", value: "1" }],
    };
    expect(resolveShipping(ad)).toEqual({ enabled: true, cost: null });
  });
  it("non-shippable returns cost=null even if stray field present", () => {
    const result = resolveShipping({ something_else: true });
    expect(result.enabled).toBe(false);
    expect(result.cost).toBeNull();
  });
  it("handles null/undefined input", () => {
    expect(resolveShipping(null)).toEqual({ enabled: false, cost: null });
    expect(resolveShipping(undefined)).toEqual({ enabled: false, cost: null });
  });
  it("parses numeric cost strings", () => {
    expect(resolveShipping({ shipping_cost: "4.50" })).toMatchObject({ enabled: true, cost: 4.5 });
  });
  it("rejects NaN cost strings (no NaN€ in UI)", () => {
    // non-finite cost coerces to null; no other enable path → enabled=false
    const r = resolveShipping({ shipping_cost: "not-a-number" });
    expect(r.cost).toBeNull();
  });
});

describe("relativeTime", () => {
  it("seconds under 60", () => {
    expect(relativeTime(Date.now() - 5_000)).toMatch(/^il y a \d+s$/);
  });
  it("minutes under 60", () => {
    expect(relativeTime(Date.now() - 120_000)).toMatch(/^il y a \d+min$/);
  });
  it("hours under 24", () => {
    expect(relativeTime(Date.now() - 3_600_000 * 2)).toMatch(/^il y a \d+h$/);
  });
  it("days", () => {
    expect(relativeTime(Date.now() - 86_400_000 * 3)).toBe("il y a 3j");
  });
});

describe("uuid", () => {
  it("returns a v4-shaped string", () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
  it("returns unique ids across calls", () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(uuid());
    expect(seen.size).toBe(50);
  });
});

describe("lbcAdUrl — null/undefined candidate falls back to canonical", () => {
  it("returns canonical URL when candidate is null", () => {
    expect(lbcAdUrl(null, "12345")).toBe("https://www.lbc.fr/ad/collection/12345");
  });
  it("returns canonical URL when candidate is undefined", () => {
    expect(lbcAdUrl(undefined, "99999")).toBe("https://www.lbc.fr/ad/collection/99999");
  });
  it("returns canonical URL when candidate is a number", () => {
    expect(lbcAdUrl(12345, "12345")).toBe("https://www.lbc.fr/ad/collection/12345");
  });
});

describe("resolveShipping — not_shippable value", () => {
  it('rejects shipping_type value "not_shippable"', () => {
    expect(resolveShipping({ attributes: [{ key: "shipping_type", value: "not_shippable" }] })).toEqual({
      enabled: false,
      cost: null,
    });
  });
  it('rejects item_shipping_status value "not_shippable"', () => {
    expect(resolveShipping({ attributes: [{ key: "item_shipping_status", value: "not_shippable" }] })).toEqual({
      enabled: false,
      cost: null,
    });
  });
});
