import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/db/indexeddb.js", () => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  getWatchlists: vi.fn(),
  getAlertedAds: vi.fn().mockResolvedValue([]),
  getLatestMarketStats: vi.fn().mockResolvedValue(null),
  getPriceHistory: vi.fn().mockResolvedValue([]),
  getAd: vi.fn().mockResolvedValue(null),
  dbGet: vi.fn().mockResolvedValue(null),
  purgePriceHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/poller.js", () => ({
  runPollCycle: vi.fn().mockResolvedValue(undefined),
  pollWatchlist: vi.fn().mockResolvedValue(undefined),
  cleanupProxyPollTab: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/notifier.js", () => ({
  clearBadge: vi.fn(),
  decrementCount: vi.fn(),
  updateBadge: vi.fn(),
  getPendingCount: vi.fn(() => 0),
  _updateLiteNotifs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/automator.js", () => ({
  attemptCheckout: vi.fn().mockResolvedValue(undefined),
}));

const chrome = {
  tabs: {
    query: vi.fn(),
    create: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn().mockResolvedValue(true),
    get: vi.fn((_, cb) => cb(null)),
    onAlarm: {
      addListener: vi.fn(),
    },
  },
  runtime: {
    lastError: null,
    getURL: vi.fn((p) => `chrome-extension://test/${p}`),
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
  },
  notifications: {
    onButtonClicked: { addListener: vi.fn() },
    clear: vi.fn().mockResolvedValue(true),
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
};

global.chrome = chrome;

async function dispatchMessage(msg, sender = {}) {
  const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  return new Promise((resolve) => {
    listener(msg, sender, resolve);
  });
}

describe("service-worker.js alarm flows", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import("@/background/service-worker.js");
  });

  it("creates then cleans pending refresh tab via SESSION_CAPTURED", async () => {
    const { getSession } = await import("@/db/indexeddb.js");
    getSession.mockResolvedValue(null);

    const refreshTabId = 1234;
    chrome.tabs.query.mockResolvedValue([]);
    chrome.tabs.create.mockResolvedValue({ id: refreshTabId });

    const onAlarm = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    await onAlarm({ name: "session-refresh" });

    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://www.leboncoin.fr/", active: false });
    expect(chrome.storage.session.set).toHaveBeenCalledWith({ pending_refresh_tab: refreshTabId });
    expect(chrome.alarms.create).toHaveBeenCalledWith("refresh-tab-timeout", { delayInMinutes: 1 });

    await dispatchMessage({ type: "SESSION_CAPTURED", apiKey: "k", userAgent: "ua" }, { tab: { id: refreshTabId } });

    expect(chrome.tabs.remove).toHaveBeenCalledWith(refreshTabId);
    expect(chrome.alarms.clear).toHaveBeenCalledWith("refresh-tab-timeout");
    expect(chrome.storage.session.remove).toHaveBeenCalledWith("pending_refresh_tab");
  });

  it("checkout-tab-ready closes only hanging full-mode tab", async () => {
    const onAlarm = chrome.alarms.onAlarm.addListener.mock.calls[0][0];

    chrome.storage.session.get.mockResolvedValueOnce({
      checkout_pending_tab: { tabId: 5678, mode: "full" },
    });
    chrome.tabs.get.mockResolvedValueOnce({ id: 5678, status: "loading" });

    await onAlarm({ name: "checkout-tab-ready" });

    expect(chrome.tabs.get).toHaveBeenCalledWith(5678);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(5678);
    expect(chrome.storage.session.remove).toHaveBeenCalledWith("checkout_pending_tab");

    chrome.tabs.remove.mockClear();
    chrome.tabs.get.mockClear();

    chrome.storage.session.get.mockResolvedValueOnce({
      checkout_pending_tab: { tabId: 5678, mode: "lite" },
    });

    await onAlarm({ name: "checkout-tab-ready" });

    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(chrome.storage.session.remove).toHaveBeenCalledWith("checkout_pending_tab");
  });
});
