// Tier 3 — _updateLiteNotifs serialisation: concurrent mutators must
// see each other's writes (no lost-update races on lite_purchase_notifs).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { _updateLiteNotifs } from "@/core/notifier.js";

beforeEach(() => {
  // The module-level lock persists across tests; reset the storage area.
  if (chrome?.storage?.session?.__reset) chrome.storage.session.__reset();
});

describe("_updateLiteNotifs — serialisation", () => {
  it("N parallel adders all persist (no lost updates)", async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        _updateLiteNotifs((map) => {
          map[`notif-${i}`] = { adId: `a${i}`, watchlistId: "wl-1" };
          return map;
        }),
      ),
    );
    const { lite_purchase_notifs } = await chrome.storage.session.get("lite_purchase_notifs");
    expect(Object.keys(lite_purchase_notifs)).toHaveLength(N);
  });

  it("mutators run in FIFO order even when the read step is slow", async () => {
    const order = [];
    const slowGet = chrome.storage.session.get;
    let calls = 0;
    // Slow down the first get() so the second mutator queues.
    chrome.storage.session.get = async (keys) => {
      const myCall = ++calls;
      if (myCall === 1) await new Promise((r) => setTimeout(r, 20));
      return slowGet.call(chrome.storage.session, keys);
    };
    try {
      const p1 = _updateLiteNotifs((m) => {
        order.push("first");
        m.a = 1;
        return m;
      });
      const p2 = _updateLiteNotifs((m) => {
        order.push("second");
        m.b = 2;
        return m;
      });
      await Promise.all([p1, p2]);
    } finally {
      chrome.storage.session.get = slowGet;
    }
    expect(order).toEqual(["first", "second"]);
    const { lite_purchase_notifs } = await chrome.storage.session.get("lite_purchase_notifs");
    expect(lite_purchase_notifs).toEqual({ a: 1, b: 2 });
  });

  it("mutator returning null skips the set() call", async () => {
    const spy = vi.spyOn(chrome.storage.session, "set");
    await _updateLiteNotifs(() => null);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a swallowed storage error does not break subsequent calls (lock released)", async () => {
    const original = chrome.storage.session.get;
    chrome.storage.session.get = () => Promise.reject(new Error("session-offline"));
    await _updateLiteNotifs((m) => {
      m.doomed = true;
      return m;
    }); // must not throw
    chrome.storage.session.get = original;
    await _updateLiteNotifs((m) => {
      m.recovered = true;
      return m;
    });
    const { lite_purchase_notifs } = await chrome.storage.session.get("lite_purchase_notifs");
    expect(lite_purchase_notifs?.recovered).toBe(true);
  });
});
