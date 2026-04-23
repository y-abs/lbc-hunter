import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanupProxyPollTab, fetchViaContentScript } from "@/core/poller.js";
import * as idb from "@/db/indexeddb.js";
import { swKeepAlive } from "@/shared/utils.js";

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

vi.mock("@/shared/utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    swKeepAlive: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    warn: vi.fn(),
  };
});

// Mock the entire chrome API
const chrome = {
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
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
  },
};

global.chrome = chrome;

describe("poller.js - Proxy Tab Lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore session.get to a default empty state for each test
    chrome.storage.session.get.mockResolvedValue({});
    idb.getSession.mockResolvedValue({ api_key: "test_key", user_agent: "test_agent" });
    idb.dbGet.mockResolvedValue({ id: 1, name: "Test Watchlist", enabled: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("_getPollTabId:step3 — should reuse cached proxy-tab if it is alive", async () => {
    const PROXY_TAB_ID = 999;
    const PROXY_TAB_SESSION_KEY = "poll_proxy_tab_id";

    // 1. Mock session to return a cached proxy tab ID
    chrome.storage.session.get.mockResolvedValue({ [PROXY_TAB_SESSION_KEY]: PROXY_TAB_ID });

    // 2. Mock tabs.query to return no user tabs
    chrome.tabs.query.mockResolvedValue([]);

    // 3. Mock tabs.get for the cached tab to return a valid, non-discarded tab
    chrome.tabs.get.mockResolvedValue({ id: PROXY_TAB_ID, discarded: false });

    // 4. Mock sendMessage for ping to succeed
    chrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      if (tabId === PROXY_TAB_ID && message.type === "PING") {
        callback({ pong: true });
      } else if (message.type === "EXECUTE_FETCH") {
        callback({ ok: true, data: { ads: [] } });
      }
    });

    // 5. Call a function that uses _getPollTabId
    await fetchViaContentScript("http://test.com");

    // 6. Assert that tabs.get and the ping were called for the proxy tab
    expect(chrome.tabs.get).toHaveBeenCalledWith(PROXY_TAB_ID);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(PROXY_TAB_ID, { type: "PING" }, expect.any(Function));

    // 7. Assert that the cleanup alarm was reset
    expect(chrome.alarms.create).toHaveBeenCalledWith("proxy-poll-tab-cleanup", { delayInMinutes: 10 });

    // 8. Assert a new tab was NOT created
    expect(chrome.tabs.create).not.toHaveBeenCalled();

    // 9. Assert the fetch was sent through the proxy tab
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      PROXY_TAB_ID,
      expect.objectContaining({ type: "EXECUTE_FETCH" }),
      expect.any(Function),
    );
  });

  it("_getPollTabId:step4 — should open, load, and use a new background tab", async () => {
    const NEW_PROXY_TAB_ID = 1001;
    const PROXY_TAB_SESSION_KEY = "poll_proxy_tab_id";

    // 1. Mock no user tabs and no cached proxy tab
    chrome.tabs.query.mockResolvedValue([]);
    chrome.storage.session.get.mockResolvedValue({});

    // 2. Mock tab creation
    chrome.tabs.create.mockResolvedValue({ id: NEW_PROXY_TAB_ID });

    // 3. Mock tab loading sequence
    let getTabCalls = 0;
    chrome.tabs.get.mockImplementation(async (tabId) => {
      if (tabId === NEW_PROXY_TAB_ID) {
        getTabCalls++;
        if (getTabCalls <= 2) {
          return { id: NEW_PROXY_TAB_ID, status: "loading" };
        }
        return { id: NEW_PROXY_TAB_ID, status: "complete" };
      }
      return null;
    });

    // 4. Mock ping to succeed only after load
    chrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      if (tabId === NEW_PROXY_TAB_ID && message.type === "PING") {
        // Only respond pong if tab is "loaded"
        if (getTabCalls > 2) {
          callback({ pong: true });
        } else {
          callback(null); // Simulate content script not ready
        }
      } else if (message.type === "EXECUTE_FETCH") {
        callback({ ok: true, data: { ads: [] } });
      }
    });

    // 5. Call function that triggers tab creation
    await fetchViaContentScript("http://test.com");

    // 6. Assertions
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://www.leboncoin.fr/", active: false });
    expect(chrome.storage.session.set).toHaveBeenCalledWith({ [PROXY_TAB_SESSION_KEY]: NEW_PROXY_TAB_ID });
    expect(chrome.tabs.update).toHaveBeenCalledWith(NEW_PROXY_TAB_ID, { autoDiscardable: false });

    // Assert loading poll loop
    expect(swKeepAlive).toHaveBeenCalled(); // swKeepAlive is called inside the loop
    expect(chrome.tabs.get).toHaveBeenCalledWith(NEW_PROXY_TAB_ID);
    expect(getTabCalls).toBeGreaterThan(1);

    // Assert ping after load
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(NEW_PROXY_TAB_ID, { type: "PING" }, expect.any(Function));

    // Assert fetch sent via new tab
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      NEW_PROXY_TAB_ID,
      expect.objectContaining({ type: "EXECUTE_FETCH" }),
      expect.any(Function),
    );

    // Assert cleanup alarm created
    expect(chrome.alarms.create).toHaveBeenCalledWith("proxy-poll-tab-cleanup", { delayInMinutes: 10 });
  });

  it("cleanupProxyPollTab — should remove the tab and clear session storage", async () => {
    const PROXY_TAB_ID = 1002;
    const PROXY_TAB_SESSION_KEY = "poll_proxy_tab_id";

    // 1. Mock session storage to contain a proxy tab ID
    chrome.storage.session.get.mockResolvedValue({ [PROXY_TAB_SESSION_KEY]: PROXY_TAB_ID });

    // 2. Call the cleanup function
    await cleanupProxyPollTab();

    // 3. Assertions
    expect(chrome.tabs.remove).toHaveBeenCalledWith(PROXY_TAB_ID);
    expect(chrome.storage.session.remove).toHaveBeenCalledWith(PROXY_TAB_SESSION_KEY);
  });

  it("cleanupProxyPollTab — should do nothing if no proxy tab is stored", async () => {
    // 1. Mock session storage to be empty
    chrome.storage.session.get.mockResolvedValue({});

    // 2. Call the cleanup function
    await cleanupProxyPollTab();

    // 3. Assertions
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(chrome.storage.session.remove).not.toHaveBeenCalled();
  });
});
