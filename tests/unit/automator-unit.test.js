// Tier 2 — automator.js unit tests:
//   • attemptCheckout: idempotency guard, full-auto gates (kill-switch, budget,
//     daily spend), tab-closed/timeout outcomes
//   • SW onButtonClicked lite-buy (buttonIndex=1 + 'alert-lite-' prefix)
//   • Rate-limit counter reset: expired hour/day windows reset before comparing

import { describe, it, expect, beforeEach, vi } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeAd, makeWatchlist, makePurchase } from "../helpers/factories.js";

let db, automator;

// Allow async chains to settle (no fake timers — checkout needs real setTimeout)
async function flush(n = 15) {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < n; i++) await Promise.resolve();
}

beforeEach(async () => {
  // Mock the db module using vi.mock
  vi.mock("@/db/indexeddb.js", async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
    };
  });

  const m = await freshModules(["@/core/automator.js"]);
  db = await import("@/db/indexeddb.js");
  automator = m["@/core/automator.js"];

  // Default: tabs.create returns a valid tab object
  chrome.tabs.create = vi.fn(async (opts) => {
    const id = 42;
    return { id, url: opts.url, active: opts.active ?? true, status: "loading" };
  });
  // Default: scripting.executeScript resolves (no-op)
  chrome.scripting.executeScript = vi.fn(async () => [{ result: {} }]);
});

// ── attemptCheckout — idempotency guard ──────────────────────────────────────

