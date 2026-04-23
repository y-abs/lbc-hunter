// Tier 1 — reporter: buildReport, toHTML, toText, openMailto, sendViaEmailJS

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makePurchase, makeAd, makeWatchlist } from "../helpers/factories.js";

let db, reporter;
beforeEach(async () => {
  const m = await freshModules(["@/core/reporter.js"]);
  db = m.db;
  reporter = m["@/core/reporter.js"];
});

describe("buildReport", () => {
  it("aggregates alerts, purchases, and watchlist names", async () => {
    const wl = makeWatchlist({ id: "wl-1", name: "Switch Paris" });
    await db.saveWatchlist(wl);

    // 3 ads, 2 red + 1 orange
    const t0 = Date.now() - 3600_000;
    const ad1 = makeAd({
      id: "a1",
      list_id: "wl-1",
      alert_tier: "red",
      pct_below_market: 30,
      seen_at: t0,
      subject: "Switch RED 1",
    });
    const ad2 = makeAd({
      id: "a2",
      list_id: "wl-1",
      alert_tier: "red",
      pct_below_market: 20,
      seen_at: t0,
      subject: "Switch RED 2",
    });
    const ad3 = makeAd({
      id: "a3",
      list_id: "wl-1",
      alert_tier: "orange",
      pct_below_market: 10,
      seen_at: t0,
      subject: "Switch ORG",
    });
    await db.bulkSaveAds([ad1, ad2, ad3].map((a) => ({ id: a.id, mergeFn: () => a })));

    // 2 purchases
    await db.savePurchase(
      makePurchase({ id: "p1", title: "P1", buy_price: 100, sell_price: 180, status: "sold", buy_date: t0 }),
    );
    await db.savePurchase(
      makePurchase({ id: "p2", title: "P2", buy_price: 50, sell_price: null, status: "active", buy_date: t0 }),
    );

    const report = await reporter.buildReport({ from: t0 - 10_000, to: Date.now() + 10_000, watchlistIds: ["wl-1"] });

    expect(report.alerts.total).toBe(3);
    expect(report.alerts.red).toBe(2);
    expect(report.alerts.orange).toBe(1);
    expect(report.purchases.count).toBe(2);
    expect(report.purchases.total_spend).toBe(150);
    expect(report.purchases.total_revenue).toBe(180);
    expect(report.purchases.profit).toBe(30);
    expect(report.bestDeal?.id).toBe("a1"); // highest pct
    expect(report.watchlistNames).toEqual(["Switch Paris"]);
    expect(report.topAlerts).toHaveLength(2); // only reds → 2
  });

  it("handles empty period", async () => {
    const r = await reporter.buildReport({ from: 0, to: 1, watchlistIds: [] });
    expect(r.alerts.total).toBe(0);
    expect(r.purchases.count).toBe(0);
    expect(r.bestDeal).toBeNull();
  });

  it("excludes discarded ads from alert totals and top alerts", async () => {
    const wl = makeWatchlist({ id: "wl-discarded", name: "Discarded WL" });
    await db.saveWatchlist(wl);

    const t0 = Date.now() - 3600_000;
    await db.bulkSaveAds([
      {
        id: "kept-red",
        mergeFn: () =>
          makeAd({
            id: "kept-red",
            list_id: "wl-discarded",
            alert_tier: "red",
            pct_below_market: 25,
            seen_at: t0,
          }),
      },
      {
        id: "discarded-red",
        mergeFn: () =>
          makeAd({
            id: "discarded-red",
            list_id: "wl-discarded",
            alert_tier: "red",
            pct_below_market: 60,
            is_discarded: true,
            seen_at: t0,
          }),
      },
    ]);

    const report = await reporter.buildReport({
      from: t0 - 10_000,
      to: Date.now() + 10_000,
      watchlistIds: ["wl-discarded"],
    });

    expect(report.alerts.total).toBe(1);
    expect(report.alerts.red).toBe(1);
    expect(report.bestDeal?.id).toBe("kept-red");
    expect(report.topAlerts).toHaveLength(1);
  });
});

