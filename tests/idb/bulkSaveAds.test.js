// Tier 2 — bulkSaveAds atomicity + user-flag preservation

import { describe, it, expect, beforeEach } from "vitest";
import { freshIdbModule } from "../helpers/fresh-modules.js";
import { makeAd } from "../helpers/factories.js";

let db;
beforeEach(async () => {
  db = await freshIdbModule();
});

describe("bulkSaveAds", () => {
  it("persists all entries in a single transaction", async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: `ad-${i}`, mergeFn: () => makeAd({ id: `ad-${i}` }) }));
    await db.bulkSaveAds(entries);
    const all = await db.dbGetAll("ads");
    expect(all).toHaveLength(50);
  });

  it("no-ops on empty array", async () => {
    await expect(db.bulkSaveAds([])).resolves.toBeUndefined();
  });

  it("mergeFn receives undefined for new ads", async () => {
    const seenExisting = [];
    await db.bulkSaveAds([
      {
        id: "a-new",
        mergeFn: (existing) => {
          seenExisting.push(existing);
          return makeAd({ id: "a-new" });
        },
      },
    ]);
    expect(seenExisting).toEqual([undefined]);
  });

  it("mergeFn receives the current record for updates", async () => {
    await db.saveAd(makeAd({ id: "a-upd", is_flagged: true, price: [100] }));
    let seen;
    await db.bulkSaveAds([
      {
        id: "a-upd",
        mergeFn: (existing) => {
          seen = existing;
          return { ...existing, price: [200] };
        },
      },
    ]);
    expect(seen?.is_flagged).toBe(true);
    expect(seen?.price).toEqual([100]);
    const after = await db.getAd("a-upd");
    expect(after.price).toEqual([200]);
    expect(after.is_flagged).toBe(true); // preserved by mergeFn
  });

  it("supports preserving user flags pattern (is_flagged, is_messaged, is_purchased)", async () => {
    await db.saveAd(makeAd({ id: "a-1", is_flagged: true, is_messaged: true, is_purchased: true }));
    // Re-poll merges: caller's mergeFn must preserve user flags.
    await db.bulkSaveAds([
      {
        id: "a-1",
        mergeFn: (e) => ({
          ...makeAd({ id: "a-1", price: [999] }),
          is_flagged: e?.is_flagged ?? false,
          is_messaged: e?.is_messaged ?? false,
          is_purchased: e?.is_purchased ?? false,
        }),
      },
    ]);
    const after = await db.getAd("a-1");
    expect(after.is_flagged).toBe(true);
    expect(after.is_messaged).toBe(true);
    expect(after.is_purchased).toBe(true);
    expect(after.price).toEqual([999]);
  });
});