describe("attemptCheckout — idempotency guard", () => {
  it("returns false if a recent pending purchase already exists for the ad", async () => {
    const ad = makeAd({ id: "idem-1", price: [200] });
    const wl = makeWatchlist({ id: "wl-idem" });
    await db.saveAd(ad);
    // Pre-save a pending purchase within the 5-min dedup window
    await db.savePurchase(
      makePurchase({
        ad_id: "idem-1",
        status: "pending",
        purchased_at: Date.now() - 30_000, // 30s ago
      }),
    );

    const result = await automator.attemptCheckout(ad, "lite", wl);
    expect(result).toBe(false);
    // tabs.create should NOT have been called (guard fired before tab creation)
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("does NOT block if the pending purchase is older than 5 minutes", async () => {
    const ad = makeAd({ id: "idem-2", price: [100] });
    const wl = makeWatchlist({ id: "wl-idem2" });
    await db.saveAd(ad);
    // Old pending purchase: 10 minutes ago — outside the 5-min window
    await db.savePurchase(
      makePurchase({
        ad_id: "idem-2",
        status: "pending",
        purchased_at: Date.now() - 10 * 60_000,
      }),
    );

    chrome.tabs.create = vi.fn(async (opts) => {
      const tab = { id: 55, url: opts.url, active: opts.active ?? true, status: "loading" };
      // Use a 50ms delay to ensure savePurchase+storage.set in attemptCheckout
      // complete and onUpdated listener is registered before we fire the event
      setTimeout(() => chrome.tabs.__fireUpdated(55, { status: "complete" }, { ...tab, status: "complete" }), 50);
      return tab;
    });

    const _result = await automator.attemptCheckout(ad, "lite", wl);
    expect(chrome.tabs.create).toHaveBeenCalled();
  }, 10000);
});

// ── attemptCheckout — full-auto safety gates ─────────────────────────────────

describe("attemptCheckout — full-auto mode=full gates", () => {
  it("returns false when full_auto_paused kill-switch is set", async () => {
    const ad = makeAd({ id: "gate-1", price: [100] });
    const wl = makeWatchlist({ id: "wl-gate" });
    await chrome.storage.session.set({ full_auto_paused: true });

    const result = await automator.attemptCheckout(ad, "full", wl);
    expect(result).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("returns false when price exceeds per-watchlist budget", async () => {
    const ad = makeAd({ id: "gate-2", price: [600] });
    const wl = makeWatchlist({ id: "wl-gate2", purchase_budget_max: 500 });
    await chrome.storage.session.set({ full_auto_paused: false });

    const result = await automator.attemptCheckout(ad, "full", wl);
    expect(result).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("returns false when daily spend cap would be exceeded", async () => {
    const ad = makeAd({ id: "gate-3", price: [200] });
    const wl = makeWatchlist({ id: "wl-gate3", purchase_budget_max: 300 });
    await chrome.storage.session.set({ full_auto_paused: false });
    // daily cap is budget * 3 = 900. Simulate already spent 750.
    await chrome.storage.local.set({
      daily_spend: 750,
      daily_spend_date: new Date().toDateString(),
    });

    const result = await automator.attemptCheckout(ad, "full", wl);
    expect(result).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("lite mode does NOT check kill-switch or budget", async () => {
    const ad = makeAd({ id: "gate-4", price: [9999] });
    const wl = makeWatchlist({ id: "wl-gate4", purchase_budget_max: 10 });
    await chrome.storage.session.set({ full_auto_paused: true });

    // Simulate tab complete so the test doesn't hang 30s
    chrome.tabs.create = vi.fn(async (opts) => {
      const tab = { id: 88, url: opts.url, active: opts.active ?? true, status: "loading" };
      // 50ms delay: ensures savePurchase + storage.set await chain completes and
      // onUpdated listener is registered before the event fires (same pattern as
      // the idem-2 test above — setTimeout(0) races fake-IDB microtasks).
      setTimeout(() => chrome.tabs.__fireUpdated(88, { status: "complete" }, { ...tab, status: "complete" }), 50);
      return tab;
    });

    // Should NOT return false due to kill-switch (lite mode skips gates)
    await automator.attemptCheckout(ad, "lite", wl);
    expect(chrome.tabs.create).toHaveBeenCalled();
  });
});

// ── attemptCheckout — tab outcome: closed ────────────────────────────────────

describe("attemptCheckout — tab outcomes", () => {
  it("returns false and marks purchase rejected when tab is closed", async () => {
    const ad = makeAd({ id: "out-1", price: [150] });
    const wl = makeWatchlist({ id: "wl-out" });
    await db.saveAd(ad);

    chrome.tabs.create = vi.fn(async () => {
      setTimeout(() => chrome.tabs.__fireRemoved(77), 5); // fire close after short delay
      return { id: 77 };
    });

    const result = await automator.attemptCheckout(ad, "lite", wl);
    expect(result).toBe(false);

    // The purchase row should be rejected in IDB
    await flush();
    const purchases = await db.getPurchasesByAdId("out-1");
    expect(purchases.length).toBeGreaterThan(0);
    const rejected = purchases.find((p) => p.status === "rejected");
    expect(rejected).toBeTruthy();
    expect(rejected.reject_reason).toBe("tab_closed");
  });

  it("saves a pending purchase row before awaiting tab load", async () => {
    const ad = makeAd({ id: "out-2", price: [200] });
    const wl = makeWatchlist({ id: "wl-out2" });
    await db.saveAd(ad);

    let tabCreated = false;
    chrome.tabs.create = vi.fn(async (opts) => {
      tabCreated = true;
      const tab = { id: 66, url: opts.url, active: opts.active ?? true, status: "loading" };
      // Fire complete after a short delay so we can check mid-flight state first
      setTimeout(() => chrome.tabs.__fireUpdated(66, { status: "complete" }, { ...tab, status: "complete" }), 20);
      return tab;
    });

    // Start checkout but don't await (we want to check mid-flight state)
    const promise = automator.attemptCheckout(ad, "lite", wl);
    await flush(3); // let tab creation happen

    if (tabCreated) {
      // Purchase row should be saved now (before tab load)
      const purchases = await db.getPurchasesByAdId("out-2");
      expect(purchases.length).toBeGreaterThan(0);
      expect(purchases[0].status).toMatch(/pending/);
    }

    await promise;
  });
});

// ── Rate-limit counter reset on expired window ────────────────────────────────

describe("canSendMessage — rate limit counter resets on expired window", () => {
  it("resets hour counter after hour window expires", async () => {
    const { MAX_MESSAGES_PER_HOUR } = await import("@/shared/constants.js");
    // Set hour count at cap, but with an expired reset window
    await chrome.storage.local.set({
      msg_hour_count: MAX_MESSAGES_PER_HOUR,
      msg_hour_reset: Date.now() - 1000, // expired 1 second ago
      msg_day_count: 0,
      msg_day_reset: Date.now() + 86_400_000,
    });

    // Verify: with an unexpired cap, sendAutoMessage returns false immediately
    const fakeAd2 = makeAd({ id: "ratelimit-fresh" });
    await chrome.storage.local.set({
      msg_hour_count: MAX_MESSAGES_PER_HOUR,
      msg_hour_reset: Date.now() + 3_600_000, // NOT expired
    });
    const blockedResult = await automator.sendAutoMessage(fakeAd2, null);
    expect(blockedResult).toBe(false);

    // Now set an expired window — sendAutoMessage should pass the cap check
    // but return false for a different reason (no LBC tab open is fine)
    await chrome.storage.local.set({
      msg_hour_count: MAX_MESSAGES_PER_HOUR,
      msg_hour_reset: Date.now() - 1000, // expired
    });
    // canSendMessage should return true (window reset) → sendAutoMessage proceeds
    // past the cap check, then fails on "No LBC tab open" — returns false but
    // for a DIFFERENT reason than the cap. We verify by spying on console.warn
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await automator.sendAutoMessage(fakeAd2, null);
    // Should warn about missing LBC tab, NOT about hourly cap
    const warnings = warnSpy.mock.calls.flat().join(" ");
    expect(warnings).toMatch(/tab|template/i);
    expect(warnings).not.toMatch(/cap/i);
    warnSpy.mockRestore();
  });
});

// ── SW onButtonClicked — lite-buy path ───────────────────────────────────────

describe("SW onButtonClicked — lite-buy (buttonIndex=1, alert-lite- prefix)", () => {
  it("calls tabs.create when a valid lite-purchase notif button is clicked", async () => {
    // Load the SW module to register onButtonClicked listener
    const swMods = await freshModules(["@/background/service-worker.js"]);

    const ad = makeAd({ id: "lbuy-1", price: [123] });
    const wl = makeWatchlist({ id: "wl-lbuy" });
    await swMods.db.saveAd(ad);
    await swMods.db.saveWatchlist(wl);

    // Seed the lite_purchase_notifs map in session storage
    const notifId = "alert-lite-lbuy-1";
    await chrome.storage.session.set({
      lite_purchase_notifs: {
        [notifId]: { adId: "lbuy-1", watchlistId: "wl-lbuy" },
      },
    });

    // tabs.create fires onUpdated complete so attemptCheckout resolves
    const createSpy = vi.fn(async (opts) => {
      const tab = { id: 100, url: opts.url, active: opts.active ?? true, status: "loading" };
      setTimeout(() => chrome.tabs.__fireUpdated(100, { status: "complete" }, { ...tab, status: "complete" }), 0);
      return tab;
    });
    chrome.tabs.create = createSpy;

    // Fire the button click — buttonIndex=1 on an 'alert-lite-' notif
    chrome.notifications.__fireButton(notifId, 1);
    await flush();

    await vi.waitFor(() => {
      expect(createSpy).toHaveBeenCalled();
    });
  }, 10000);

  it("does nothing (no tabs.create for checkout) when buttonIndex !== 1", async () => {
    await freshModules(["@/background/service-worker.js"]);
    // buttonIndex=0 is View — notifier.js opens an ad tab (expected behavior)
    // The SW lite-buy handler only acts on buttonIndex===1 + alert-lite- prefix.
    // We verify the SW handler does NOT call tabs.create for a checkout;
    // notifier.js tabs.create for View is unrelated and IS allowed here.
    // Spy on scripting.executeScript (used by checkout) — should NOT be called.
    const execSpy = vi.spyOn(chrome.scripting, "executeScript");
    chrome.notifications.__fireButton("alert-lite-any", 0); // view button
    await flush();
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("does nothing when notifId does not start with alert-lite-", async () => {
    await freshModules(["@/background/service-worker.js"]);
    const createSpy = vi.spyOn(chrome.tabs, "create");
    chrome.notifications.__fireButton("alert-normal-xyz", 1);
    await flush();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("sendAutoMessage — happy path", () => {
  it("should interpolate template, execute script, and mark ad as messaged", async () => {
    const ad = makeAd({
      id: "msg-1",
      title: "Test Ad Title",
      price: 250,
      location: { city: "Paris" },
      seller_id: "seller123",
      owner: { type: "pro", store_id: "seller123", user_id: "seller123", name: "Super Seller" },
    });
    const template = {
      id: "tpl-1",
      name: "Test Template",
      body: 'Bonjour {vendeur}, votre annonce "{titre}" pour {prix}€ est-elle toujours disponible à {ville} ?',
    };
    const lbcTab = { id: 101, url: "https://www.leboncoin.fr/" };

    await db.saveAd(ad);
    await db.saveTemplate(template);
    const markSpy = vi.spyOn(db, "markAdMessaged");

    // Mock chrome APIs
    chrome.tabs.query = vi.fn().mockResolvedValue([{ ...lbcTab, status: "complete" }]);
    const execSpy = vi.spyOn(chrome.scripting, "executeScript");

    const result = await automator.sendAutoMessage(ad, template.id);

    expect(result).toBe(true);

    // 1. LBC tab was found
    expect(chrome.tabs.query).toHaveBeenCalledWith({ url: "*://www.leboncoin.fr/*", status: "complete" });

    // 2. Script was executed with interpolated message
    expect(execSpy).toHaveBeenCalledTimes(1);
    const scriptArgs = execSpy.mock.calls[0][0];
    expect(scriptArgs.target.tabId).toBe(lbcTab.id);
    expect(scriptArgs.args[1]).toContain("Bonjour Super Seller");
    expect(scriptArgs.args[1]).toContain("250€");
    expect(scriptArgs.args[1]).toContain("Paris");

    // 3. Ad was marked as messaged
    expect(markSpy).toHaveBeenCalledWith(ad.id);

    // 4. Rate limit counters were incremented
    const counters = await chrome.storage.local.get(["msg_hour_count", "msg_day_count"]);
    expect(counters.msg_hour_count).toBe(1);
    expect(counters.msg_day_count).toBe(1);
  });
});
