// Tier 3 — content-db-proxy fallback contract: EVERY failure path must
// return the operation's declared default type (never null-for-array),
// since callers spread / .map() / .length these without null-checks.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAd, getWatchlist, getLatestMarketStats, getPriceHistory, getAlertedAds } from "@/db/content-db-proxy.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("content-db-proxy — fallback on SW failure", () => {
  it("getAd returns null when sendMessage rejects", async () => {
    vi.spyOn(chrome.runtime, "sendMessage").mockRejectedValue(new Error("SW asleep"));
    expect(await getAd("x")).toBeNull();
  });

  it("getAlertedAds returns [] (not null!) when sendMessage rejects", async () => {
    vi.spyOn(chrome.runtime, "sendMessage").mockRejectedValue(new Error("no SW"));
    const r = await getAlertedAds(10);
    expect(r).toEqual([]);
    expect(Array.isArray(r)).toBe(true); // callers iterate
  });

  it("getPriceHistory returns [] when SW responds with ok:false", async () => {
    vi.spyOn(chrome.runtime, "sendMessage").mockResolvedValue({ ok: false, error: "boom" });
    const r = await getPriceHistory("switch", "30", 30);
    expect(r).toEqual([]);
  });

  it("array ops return [] when SW returns result:null", async () => {
    vi.spyOn(chrome.runtime, "sendMessage").mockResolvedValue({ ok: true, result: null });
    expect(await getAlertedAds(5)).toEqual([]);
    expect(await getPriceHistory("k", "30", 5)).toEqual([]);
  });

  it("object ops return null when SW returns result:null", async () => {
    vi.spyOn(chrome.runtime, "sendMessage").mockResolvedValue({ ok: true, result: null });
    expect(await getAd("x")).toBeNull();
    expect(await getWatchlist("wl")).toBeNull();
    expect(await getLatestMarketStats("k", "30")).toBeNull();
  });

  it("passes op + args verbatim to the SW", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage").mockResolvedValue({ ok: true, result: [] });
    await getPriceHistory("nintendo", "30", 90);
    expect(spy).toHaveBeenCalledWith({
      type: "DB_QUERY",
      op: "getPriceHistory",
      args: ["nintendo", "30", 90],
    });
  });

  it("preserves a valid non-null result", async () => {
    const ad = { id: "a1", price: [100] };
    vi.spyOn(chrome.runtime, "sendMessage").mockResolvedValue({ ok: true, result: ad });
    expect(await getAd("a1")).toEqual(ad);
  });
});
