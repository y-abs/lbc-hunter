// Tier 2 — getPurchasesInPeriod: three-way timestamp fallback
// (purchased_at | buy_date | created_at) so manually-added dashboard
// purchases appear in email/weekly reports alongside automator rows.

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";
import { makePurchase } from "../helpers/factories.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

describe("getPurchasesInPeriod — timestamp field fallback", () => {
  const t = 1_700_000_000_000;

  it("filters by purchased_at (automator path)", async () => {
    await db.savePurchase(makePurchase({ id: "p1", purchased_at: t, buy_date: undefined }));
    const inside = await db.getPurchasesInPeriod(t - 1, t + 1);
    const outside = await db.getPurchasesInPeriod(t + 100, t + 200);
    expect(inside.find((p) => p.id === "p1")).toBeDefined();
    expect(outside.find((p) => p.id === "p1")).toBeUndefined();
  });

  it("falls back to buy_date when purchased_at is missing (manual dashboard add)", async () => {
    // Drop purchased_at so the fallback clause is exercised.
    const p = makePurchase({ id: "p2", buy_date: t });
    delete p.purchased_at;
    await db.savePurchase(p);
    const hit = await db.getPurchasesInPeriod(t - 1, t + 1);
    expect(hit.find((x) => x.id === "p2")).toBeDefined();
  });

  it("falls back to created_at as last resort", async () => {
    const p = makePurchase({ id: "p3", created_at: t });
    delete p.purchased_at;
    delete p.buy_date;
    await db.savePurchase(p);
    const hit = await db.getPurchasesInPeriod(t - 1, t + 1);
    expect(hit.find((x) => x.id === "p3")).toBeDefined();
  });

  it("excludes purchases with all three timestamps missing (ts=0)", async () => {
    const p = { id: "p4", title: "x", buy_price: 10 };
    await db.savePurchase(p);
    const hit = await db.getPurchasesInPeriod(1, Number.MAX_SAFE_INTEGER);
    expect(hit.find((x) => x.id === "p4")).toBeUndefined();
  });
});

describe("getPurchasesByAdId — idempotency guard", () => {
  it("returns all purchases for an ad, newest first", async () => {
    await db.savePurchase(makePurchase({ id: "p1", ad_id: "999", purchased_at: 1000 }));
    await db.savePurchase(makePurchase({ id: "p2", ad_id: "999", purchased_at: 2000 }));
    await db.savePurchase(makePurchase({ id: "p3", ad_id: "888", purchased_at: 1500 }));
    const hits = await db.getPurchasesByAdId("999");
    expect(hits.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("returns empty array when no purchases match", async () => {
    const r = await db.getPurchasesByAdId("nope");
    expect(r).toEqual([]);
  });
});
