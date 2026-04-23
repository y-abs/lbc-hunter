// Tier 2 — IDB CRUD functions not covered elsewhere:
//   patchAd, getRecentAlerts, importAllData (security), addToBlacklist /
//   removeFromBlacklist, deleteTemplate, deletePurchase, getStorageEstimate.

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";
import { makeAd } from "../helpers/factories.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

// ── patchAd ────────────────────────────────────────────────────────────────────

describe("patchAd", () => {
  it("merges patch fields into the existing record", async () => {
    await db.saveAd(makeAd({ id: "p1", price: [200], notes: "" }));
    await db.patchAd("p1", { notes: "called seller", is_flagged: true });
    const ad = await db.getAd("p1");
    expect(ad.notes).toBe("called seller");
    expect(ad.is_flagged).toBe(true);
    expect(ad.price).toEqual([200]); // untouched
  });

  it("is a no-op when the ad does not exist", async () => {
    await expect(db.patchAd("nonexistent", { notes: "x" })).resolves.toBeUndefined();
  });

  it("does not overwrite fields not included in the patch", async () => {
    await db.saveAd(makeAd({ id: "p2", is_alerted: true, is_messaged: true }));
    await db.patchAd("p2", { notes: "y" });
    const ad = await db.getAd("p2");
    expect(ad.is_alerted).toBe(true);
    expect(ad.is_messaged).toBe(true);
  });
});

// ── getRecentAlerts ────────────────────────────────────────────────────────────

describe("getRecentAlerts", () => {
  it("returns only ads with is_alerted=true, newest first", async () => {
    const now = Date.now();
    await db.saveAd(makeAd({ id: "r1", is_alerted: true, seen_at: now - 3000 }));
    await db.saveAd(makeAd({ id: "r2", is_alerted: false, seen_at: now - 2000 }));
    await db.saveAd(makeAd({ id: "r3", is_alerted: true, seen_at: now - 1000 }));
    const alerts = await db.getRecentAlerts(10);
    expect(alerts.map((a) => a.id)).toEqual(["r3", "r1"]);
  });

  it("honours the limit", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      await db.saveAd(makeAd({ id: `rl${i}`, is_alerted: true, seen_at: now - i * 100 }));
    }
    const alerts = await db.getRecentAlerts(3);
    expect(alerts).toHaveLength(3);
  });

  it("returns empty array when no alerted ads exist", async () => {
    await db.saveAd(makeAd({ id: "rnone", is_alerted: false }));
    const alerts = await db.getRecentAlerts(10);
    expect(alerts).toEqual([]);
  });
});

// ── importAllData ─────────────────────────────────────────────────────────────

describe("importAllData — security & correctness", () => {
  it("imports valid records into allowed stores", async () => {
    const ad = makeAd({ id: "imp1" });
    await db.importAllData({ ads: [ad] });
    const stored = await db.getAd("imp1");
    expect(stored?.id).toBe("imp1");
  });

  it("SILENTLY SKIPS the session store (blocks api_key injection)", async () => {
    await db.importAllData({
      session: [{ id: "current", api_key: "attacker-key", user_agent: "evil/1.0" }],
    });
    const session = await db.getSession();
    expect(session).toBeFalsy();
  });

  it("skips unknown store names without throwing", async () => {
    await expect(db.importAllData({ totally_fake_store: [{ id: "x" }] })).resolves.toBeUndefined();
  });

  it("skips non-array store payloads without throwing", async () => {
    await expect(db.importAllData({ ads: "not an array" })).resolves.toBeUndefined();
    // Existing data untouched
    const all = await db.dbGetAll("ads");
    expect(all).toEqual([]);
  });

  it("skips non-object rows within a valid store", async () => {
    await db.importAllData({ ads: ["not-an-object", null, 42, makeAd({ id: "good1" })] });
    const stored = await db.getAd("good1");
    expect(stored?.id).toBe("good1");
  });

  it("throws on invalid top-level payload (non-object)", async () => {
    await expect(db.importAllData(null)).rejects.toThrow("Invalid import payload");
    await expect(db.importAllData([1, 2, 3])).rejects.toThrow("Invalid import payload");
    await expect(db.importAllData("string")).rejects.toThrow("Invalid import payload");
  });

  it("exportAllData NEVER includes the session store", async () => {
    await db.saveSession("secret-key", "UA/1.0");
    const exported = await db.exportAllData();
    expect(Object.keys(exported)).not.toContain("session");
  });

  it("export → import round-trips ads faithfully", async () => {
    const ad = makeAd({ id: "rtt1", notes: "important note" });
    await db.saveAd(ad);
    const exported = await db.exportAllData();
    // Fresh DB
    const db2 = await freshIdbModule();
    await db2.importAllData(exported);
    const restored = await db2.getAd("rtt1");
    expect(restored?.notes).toBe("important note");
  });
});

