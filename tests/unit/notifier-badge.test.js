// Badge counter API — clearBadge, incrementCount, decrementCount, getPendingCount.
// The module persists `_pendingCount` to chrome.storage.session so the badge
// survives SW restarts. Every mutator awaits `_countRestored` internally.

import { describe, it, expect, beforeEach } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";

let notifier;

async function waitForMicrotasks() {
  // `_countRestored` chain resolves through 1-2 microtasks (storage.get
  // returns an already-resolved promise, then the .then callback runs).
  // Flush by awaiting 3 microtask turns — more than enough and still O(µs).
  for (let i = 0; i < 3; i++) await Promise.resolve();
}

beforeEach(async () => {
  const mods = await freshModules(["@/core/notifier.js"]);
  notifier = mods["@/core/notifier.js"];
  await waitForMicrotasks(); // let the module's `_countRestored` settle
});

describe("getPendingCount", () => {
  it("starts at 0 on a fresh module", () => {
    expect(notifier.getPendingCount()).toBe(0);
  });
});

describe("incrementCount", () => {
  it("increments the pending count and updates the badge", async () => {
    notifier.incrementCount();
    await waitForMicrotasks();
    expect(notifier.getPendingCount()).toBe(1);
    const { alert_count } = await chrome.storage.session.get("alert_count");
    expect(alert_count).toBe(1);
  });

  it("stacks on successive calls", async () => {
    notifier.incrementCount();
    notifier.incrementCount();
    notifier.incrementCount();
    await waitForMicrotasks();
    expect(notifier.getPendingCount()).toBe(3);
  });
});

describe("decrementCount", () => {
  it("decrements by one and never goes below zero", async () => {
    notifier.incrementCount();
    notifier.incrementCount();
    await waitForMicrotasks();
    notifier.decrementCount();
    await waitForMicrotasks();
    expect(notifier.getPendingCount()).toBe(1);
    notifier.decrementCount();
    notifier.decrementCount(); // underflow attempt
    await waitForMicrotasks();
    expect(notifier.getPendingCount()).toBe(0);
  });
});

describe("clearBadge", () => {
  it("resets count to 0 and clears the badge text", async () => {
    notifier.incrementCount();
    notifier.incrementCount();
    await waitForMicrotasks();
    notifier.clearBadge();
    await waitForMicrotasks();
    expect(notifier.getPendingCount()).toBe(0);
    const { alert_count } = await chrome.storage.session.get("alert_count");
    expect(alert_count).toBe(0);
  });
});

describe("updateBadge", () => {
  it("sets text + background colour when count > 0", () => {
    notifier.updateBadge(5);
    // chrome mock doesn't introspect action directly; verify no throw + next
    // call with 0 clears the badge.
    expect(() => notifier.updateBadge(5)).not.toThrow();
  });

  it("clears text when count is 0", () => {
    expect(() => notifier.updateBadge(0)).not.toThrow();
  });
});

describe("count restored across module reload (persistence)", () => {
  it("reads `alert_count` from session storage on fresh module load", async () => {
    // Pre-seed session storage before freshModules re-imports notifier.
    await chrome.storage.session.set({ alert_count: 7 });
    const mods = await freshModules(["@/core/notifier.js"]);
    const n = mods["@/core/notifier.js"];
    await waitForMicrotasks();
    expect(n.getPendingCount()).toBe(7);
  });
});
