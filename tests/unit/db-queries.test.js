import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("idb", () => ({
  openDB: vi.fn(),
}));

import { openDB } from "idb";
import { __test__, getAdsFeed, purgePriceHistory } from "@/db/indexeddb.js";

function makeCursor(items, { withDelete = false } = {}) {
  let i = 0;
  const cursor = {
    value: items[0] ?? null,
    continue: vi.fn(async () => {
      i += 1;
      if (i >= items.length) return null;
      cursor.value = items[i];
      return cursor;
    }),
  };
  if (withDelete) cursor.delete = vi.fn(async () => undefined);
  return cursor;
}

describe("indexeddb.js - Query Logic", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __test__.reset();
  });

  it("getAdsFeed applies cutoff, watchlist, offset, and limit", async () => {
    const now = Date.now();
    const rows = [
      { id: "3", list_id: "wl-1", seen_at: now - 500 },
      { id: "1", list_id: "wl-1", seen_at: now - 1000 },
      { id: "4", list_id: "wl-2", seen_at: now - 1500 },
      { id: "2", list_id: "wl-1", seen_at: now - 2000 },
      { id: "6", list_id: "wl-1", seen_at: now - 3000 },
    ];

    const firstCursor = makeCursor(rows);
    const tx = {
      store: {
        index: vi.fn(() => ({
          openCursor: vi.fn(async () => firstCursor),
        })),
      },
    };

    openDB.mockResolvedValue({
      transaction: vi.fn(() => tx),
    });

    const result = await getAdsFeed(now - 20_000, "wl-1", 5, 1);

    expect(result.map((r) => r.id)).toEqual(["1", "2", "6"]);
  });

  it("purgePriceHistory deletes rows older than cutoff and returns delete count", async () => {
    const oldRows = [
      { id: "old-1", timestamp: Date.now() - 999_999_999_999 },
      { id: "old-2", timestamp: Date.now() - 888_888_888_888 },
    ];

    const firstCursor = makeCursor(oldRows, { withDelete: true });
    const tx = {
      store: {
        index: vi.fn(() => ({
          openCursor: vi.fn(async () => firstCursor),
        })),
      },
      done: Promise.resolve(),
    };

    openDB.mockResolvedValue({
      transaction: vi.fn(() => tx),
    });

    const deleted = await purgePriceHistory(1_000);

    expect(deleted).toBe(2);
    expect(firstCursor.delete).toHaveBeenCalledTimes(2);
  });
});
