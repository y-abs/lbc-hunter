import { vi, describe, it, expect, beforeEach } from "vitest";
import { fireAlert } from "@/core/notifier.js";

let soundPref = "both";

global.chrome = {
  notifications: {
    create: vi.fn((id, _options, callback) => {
      if (typeof callback === "function") callback(id);
      return Promise.resolve(id);
    }),
    clear: vi.fn(() => Promise.resolve(true)),
    onButtonClicked: { addListener: vi.fn() },
    onClicked: { addListener: vi.fn() },
    onClosed: { addListener: vi.fn() },
  },
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve()),
  },
  action: {
    setBadgeText: vi.fn(() => Promise.resolve()),
    setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
  },
  storage: {
    session: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve(undefined)),
      remove: vi.fn(() => Promise.resolve(undefined)),
    },
    local: {
      get: vi.fn(() => Promise.resolve({ sound_pref: soundPref })),
    },
  },
  offscreen: {
    createDocument: vi.fn(() => Promise.resolve()),
  },
  tabs: {
    create: vi.fn(() => Promise.resolve({ id: 1 })),
  },
};

describe("notifier.js - fireAlert shipping display", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    soundPref = "both";
  });

  const ad = {
    id: "123",
    title: "Test Ad",
    price: 120,
    url: "https://www.lbc.fr/ad/collection/123",
    images: ["image.jpg"],
  };

  const watchlist = {
    id: 1,
    name: "Test Watchlist",
    purchase_mode: "off",
  };

  it("displays total price when shipping_cost is available", async () => {
    const matchResult = {
      is_match: true,
      alert_tier: "red",
      is_shipping: true,
      shipping_cost: 8,
      estimated_total: 128,
      pct_below_market: 10,
    };

    await fireAlert(ad, watchlist, matchResult);

    const notificationOptions = chrome.notifications.create.mock.calls[0][1];
    expect(notificationOptions.message).toContain("120€ + 8€ livraison = 128€");
  });

  it("displays shipping availability when shipping_cost is null", async () => {
    const matchResult = {
      is_match: true,
      alert_tier: "red",
      is_shipping: true,
      shipping_cost: null,
      pct_below_market: 10,
    };

    await fireAlert(ad, watchlist, matchResult);

    const notificationOptions = chrome.notifications.create.mock.calls[0][1];
    expect(notificationOptions.message).toContain("120€ 🚚 livraison dispo");
  });

  it("does not display shipping info when is_shipping is false", async () => {
    const matchResult = {
      is_match: true,
      alert_tier: "red",
      is_shipping: false,
      shipping_cost: null,
      pct_below_market: 10,
    };

    await fireAlert(ad, watchlist, matchResult);

    const notificationOptions = chrome.notifications.create.mock.calls[0][1];
    expect(notificationOptions.message).not.toContain("livraison");
    expect(notificationOptions.message).toContain("120€");
  });
});

describe("notifier.js - playAlertSound preferences", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    chrome.storage.local.get.mockImplementation(() => Promise.resolve({ sound_pref: soundPref }));
    chrome.notifications.create.mockImplementation((id, _options, callback) => {
      if (typeof callback === "function") callback(id);
      return Promise.resolve(id);
    });
  });

  const ad = { id: "123", title: "Test Ad", price: 120, url: "https://www.lbc.fr/ad/collection/123" };
  const watchlist = { id: 1, name: "Test Watchlist", purchase_mode: "off" };
  const redMatch = { is_match: true, alert_tier: "red" };
  const orangeMatch = { is_match: true, alert_tier: "orange" };

  it("does not play sound if sound_pref is none", async () => {
    soundPref = "none";
    await fireAlert(ad, watchlist, redMatch);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "PLAY_SOUND" }));
  });

  it("does not play sound for orange tier if sound_pref is red", async () => {
    soundPref = "red";
    await fireAlert(ad, watchlist, orangeMatch);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "PLAY_SOUND" }));
  });

  it("plays sound for red tier if sound_pref is red", async () => {
    soundPref = "red";
    await fireAlert(ad, watchlist, redMatch);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "PLAY_SOUND", tier: "red" });
  });

  it("plays sound for orange tier if sound_pref is both/default", async () => {
    soundPref = "both";
    await fireAlert(ad, watchlist, orangeMatch);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "PLAY_SOUND", tier: "orange" });
  });

  it("plays sound for red tier if sound_pref is both/default", async () => {
    soundPref = "both";
    await fireAlert(ad, watchlist, redMatch);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "PLAY_SOUND", tier: "red" });
  });
});
