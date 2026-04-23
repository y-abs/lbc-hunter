// Tier 2 — cursors: getAlertedAds, getAdsFeed, purgeOldAds, getRecentAlerts

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";
import { makeAd } from "../helpers/factories.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

const DAY = 86_400_000;

describe("getAlertedAds", () => {
  it("returns only ads with is_alerted=true, newest first", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "1", mergeFn: () => makeAd({ id: "1", is_alerted: true, seen_at: now - 3000 }) },
      { id: "2", mergeFn: () => makeAd({ id: "2", is_alerted: false, seen_at: now - 2000 }) },
      { id: "3", mergeFn: () => makeAd({ id: "3", is_alerted: true, seen_at: now - 1000 }) },
    ]);
    const alerts = await db.getAlertedAds(10);
    expect(alerts.map((a) => a.id)).toEqual(["3", "1"]);
  });

  it("honours the limit", async () => {
    const now = Date.now();
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `a${i}`,
      mergeFn: () => makeAd({ id: `a${i}`, is_alerted: true, seen_at: now - i * 100 }),
    }));
    await db.bulkSaveAds(entries);
    const first5 = await db.getAlertedAds(5);
    expect(first5).toHaveLength(5);
  });

  it("excludes discarded ads even when alerted", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "keep", mergeFn: () => makeAd({ id: "keep", is_alerted: true, seen_at: now - 1000 }) },
      { id: "drop", mergeFn: () => makeAd({ id: "drop", is_alerted: true, is_discarded: true, seen_at: now }) },
    ]);
    const alerts = await db.getAlertedAds(10);
    expect(alerts.map((a) => a.id)).toEqual(["keep"]);
  });
});

describe("getRecentAlerts", () => {
  it("returns only alerted, non-discarded ads", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "a1", mergeFn: () => makeAd({ id: "a1", is_alerted: true, seen_at: now - 3000 }) },
      { id: "a2", mergeFn: () => makeAd({ id: "a2", is_alerted: false, seen_at: now - 2000 }) },
      { id: "a3", mergeFn: () => makeAd({ id: "a3", is_alerted: true, is_discarded: true, seen_at: now - 1000 }) },
    ]);
    const rows = await db.getRecentAlerts(10);
    expect(rows.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("getAdsFeed", () => {
  it("filters by cutoffMs", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "old", mergeFn: () => makeAd({ id: "old", seen_at: now - 2 * DAY }) },
      { id: "new", mergeFn: () => makeAd({ id: "new", seen_at: now }) },
    ]);
    const feed = await db.getAdsFeed(now - DAY, null, 50, 0);
    expect(feed.map((a) => a.id)).toEqual(["new"]);
  });

  it("filters by watchlist_id", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "a", mergeFn: () => makeAd({ id: "a", list_id: "wl-1", seen_at: now - 100 }) },
      { id: "b", mergeFn: () => makeAd({ id: "b", list_id: "wl-2", seen_at: now - 50 }) },
    ]);
    const feed = await db.getAdsFeed(0, "wl-1", 50, 0);
    expect(feed).toHaveLength(1);
    expect(feed[0].id).toBe("a");
  });

  it("paginates via offset + limit", async () => {
    const now = Date.now();
    await db.bulkSaveAds(
      Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        mergeFn: () => makeAd({ id: `p${i}`, seen_at: now - i }),
      })),
    );
    const p1 = await db.getAdsFeed(0, null, 3, 0);
    const p2 = await db.getAdsFeed(0, null, 3, 3);
    expect(p1).toHaveLength(3);
    expect(p2).toHaveLength(3);
    expect(p1.map((a) => a.id)).not.toEqual(p2.map((a) => a.id));
  });

  it("excludes discarded ads from feed", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "visible", mergeFn: () => makeAd({ id: "visible", seen_at: now - 100 }) },
      { id: "discarded", mergeFn: () => makeAd({ id: "discarded", is_discarded: true, seen_at: now - 50 }) },
    ]);
    const feed = await db.getAdsFeed(0, null, 50, 0);
    expect(feed.map((a) => a.id)).toEqual(["visible"]);
  });
});

describe("purgeOldAds — user-flag preservation", () => {
  it("deletes ads older than cutoff", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "stale", mergeFn: () => makeAd({ id: "stale", indexed_at: now - 40 * DAY, seen_at: now - 40 * DAY }) },
      { id: "fresh", mergeFn: () => makeAd({ id: "fresh", indexed_at: now, seen_at: now }) },
    ]);
    const n = await db.purgeOldAds(30 * DAY);
    expect(n).toBe(1);
    expect(await db.getAd("stale")).toBeUndefined();
    expect(await db.getAd("fresh")).toBeDefined();
  });

  it("never purges is_flagged or is_purchased (user-curated)", async () => {
    const now = Date.now();
    await db.bulkSaveAds([
      { id: "flag", mergeFn: () => makeAd({ id: "flag", indexed_at: now - 40 * DAY, is_flagged: true }) },
      { id: "bought", mergeFn: () => makeAd({ id: "bought", indexed_at: now - 40 * DAY, is_purchased: true }) },
      { id: "expire", mergeFn: () => makeAd({ id: "expire", indexed_at: now - 40 * DAY }) },
    ]);
    await db.purgeOldAds(30 * DAY);
    expect(await db.getAd("flag")).toBeDefined();
    expect(await db.getAd("bought")).toBeDefined();
    expect(await db.getAd("expire")).toBeUndefined();
  });

  it("falls back to seen_at on legacy records lacking indexed_at", async () => {
    const now = Date.now();
    const legacy = makeAd({ id: "legacy", seen_at: now - 40 * DAY });
    delete legacy.indexed_at;
    await db.saveAd(legacy);
    const n = await db.purgeOldAds(30 * DAY);
    expect(n).toBe(1);
  });
});
