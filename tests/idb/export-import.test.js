// Tier 2 — export/import security: SESSION exclusion + malicious payloads.

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";
import { makeAd, makeWatchlist, makePurchase } from "../helpers/factories.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

describe("exportAllData", () => {
  it("excludes the session store (no api_key leak)", async () => {
    await db.saveSession("SECRET_API_KEY", "UA/1.0");
    await db.saveWatchlist(makeWatchlist({ id: "wl-1" }));
    const exp = await db.exportAllData();
    expect(exp.session).toBeUndefined();
    expect(
      Object.values(exp)
        .flat()
        .some((v) => v && typeof v === "object" && JSON.stringify(v).includes("SECRET_API_KEY")),
    ).toBe(false);
    expect(exp.watchlists).toHaveLength(1);
  });

  it("round-trips all non-session stores", async () => {
    await db.saveWatchlist(makeWatchlist({ id: "wl-1" }));
    await db.saveAd(makeAd({ id: "a1" }));
    await db.savePurchase(makePurchase({ id: "p1" }));
    await db.addToBlacklist("seller-x", "scam");
    const exp = await db.exportAllData();
    expect(exp.watchlists.map((w) => w.id)).toContain("wl-1");
    expect(exp.ads.map((a) => a.id)).toContain("a1");
    expect(exp.purchases.map((p) => p.id)).toContain("p1");
    expect(exp.blacklist.map((b) => b.seller_id)).toContain("seller-x");
  });
});

describe("importAllData — security", () => {
  it("rejects malicious session injection (no api_key hijacking)", async () => {
    await db.importAllData({
      session: [{ id: "sess", api_key: "ATTACKER_KEY", user_agent: "evil" }],
    });
    const sess = await db.getSession();
    // The session store must not have been populated by the import.
    expect(sess?.api_key).not.toBe("ATTACKER_KEY");
  });

  it("rejects unknown stores silently (no crash)", async () => {
    await expect(db.importAllData({ __proto__: [{ id: "x" }], bogus: [] })).resolves.toBeUndefined();
  });

  it("skips non-object records inside otherwise valid payloads", async () => {
    await db.importAllData({
      ads: [null, "string", 42, [], makeAd({ id: "real" })],
    });
    const all = await db.dbGetAll("ads");
    expect(all.map((a) => a.id)).toEqual(["real"]);
  });

  it("rejects non-object payloads", async () => {
    await expect(db.importAllData(null)).rejects.toThrow(/Invalid import/);
    await expect(db.importAllData([])).rejects.toThrow(/Invalid import/);
    await expect(db.importAllData("str")).rejects.toThrow(/Invalid import/);
  });

  it("skips malformed store entries (non-arrays)", async () => {
    await expect(db.importAllData({ ads: "not-an-array" })).resolves.toBeUndefined();
    const all = await db.dbGetAll("ads");
    expect(all).toEqual([]);
  });

  it("imports valid payloads across multiple stores", async () => {
    await db.importAllData({
      watchlists: [makeWatchlist({ id: "wl-imp" })],
      blacklist: [{ seller_id: "b1", reason: "test", added_at: 1 }],
    });
    const wls = await db.getWatchlists();
    expect(wls.find((w) => w.id === "wl-imp")).toBeDefined();
    expect(await db.isBlacklisted("b1")).toBe(true);
  });
});
