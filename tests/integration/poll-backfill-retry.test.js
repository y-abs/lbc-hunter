import { vi, describe, it, expect, beforeEach } from "vitest";
import { pollWatchlist } from "@/core/poller.js";
import * as idb from "@/db/indexeddb.js";
import { warn } from "@/shared/utils.js";

// Mock dependencies
vi.mock("@/db/indexeddb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSession: vi.fn(),
    dbGet: vi.fn(),
    saveWatchlist: vi.fn(),
    bulkSaveAds: vi.fn().mockResolvedValue(undefined),
    updateMarketStats: vi.fn().mockResolvedValue(undefined),
    savePriceHistory: vi.fn().mockResolvedValue(undefined),
    adExists: vi.fn().mockResolvedValue(false),
    getMarketStats: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("@/shared/utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    swKeepAlive: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    warn: vi.fn(),
    adUrl: (id) => `http://ad.url/${id}`,
    resolveShipping: () => ({ enabled: false, cost: null }),
  };
});

vi.mock("@/core/notifier.js", () => ({
  fireAlert: vi.fn(),
}));

vi.mock("@/core/automator.js", () => ({
  sendAutoMessage: vi.fn(),
  autoOpenAdTab: vi.fn(),
}));

// Mock the entire chrome API
const chrome = {
  tabs: {
    query: vi.fn().mockResolvedValue([{ id: 1, discarded: false }]),
    sendMessage: vi.fn((_tabId, message, callback) => {
      if (message.type === "PING") {
        callback({ pong: true });
      } else if (message.type === "EXECUTE_FETCH") {
        // This will be overridden in tests
        callback({ ok: true, data: { ads: [] } });
      }
    }),
  },
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  alarms: {
    create: vi.fn(),
  },
  runtime: {
    lastError: null,
    sendMessage: vi.fn(),
  },
};

global.chrome = chrome;

describe("poller.js - Backfill Retry Loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idb.getSession.mockResolvedValue({ api_key: "test_key" });
  });

  it("should retry a failed page fetch during backfill and succeed", async () => {
    const watchlist = {
      id: 1,
      name: "Test",
      enabled: true,
      pending_backfill_days: 7,
      backfill_days: 7,
      keywords: "test",
    };
    idb.dbGet.mockResolvedValue(watchlist);

    let fetchAttempts = 0;
    chrome.tabs.sendMessage.mockImplementation((_tabId, message, callback) => {
      if (message.type === "PING") {
        return callback({ pong: true });
      }
      if (message.type !== "EXECUTE_FETCH") return;

      const body = JSON.parse(message.options?.body || "{}");
      if ((body.offset ?? 0) === 0) {
        // Page 0
        return callback({
          ok: true,
          data: { ads: [{ list_id: 1, subject: "Ad 1", first_publication_date: new Date().toISOString() }] },
        });
      }
      if (body.offset === 35) {
        // Page 1
        fetchAttempts++;
        if (fetchAttempts === 1) {
          // Fail first time
          return callback({ ok: false, error: "FETCH_FAILED" });
        }
        // Succeed second time
        return callback({
          ok: true,
          data: { ads: [{ list_id: 2, subject: "Ad 2", first_publication_date: new Date().toISOString() }] },
        });
      }
      // Subsequent pages are empty
      return callback({ ok: true, data: { ads: [] } });
    });

    await pollWatchlist(watchlist);

    // Assert retry path was exercised at least once
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Backfill"));

    // Assert success
    expect(idb.bulkSaveAds).toHaveBeenCalled();
    const savedAds = idb.bulkSaveAds.mock.calls[0][0];
    expect(savedAds.length).toBe(2); // Both ads from page 0 and page 1 saved

    // Assert pending_backfill_days is cleared
    const finalSaveCall = idb.saveWatchlist.mock.calls.find((call) => Object.hasOwn(call[0], "pending_backfill_days"));
    expect(finalSaveCall[0].pending_backfill_days).toBe(0);
  });

  it("should preserve pending_backfill_days if a page fetch fails all retries", async () => {
    const watchlist = {
      id: 1,
      name: "Test",
      enabled: true,
      pending_backfill_days: 7,
      backfill_days: 7,
      keywords: "test",
    };
    idb.dbGet.mockResolvedValue(watchlist);

    let _fetchAttempts = 0;
    const _BACKFILL_PAGE_RETRIES = 2; // from poller.js

    chrome.tabs.sendMessage.mockImplementation((_tabId, message, callback) => {
      if (message.type === "PING") {
        return callback({ pong: true });
      }
      if (message.type !== "EXECUTE_FETCH") return;

      const body = JSON.parse(message.options?.body || "{}");
      if ((body.offset ?? 0) === 0) {
        // Page 0 succeeds
        return callback({
          ok: true,
          data: { ads: [{ list_id: 1, subject: "Ad 1", first_publication_date: new Date().toISOString() }] },
        });
      }
      if (body.offset === 35) {
        // Page 1 fails all attempts
        _fetchAttempts++;
        return callback({ ok: false, error: "FETCH_FAILED" });
      }
      // Subsequent pages are not reached
      return callback({ ok: true, data: { ads: [] } });
    });

    await pollWatchlist(watchlist);

    // Assert retry/failure path emitted warnings
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Backfill"));

    // Assert partial save
    expect(idb.bulkSaveAds).toHaveBeenCalled();
    const savedAds = idb.bulkSaveAds.mock.calls[0][0];
    expect(savedAds.length).toBe(1); // Only ad from page 0

    // Assert pending_backfill_days is PRESERVED
    const finalSaveCall = idb.saveWatchlist.mock.calls.find((call) => Object.hasOwn(call[0], "pending_backfill_days"));
    expect(finalSaveCall[0].pending_backfill_days).toBe(watchlist.pending_backfill_days);

    // Assert error is broadcast
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "backfill_error",
        reason: "page_failed",
      }),
    );
  });
});
