// Tier 3 — DB_QUERY dispatcher security: only allowlisted ops can be
// invoked; anything else returns { ok: false, error: 'unknown db op' }.
// We boot the real SW against the chrome mock + fake-IDB, then dispatch
// messages through chrome.runtime.__dispatch so the production listener
// handles them end-to-end.

import { describe, it, expect, beforeEach } from "vitest";
import { freshModules } from "../helpers/fresh-modules.js";
import { makeAd, makeWatchlist } from "../helpers/factories.js";

let mods;

beforeEach(async () => {
  // global setup.js runs resetChromeMock() FIRST (wiping listeners), then
  // we re-import the SW so its onMessage listener attaches against the
  // fresh chrome mock + fresh IDB.
  mods = await freshModules(["@/background/service-worker.js"]);
  await mods.db.saveWatchlist(makeWatchlist({ id: "wl-1" }));
  await mods.db.saveAd(makeAd({ id: "ad-1", is_alerted: true }));
});

async function dispatch(msg) {
  return chrome.runtime.__dispatch(msg);
}

describe("DB_QUERY dispatcher — allowlist", () => {
  it("accepts getAd", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: "getAd", args: ["ad-1"] });
    expect(r.ok).toBe(true);
    expect(r.result?.id).toBe("ad-1");
  });

  it("accepts getWatchlist", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: "getWatchlist", args: ["wl-1"] });
    expect(r.ok).toBe(true);
    expect(r.result?.id).toBe("wl-1");
  });

  it("accepts getAlertedAds", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: "getAlertedAds", args: [10] });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.result)).toBe(true);
  });

  it("accepts getLatestMarketStats", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: "getLatestMarketStats", args: ["switch", "30"] });
    expect(r.ok).toBe(true);
    // No data seeded → null is a valid response
    expect(r.result).toBeNull();
  });

  it("accepts getPriceHistory", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: "getPriceHistory", args: ["switch", "30", 30] });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.result)).toBe(true);
  });

  it("REJECTS non-allowlisted ops (deleteAd)", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: "deleteAd", args: ["ad-1"] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown db op/);
    // Guarantee the op didn't actually run — ad still there.
    const check = await dispatch({ type: "DB_QUERY", op: "getAd", args: ["ad-1"] });
    expect(check.result?.id).toBe("ad-1");
  });

  it("REJECTS writes (saveAd, deleteWatchlist, savePurchase, clearAll)", async () => {
    for (const op of ["saveAd", "deleteWatchlist", "savePurchase", "clearAll", "addToBlacklist"]) {
      const r = await dispatch({ type: "DB_QUERY", op, args: [] });
      expect(r.ok, `op=${op} must be rejected`).toBe(false);
    }
  });

  it("REJECTS prototype-pollution style ops", async () => {
    for (const op of ["__proto__", "constructor", "toString", "valueOf"]) {
      const r = await dispatch({ type: "DB_QUERY", op, args: [] });
      expect(r.ok, `op=${op}`).toBe(false);
    }
  });

  it("coerces getAd arg to string (defence in depth)", async () => {
    // Production line: `await getAd(String(args[0]))`
    const r = await dispatch({ type: "DB_QUERY", op: "getAd", args: [{ toString: () => "ad-1" }] });
    expect(r.ok).toBe(true);
    expect(r.result?.id).toBe("ad-1");
  });

  it("handles missing args array (non-array msg.args)", async () => {
    const r = await dispatch({ type: "DB_QUERY", op: "getAlertedAds" }); // no args at all
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.result)).toBe(true);
  });

  it("unknown top-level message type returns { ok: false }", async () => {
    const r = await dispatch({ type: "NOT_A_REAL_MESSAGE" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown message type/);
  });
});
