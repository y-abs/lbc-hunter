// ─────────────────────────────────────────────
//  LbC Hunter — Content-script DB proxy
//
//  Chrome content scripts live in an isolated JS world but share the page's
//  origin for Web Storage APIs (IndexedDB, localStorage, Cache). A content
//  script on leboncoin.fr that opens IndexedDB under `lbc-hunter-db`
//  reads a DIFFERENT database than the service worker's extension-origin DB.
//
//  This module proxies reads through the SW via chrome.runtime.sendMessage
//  so all content-script features (badges, sidebar, ad-page chart) see the
//  same data the SW writes. Read-only — writes remain SW-owned (poller,
//  automator, dashboard).
// ─────────────────────────────────────────────

import { MSG } from "@/shared/messages.js";

// Internal round-trip. `defaultValue` is returned on ANY failure path:
//   • SW asleep / wakeup fails
//   • Extension context invalidated (user reloaded the extension)
//   • Message port closed before response
//   • Dispatcher op error (unknown op, IDB failure)
// Critically, the default MUST match the operation's return TYPE. Callers do
// `[...result].sort()`, `.length`, `.map()` — a `null` fallback blows up every
// array-consuming path with "not iterable" / "Cannot read properties of null".
// Keep defaults in sync with the SW DB_QUERY dispatcher's return contract.
async function _dbQuery(op, args, defaultValue) {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.DB_QUERY, op, args });
    if (!res?.ok) return defaultValue;
    // result may legitimately be `undefined` (getAd miss) — preserve as default type
    return res.result == null ? defaultValue : res.result;
  } catch {
    return defaultValue;
  }
}

// Object / single-record ops → null fallback (callers already `?.`-chain these)
export const getAd = (id) => _dbQuery("getAd", [id], null);
export const getWatchlist = (id) => _dbQuery("getWatchlist", [id], null);
export const getLatestMarketStats = (keyword, category_id) =>
  _dbQuery("getLatestMarketStats", [keyword, category_id], null);

// Array ops → [] fallback — NEVER null. Callers spread/iterate/`.length` these.
export const getPriceHistory = (keyword, category_id, limit) =>
  _dbQuery("getPriceHistory", [keyword, category_id, limit], []);
export const getAlertedAds = (limit) => _dbQuery("getAlertedAds", [limit], []);