// ── addToBlacklist / removeFromBlacklist ─────────────────────────────────────

describe("blacklist CRUD", () => {
  it("addToBlacklist persists the entry", async () => {
    await db.addToBlacklist("seller-42", "spammer");
    expect(await db.isBlacklisted("seller-42")).toBe(true);
  });

  it("removeFromBlacklist deletes the entry", async () => {
    await db.addToBlacklist("seller-99", "bot");
    await db.removeFromBlacklist("seller-99");
    expect(await db.isBlacklisted("seller-99")).toBe(false);
  });

  it("removeFromBlacklist is a no-op for a non-existent entry", async () => {
    await expect(db.removeFromBlacklist("never-added")).resolves.toBeUndefined();
  });

  it("getBlacklist returns all entries", async () => {
    await db.addToBlacklist("s1", "reason1");
    await db.addToBlacklist("s2", "reason2");
    const list = await db.getBlacklist();
    expect(list.map((e) => e.seller_id).sort()).toEqual(["s1", "s2"]);
  });

  it("addToBlacklist stores reason and added_at", async () => {
    const before = Date.now();
    await db.addToBlacklist("s3", "fraud");
    const entry = (await db.getBlacklist()).find((e) => e.seller_id === "s3");
    expect(entry.reason).toBe("fraud");
    expect(entry.added_at).toBeGreaterThanOrEqual(before);
  });
});

// ── deleteTemplate ────────────────────────────────────────────────────────────

describe("deleteTemplate", () => {
  it("removes the template by id", async () => {
    await db.saveTemplate({ id: "tpl-del", name: "ToDelete", body: "Hi" });
    await db.deleteTemplate("tpl-del");
    const templates = await db.dbGetAll("templates");
    expect(templates.find((t) => t.id === "tpl-del")).toBeUndefined();
  });

  it("is a no-op when the template does not exist", async () => {
    await expect(db.deleteTemplate("nonexistent-tpl")).resolves.toBeUndefined();
  });
});

// ── deletePurchase ────────────────────────────────────────────────────────────

describe("deletePurchase", () => {
  it("removes the purchase by id", async () => {
    await db.savePurchase({ id: "pur-1", ad_id: "a1", buy_price: 100 });
    await db.deletePurchase("pur-1");
    const purchases = await db.getPurchases();
    expect(purchases.find((p) => p.id === "pur-1")).toBeUndefined();
  });

  it("is a no-op when the purchase does not exist", async () => {
    await expect(db.deletePurchase("ghost-pur")).resolves.toBeUndefined();
  });
});

// ── getStorageEstimate ────────────────────────────────────────────────────────
// getStorageEstimate uses `navigator.storage.estimate()` which is a browser
// Web API. In the Vitest Node environment, `navigator` is undefined. We stub
// it per test to exercise both the happy path and the graceful-fallback path.

describe("getStorageEstimate", () => {
  function withNavigatorMock(mockValue) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: mockValue,
    });
    return () => {
      if (original) {
        Object.defineProperty(globalThis, "navigator", original);
        return;
      }
      delete globalThis.navigator;
    };
  }

  it("returns { usage, quota } when navigator.storage.estimate is available", async () => {
    const restore = withNavigatorMock({
      storage: { estimate: () => Promise.resolve({ usage: 1024, quota: 5_000_000 }) },
    });
    try {
      const est = await db.getStorageEstimate();
      expect(typeof est?.usage).toBe("number");
      expect(typeof est?.quota).toBe("number");
    } finally {
      restore();
    }
  });

  it("returns null when navigator.storage is absent", async () => {
    const restore = withNavigatorMock({}); // no .storage property
    try {
      const est = await db.getStorageEstimate();
      expect(est).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null when navigator.storage.estimate is absent", async () => {
    const restore = withNavigatorMock({ storage: {} }); // .estimate undefined
    try {
      const est = await db.getStorageEstimate();
      expect(est).toBeNull();
    } finally {
      restore();
    }
  });
});
