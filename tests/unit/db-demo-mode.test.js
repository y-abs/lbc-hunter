import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// This is a new test file for the IndexedDB demo mode feature.
// I will add tests here to cover the gaps identified in the audit.

// Mock the 'idb' library, which is the core dependency for indexeddb.js
vi.mock("idb", () => ({
  openDB: vi.fn(),
}));

import { openDB } from "idb";
import { setDemoMode, getWatchlists, getPurchases, getRecentAlerts, getAdsFeed } from "@/db/indexeddb.js";
import { DEMO_ALERTS, DEMO_FEED, DEMO_PURCHASES, DEMO_WATCHLISTS } from "@/db/demo-data.js";

describe("indexeddb.js - Demo Mode", () => {
  const mockDb = {
    getAll: vi.fn(),
    getAllFromIndex: vi.fn(),
  };

  beforeEach(() => {
    vi.resetAllMocks();
    openDB.mockResolvedValue(mockDb);
  });

  afterEach(() => {
    setDemoMode(false); // Ensure demo mode is off between tests
  });

  it("should return demo watchlists when demo mode is enabled", async () => {
    setDemoMode(true);
    const watchlists = await getWatchlists();
    expect(watchlists).toEqual(DEMO_WATCHLISTS);
    expect(openDB).not.toHaveBeenCalled();
  });

  it("should return demo purchases when demo mode is enabled", async () => {
    setDemoMode(true);
    const purchases = await getPurchases();
    expect(purchases).toEqual(DEMO_PURCHASES);
    expect(openDB).not.toHaveBeenCalled();
  });

  it("should return demo recent alerts when demo mode is enabled", async () => {
    setDemoMode(true);
    const alerts = await getRecentAlerts();
    expect(alerts).toEqual(DEMO_ALERTS.filter((t) => t.is_alerted));
    expect(openDB).not.toHaveBeenCalled();
  });

  it("should return demo ads feed when demo mode is enabled", async () => {
    setDemoMode(true);
    const ads = await getAdsFeed(0, null, 10, 0);
    expect(ads).toEqual(DEMO_FEED.slice(0, 10));
    expect(openDB).not.toHaveBeenCalled();
  });

  it("should call the real database when demo mode is disabled", async () => {
    setDemoMode(false);
    mockDb.getAll.mockResolvedValueOnce([{ id: "real-wl", name: "Real Watchlist" }]);
    const watchlists = await getWatchlists();
    expect(watchlists).toEqual([{ id: "real-wl", name: "Real Watchlist" }]);
    expect(openDB).toHaveBeenCalled();
  });
});
