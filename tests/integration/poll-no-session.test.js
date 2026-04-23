import { vi, describe, it, expect, beforeEach } from "vitest";
import { pollWatchlist } from "@/core/poller.js";
import * as idb from "@/db/indexeddb.js";
import { STORES } from "@/db/schema.js";

// Mock dependencies
vi.mock("@/db/indexeddb.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSession: vi.fn(),
    dbGet: vi.fn(),
    saveWatchlist: vi.fn(),
  };
});

vi.mock("@/shared/utils.js", () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

// Mock the entire chrome API
const chrome = {
  runtime: {
    sendMessage: vi.fn(),
    lastError: null,
  },
};
global.chrome = chrome;

describe("poller.js - No Session Telemetry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should increment consecutive_poll_failures and set last_poll_error on no_session", async () => {
    const initialFailures = 2;
    const watchlist = {
      id: 1,
      name: "Test",
      enabled: true,
      consecutive_poll_failures: initialFailures,
    };

    // 1. Mock no session
    idb.getSession.mockResolvedValue(null);
    // 2. Mock dbGet to return the watchlist
    idb.dbGet.mockResolvedValue(watchlist);

    // 3. Call pollWatchlist
    const result = await pollWatchlist(watchlist);

    // 4. Assertions
    expect(result.status).toBe("no_session");
    expect(idb.dbGet).toHaveBeenCalledWith(STORES.WATCHLISTS, watchlist.id);
    expect(idb.saveWatchlist).toHaveBeenCalledTimes(1);

    const savedWatchlist = idb.saveWatchlist.mock.calls[0][0];
    expect(savedWatchlist.consecutive_poll_failures).toBe(initialFailures + 1);
    expect(savedWatchlist.last_poll_error).toBeDefined();
    expect(savedWatchlist.last_poll_error.message).toBe("no_session");
    expect(savedWatchlist.last_poll_error.at).toBeCloseTo(Date.now(), -3); // within a few ms
    expect(savedWatchlist.last_poll_attempt_at).toBeCloseTo(Date.now(), -3);
  });

  it("should broadcast a backfill_error if a backfill was pending during no_session", async () => {
    const watchlist = {
      id: 1,
      name: "Test",
      enabled: true,
      pending_backfill_days: 5,
    };

    // 1. Mock no session
    idb.getSession.mockResolvedValue(null);
    idb.dbGet.mockResolvedValue(watchlist);

    // 2. Call pollWatchlist
    await pollWatchlist(watchlist);

    // 3. Assertions
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "backfill_error",
        reason: "no_session",
        watchlistId: watchlist.id,
      }),
    );
  });
});