describe("toHTML / toText", () => {
  const mkReport = (over = {}) => ({
    from: 0,
    to: 0,
    period: "01 jan – 07 jan",
    alerts: { total: 3, red: 2, orange: 1 },
    purchases: { count: 1, total_spend: 100, total_revenue: 150, profit: 50 },
    bestDeal: null,
    watchlistNames: ["Switch"],
    topAlerts: [{ title: "Switch OLED", price: 200, pct: -25, watchlist: "Switch" }],
    topPurchases: [{ title: "P1", buy: 100, sell: 150, profit: 50 }],
    ...over,
  });

  it("HTML includes KPI values and an HTML5 doctype", () => {
    const html = reporter.toHTML(mkReport());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Switch OLED");
    expect(html).toMatch(/Profit/);
  });
  it("HTML escapes injected script tags", () => {
    const html = reporter.toHTML(
      mkReport({
        topAlerts: [{ title: "<script>alert(1)</script>", price: 10, pct: -5, watchlist: "x" }],
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("text stays ≤ 1800 chars", () => {
    const longReport = mkReport({
      topAlerts: Array.from({ length: 50 }, (_, i) => ({
        title: "x".repeat(80),
        price: i,
        pct: -5,
        watchlist: "w",
      })),
    });
    expect(reporter.toText(longReport).length).toBeLessThanOrEqual(1800);
  });
  it("text contains negative-profit sign", () => {
    const txt = reporter.toText(
      mkReport({ purchases: { count: 1, total_spend: 200, total_revenue: 100, profit: -100 } }),
    );
    expect(txt).toContain("-100€");
  });
});

describe("openMailto — recipient sanitisation", () => {
  it("encodes stray ? (no hijacking of mailto query)", () => {
    const spy = vi.spyOn(chrome.tabs, "create");
    reporter.openMailto("user?subject=pwn@example.com", {
      period: "p",
      alerts: { red: 0, orange: 0 },
      purchases: { count: 0, total_spend: 0, profit: 0 },
      topAlerts: [],
      topPurchases: [],
    });
    const url = spy.mock.calls.at(-1)[0].url;
    // The question mark that precedes `subject=` must be the one we control.
    // user-provided ? should have been encoded.
    expect(url).toMatch(/^mailto:user%3Fsubject%3Dpwn@example\.com\?subject=/);
    spy.mockRestore();
  });
  it("encodes CR/LF to prevent header injection", () => {
    const spy = vi.spyOn(chrome.tabs, "create");
    reporter.openMailto("a@b.com\r\nBcc: evil@x.com", {
      period: "p",
      alerts: { red: 0, orange: 0 },
      purchases: { count: 0, total_spend: 0, profit: 0 },
      topAlerts: [],
      topPurchases: [],
    });
    const url = spy.mock.calls.at(-1)[0].url;
    expect(url).not.toContain("\r");
    expect(url).not.toContain("\n");
    expect(url).toContain("%0D%0A");
    spy.mockRestore();
  });
});

describe("sendViaEmailJS", () => {
  const report = {
    period: "p",
    alerts: { red: 0, orange: 0 },
    purchases: { count: 0, total_spend: 0, profit: 0 },
    topAlerts: [],
    topPurchases: [],
  };
  it("throws on incomplete config", async () => {
    await expect(reporter.sendViaEmailJS({}, report)).rejects.toThrow(/incomplete/);
    await expect(reporter.sendViaEmailJS({ service_id: "s", template_id: "t" }, report)).rejects.toThrow(/incomplete/);
  });
  it("POSTs to the EmailJS endpoint on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 });
    await reporter.sendViaEmailJS({ service_id: "s", template_id: "t", user_id: "u", email: "a@b.com" }, report);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.emailjs.com/api/v1.0/email/send",
      expect.objectContaining({ method: "POST" }),
    );
    fetchSpy.mockRestore();
  });
  it("throws on non-2xx response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 });
    await expect(
      reporter.sendViaEmailJS({ service_id: "s", template_id: "t", user_id: "u", email: "a@b.com" }, report),
    ).rejects.toThrow(/500/);
    fetchSpy.mockRestore();
  });
});

// ── buildReport — all-orange alerts (bestDeal should be null) ────────────────

describe("buildReport — all orange alerts (no bestDeal)", () => {
  it("bestDeal is null when all alerted ads are orange (not red)", async () => {
    const wl = makeWatchlist({ id: "wl-orange", name: "Test WL" });
    await db.saveWatchlist(wl);

    const t0 = Date.now() - 3600_000;
    // Save only orange-tier ads
    const ad1 = makeAd({ id: "o1", list_id: "wl-orange", alert_tier: "orange", pct_below_market: 8, seen_at: t0 });
    const ad2 = makeAd({ id: "o2", list_id: "wl-orange", alert_tier: "orange", pct_below_market: 10, seen_at: t0 });
    await db.bulkSaveAds([ad1, ad2].map((a) => ({ id: a.id, mergeFn: () => a })));

    const report = await reporter.buildReport({ from: t0 - 1000, to: Date.now(), watchlistIds: ["wl-orange"] });
    expect(report.alerts.orange).toBe(2);
    expect(report.alerts.red).toBe(0);
    expect(report.bestDeal).toBeNull();
  });

  it("topAlerts contains only red ads (orange excluded from top list)", async () => {
    const wl = makeWatchlist({ id: "wl-mix", name: "Mix WL" });
    await db.saveWatchlist(wl);

    const t0 = Date.now() - 3600_000;
    const red = makeAd({ id: "r1", list_id: "wl-mix", alert_tier: "red", pct_below_market: 20, seen_at: t0 });
    const org = makeAd({ id: "o3", list_id: "wl-mix", alert_tier: "orange", pct_below_market: 5, seen_at: t0 });
    await db.bulkSaveAds([red, org].map((a) => ({ id: a.id, mergeFn: () => a })));

    const report = await reporter.buildReport({ from: t0 - 1000, to: Date.now(), watchlistIds: ["wl-mix"] });
    expect(report.topAlerts).toHaveLength(1);
    expect(report.topAlerts[0].id ?? report.topAlerts[0].ad_id ?? report.bestDeal?.id).toBe("r1");
  });
});

// ── toHTML / toText — empty topAlerts / topPurchases ────────────────────────

describe("toHTML / toText — empty arrays", () => {
  const emptyReport = () => ({
    from: 0,
    to: 0,
    period: "01 jan – 07 jan",
    alerts: { total: 0, red: 0, orange: 0 },
    purchases: { count: 0, total_spend: 0, total_revenue: 0, profit: 0 },
    bestDeal: null,
    watchlistNames: [],
    topAlerts: [],
    topPurchases: [],
  });

  it("toHTML renders without crashing when topAlerts is empty", () => {
    expect(() => reporter.toHTML(emptyReport())).not.toThrow();
    const html = reporter.toHTML(emptyReport());
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("toText renders without crashing when topAlerts is empty", () => {
    expect(() => reporter.toText(emptyReport())).not.toThrow();
    const txt = reporter.toText(emptyReport());
    expect(typeof txt).toBe("string");
  });

  it("toHTML renders without crashing when topPurchases is empty", () => {
    const html = reporter.toHTML(emptyReport());
    // Should still produce valid HTML output
    expect(html.length).toBeGreaterThan(100);
  });
});
