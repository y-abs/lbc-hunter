// Tier 2 — Additional IDB function coverage:
//   adExists, getEnabledWatchlists, markAdAlerted, markAdMessaged,
//   getAdsInPeriod (filter + no-filter), exportAllData (session exclusion)

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";
import { makeAd, makeWatchlist } from "../helpers/factories.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

// ── adExists ──────────────────────────────────────────────────────────────────

describe("adExists", () => {
  it("returns true for an existing ad", async () => {
    await db.saveAd(makeAd({ id: "exist-1" }));
    expect(await db.adExists("exist-1")).toBe(true);
  });

  it("returns false for a missing ad", async () => {
    expect(await db.adExists("ghost-999")).toBe(false);
  });

  it("coerces numeric id to string", async () => {
    await db.saveAd(makeAd({ id: "42" }));
    expect(await db.adExists(42)).toBe(true);
  });
});

// ── getEnabledWatchlists ──────────────────────────────────────────────────────

describe("getEnabledWatchlists", () => {
  it("returns only enabled watchlists", async () => {
    await db.saveWatchlist(makeWatchlist({ id: "wl-on", enabled: true }));
    await db.saveWatchlist(makeWatchlist({ id: "wl-off", enabled: false }));
    const result = await db.getEnabledWatchlists();
    const ids = result.map((w) => w.id);
    expect(ids).toContain("wl-on");
    expect(ids).not.toContain("wl-off");
  });

  it("returns empty array when all watchlists are disabled", async () => {
    await db.saveWatchlist(makeWatchlist({ id: "wl-a", enabled: false }));
    await db.saveWatchlist(makeWatchlist({ id: "wl-b", enabled: false }));
    expect(await db.getEnabledWatchlists()).toHaveLength(0);
  });

  it("returns empty array when no watchlists exist", async () => {
    expect(await db.getEnabledWatchlists()).toHaveLength(0);
  });
});

// ── markAdAlerted ─────────────────────────────────────────────────────────────

describe("markAdAlerted", () => {
  it("sets is_alerted=true on the existing ad", async () => {
    await db.saveAd(makeAd({ id: "alrt-1", is_alerted: false }));
    await db.markAdAlerted("alrt-1");
    const ad = await db.getAd("alrt-1");
    expect(ad.is_alerted).toBe(true);
  });

  it("merges extra fields passed as second argument", async () => {
    await db.saveAd(makeAd({ id: "alrt-2" }));
    await db.markAdAlerted("alrt-2", { alert_tier: "red", pct_below_market: 22 });
    const ad = await db.getAd("alrt-2");
    expect(ad.alert_tier).toBe("red");
    expect(ad.pct_below_market).toBe(22);
  });

  it("preserves unrelated fields after merge", async () => {
    await db.saveAd(makeAd({ id: "alrt-3", subject: "keep me", price: [333] }));
    await db.markAdAlerted("alrt-3", { alert_tier: "orange" });
    const ad = await db.getAd("alrt-3");
    expect(ad.subject).toBe("keep me");
    expect(ad.price).toEqual([333]);
  });

  it("is a no-op when ad does not exist", async () => {
    await expect(db.markAdAlerted("phantom", {})).resolves.toBeUndefined();
  });
});

// ── markAdMessaged ────────────────────────────────────────────────────────────

describe("markAdMessaged", () => {
  it("sets is_messaged=true on the existing ad", async () => {
    await db.saveAd(makeAd({ id: "msg-1", is_messaged: false }));
    await db.markAdMessaged("msg-1");
    const ad = await db.getAd("msg-1");
    expect(ad.is_messaged).toBe(true);
  });

  it("is a no-op when ad does not exist", async () => {
    await expect(db.markAdMessaged("phantom-msg")).resolves.toBeUndefined();
  });

  it("does not affect other boolean flags", async () => {
    await db.saveAd(makeAd({ id: "msg-2", is_alerted: true, is_flagged: true }));
    await db.markAdMessaged("msg-2");
    const ad = await db.getAd("msg-2");
    expect(ad.is_alerted).toBe(true);
    expect(ad.is_flagged).toBe(true);
  });
});

// ── getAdsInPeriod ────────────────────────────────────────────────────────────

describe("getAdsInPeriod", () => {
  const base = Date.now();

  it("returns all ads in range when no watchlistIds filter given", async () => {
    await db.saveAd(makeAd({ id: "ap-1", seen_at: base - 1000, list_id: "wl-A" }));
    await db.saveAd(makeAd({ id: "ap-2", seen_at: base - 500, list_id: "wl-B" }));
    await db.saveAd(makeAd({ id: "ap-3", seen_at: base + 500, list_id: "wl-A" })); // after toMs
    const result = await db.getAdsInPeriod(base - 2000, base);
    const ids = result.map((a) => a.id);
    expect(ids).toContain("ap-1");
    expect(ids).toContain("ap-2");
    expect(ids).not.toContain("ap-3");
  });

  it("filters by watchlistIds when provided", async () => {
    await db.saveAd(makeAd({ id: "ap-4", seen_at: base - 100, list_id: "wl-X" }));
    await db.saveAd(makeAd({ id: "ap-5", seen_at: base - 100, list_id: "wl-Y" }));
    const result = await db.getAdsInPeriod(base - 1000, base + 1000, ["wl-X"]);
    const ids = result.map((a) => a.id);
    expect(ids).toContain("ap-4");
    expect(ids).not.toContain("ap-5");
  });

  it("returns empty array when no ads fall within range", async () => {
    await db.saveAd(makeAd({ id: "ap-6", seen_at: base + 5000, list_id: "wl-Z" }));
    const result = await db.getAdsInPeriod(base - 1000, base - 500);
    expect(result).toHaveLength(0);
  });
});

// ── exportAllData — session store exclusion ───────────────────────────────────

describe("exportAllData session exclusion", () => {
  it("never includes the session store in the exported payload", async () => {
    // Save a session record with a fake api_key — this must NEVER leave the device
    await db.saveSession("super-secret-api-key", "TestAgent/1.0");
    const exported = await db.exportAllData();
    // The keys of the export must not include any session store name
    const keys = Object.keys(exported);
    expect(keys).not.toContain("session");
    // Ensure no object value contains the api_key string either
    const asJson = JSON.stringify(exported);
    expect(asJson).not.toContain("super-secret-api-key");
  });

  it("still exports other stores", async () => {
    await db.saveAd(makeAd({ id: "exp-1" }));
    const exported = await db.exportAllData();
    const keys = Object.keys(exported);
    expect(keys.length).toBeGreaterThan(0);
    // ads store should be present
    expect(keys.some((k) => k === "ads")).toBe(true);
  });
});
