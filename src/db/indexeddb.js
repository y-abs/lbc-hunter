// ─────────────────────────────────────────────
//  LbC Hunter — IndexedDB abstraction
//  All database access goes through this module.
// ─────────────────────────────────────────────

import { openDB } from "idb";
import { DB_NAME, DB_VERSION, DEFAULT_TEMPLATES, SESSION_TTL_MS } from "@/shared/constants.js";
import { STORES, SCHEMA } from "./schema.js";
import { uuid } from "@/shared/utils.js";
import { DEMO_ALERTS, DEMO_FEED, DEMO_PRICE_HISTORY, DEMO_PURCHASES, DEMO_WATCHLISTS } from "./demo-data.js";

let _db = null;

// ── Demo mode (UI contexts only — never activated in service worker) ──
let _isDemoMode = false;

export function setDemoMode(enabled) {
  _isDemoMode = !!enabled;
}

export function isDemoMode() {
  return _isDemoMode;
}

export function getDemoMode() {
  return _isDemoMode;
}

// --- Demo Mode Interceptors ---

async function _demoInterceptor(storeName, ..._args) {
  switch (storeName) {
    case STORES.WATCHLISTS:
      return DEMO_WATCHLISTS;
    case STORES.PURCHASES:
      return DEMO_PURCHASES;
    case STORES.TELEMETRY:
      // For getRecentAlerts specifically
      return [];
    case STORES.ADS:
      // For getAdsFeed
      return DEMO_FEED;
    default:
      return [];
  }
}

export async function getDb() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      for (const [storeName, config] of Object.entries(SCHEMA)) {
        let store;
        if (!db.objectStoreNames.contains(storeName)) {
          store = db.createObjectStore(storeName, {
            keyPath: config.keyPath,
            autoIncrement: config.autoIncrement ?? false,
          });
        } else {
          store = transaction.objectStore(storeName);
        }
        for (const idx of config.indexes ?? []) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
          }
        }
      }

      // Seed default message templates on fresh install
      if (oldVersion === 0) {
        const tx2 = transaction.objectStore(STORES.TEMPLATES);
        for (const tpl of DEFAULT_TEMPLATES) {
          tx2.add({ id: uuid(), name: tpl.name, body: tpl.body, created_at: Date.now() });
        }
      }

      // v1 → v2: patch existing watchlists with new default fields.
      // Use idb's WRAPPED async cursor (`await tx.objectStore(…).openCursor()`
      // + `await cursor.continue()`) rather than a raw `req.onsuccess`
      // handler: the upgrade transaction commits as soon as the sync part
      // of this callback returns, and raw `onsuccess` callbacks fire AFTER
      // that commit, so `cursor.update(record)` silently no-ops and the
      // migration never actually lands. Awaiting the idb-wrapped cursor
      // keeps the transaction open across continues.
      if (oldVersion === 1) {
        const wlStore = transaction.objectStore(STORES.WATCHLISTS);
        let cursor = await wlStore.openCursor();
        while (cursor) {
          const record = cursor.value;
          let updated = false;
          if (record.shipping_filter === undefined) {
            record.shipping_filter = "any";
            updated = true;
          }
          if (record.purchase_mode === undefined) {
            record.purchase_mode = "off";
            updated = true;
          }
          if (record.purchase_budget_max === undefined) {
            record.purchase_budget_max = 500;
            updated = true;
          }
          if (updated) await cursor.update(record);
          cursor = await cursor.continue();
        }
      }
    },
  });
  return _db;
}

// ── Generic CRUD ──────────────────────────────

export async function dbAdd(storeName, record) {
  const db = await getDb();
  return db.add(storeName, record);
}

export async function dbPut(storeName, record) {
  const db = await getDb();
  return db.put(storeName, record);
}

export async function dbGet(storeName, key) {
  const db = await getDb();
  return db.get(storeName, key);
}

export async function dbGetAll(storeName) {
  const db = await getDb();
  return db.getAll(storeName);
}

export async function dbDelete(storeName, key) {
  const db = await getDb();
  return db.delete(storeName, key);
}

export async function dbClear(storeName) {
  const db = await getDb();
  return db.clear(storeName);
}

export async function dbGetByIndex(storeName, indexName, query) {
  const db = await getDb();
  return db.getAllFromIndex(storeName, indexName, query);
}

export async function dbCount(storeName) {
  const db = await getDb();
  return db.count(storeName);
}

// ── Session ───────────────────────────────────

export async function saveSession(apiKey, userAgent) {
  // Preserve refresh_count across captures
  const existing = await getSession();
  const now = Date.now();
  return dbPut(STORES.SESSION, {
    id: "current",
    api_key: apiKey,
    captured_at: now,
    expires_at: now + SESSION_TTL_MS,
    user_agent: userAgent,
    refresh_count: (existing?.refresh_count ?? 0) + 1,
    last_refresh_at: now,
  });
}

export async function getSession() {
  return dbGet(STORES.SESSION, "current");
}

export async function clearSession() {
  return dbDelete(STORES.SESSION, "current");
}

export async function zeroizeSession(reason = "manual") {
  await clearSession();
  return { ok: true, reason, at: Date.now() };
}

// ── Watchlists ────────────────────────────────

export async function getWatchlists() {
  if (_isDemoMode) return DEMO_WATCHLISTS;
  return dbGetAll(STORES.WATCHLISTS);
}

export async function getEnabledWatchlists() {
  const all = await getWatchlists();
  return all.filter((w) => w.enabled);
}

export async function saveWatchlist(watchlist) {
  if (!watchlist.id) watchlist.id = uuid();
  if (!watchlist.created_at) watchlist.created_at = Date.now();
  return dbPut(STORES.WATCHLISTS, watchlist);
}

export async function deleteWatchlist(id) {
  // Cascade-delete orphan ads for this watchlist so they don't keep
  // surfacing in the dashboard alerts table, popup feed and sidebar with
  // a blank "—" watchlist column after the source search is gone. The
  // ADS store's `list_id` index is keyed by watchlist UUID (ad.list_id),
  // so we can enumerate and purge in a single readwrite transaction.
  // PRESERVED intentionally:
  //   • PURCHASES — profit tracking (user may have bought items from a
  //     now-deleted search; deleting the row would wipe profit history).
  //   • PRICE_HISTORY — keyword-keyed, can be shared across multiple
  //     watchlists with the same keyword and serves the market tab.
  const db = await getDb();
  const tx = db.transaction([STORES.ADS, STORES.WATCHLISTS], "readwrite");
  const adsIx = tx.objectStore(STORES.ADS).index("list_id");
  let cursor = await adsIx.openCursor(IDBKeyRange.only(id));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.objectStore(STORES.WATCHLISTS).delete(id);
  await tx.done;
}

// ── Ads ───────────────────────────────────────

export async function saveAd(ad) {
  return dbPut(STORES.ADS, ad);
}

export async function getAd(id) {
  return dbGet(STORES.ADS, String(id));
}

/**
 * Atomic bulk upsert for ads — single readwrite transaction covers all
 * read-modify-write pairs, so 1400 ads persist in ~1 transaction of
 * serialized IDB work instead of 2800 transactions (one per get + one per
 * put) racing each other. Shrinks the SW-kill vulnerability window during
 * backfill mass-persist by an order of magnitude.
 *
 * @param {Array<{id:string, mergeFn:(existing:Object|undefined)=>Object}>} entries
 *   Each entry provides the ad id (string) and a merge function that
 *   receives the existing record (or undefined) and returns the full record
 *   to persist. The merge function must be SYNCHRONOUS — IDB transactions
 *   auto-close on the next microtask if no pending requests are active,
 *   so any `await` between requests aborts the transaction.
 */
export async function bulkSaveAds(entries) {
  if (!entries.length) return;
  const db = await getDb();
  const tx = db.transaction(STORES.ADS, "readwrite");
  const store = tx.store;
  // Phase 1: fire all reads in parallel (one IDB round-trip for the full batch).
  const existings = await Promise.all(entries.map(({ id }) => store.get(String(id))));
  // Phase 2: compute merged records and queue all puts synchronously within
  // the same microtask continuation. No `await` between the last get settling
  // and the first put being queued, so the IDB transaction cannot auto-commit
  // between phases (IDB only auto-commits when the JS call stack drains to a
  // macrotask — microtask continuations like Promise.all resolutions are safe).
  await Promise.all(entries.map(({ mergeFn }, i) => store.put(mergeFn(existings[i]))));
  await tx.done;
}

export async function patchAd(id, patch) {
  const ad = await getAd(String(id));
  if (!ad) return;
  return saveAd({ ...ad, ...patch });
}

export async function discardAd(id) {
  const ad = await getAd(String(id));
  if (!ad) return false;
  await saveAd({
    ...ad,
    is_discarded: true,
    is_alerted: false,
    is_archived: true,
    discarded_at: Date.now(),
  });
  return true;
}

export async function getRecentAlerts(limit = 30) {
  // Returns the `limit` most recent ADS THAT WERE ALERTED (is_alerted === true).
  //
  // ⚑ The historical implementation returned *every* recent ad regardless of
  // whether it matched any filter. That silently inflated the popup's "Alertes
  // récentes" list and the dashboard Alerts tab with ads the user had
  // explicitly rejected via price_min/max, seller_type, location radius, or
  // require_market_data. The counter badge, the filter-by-tier dropdown
  // (which defaulted unmatched ads to `orange`), and the CSV export all
  // carried the inflated data end-to-end. Sidebar uses `getAlertedAds`
  // directly so it was unaffected.
  //
  // Note: backfilled ads that match (red/orange tier) are marked
  // `is_alerted: true` by `markAdAlerted()` in poller.js — even though their
  // Chrome notification is suppressed — so they correctly appear here with
  // the 📋 badge in the dashboard. Non-matching backfill ads (price out of
  // range etc.) keep `is_alerted: false` and are filtered out.
  if (_isDemoMode) return DEMO_ALERTS.filter((a) => a.is_alerted && !a.is_discarded).slice(0, limit);
  const db = await getDb();
  const tx = db.transaction(STORES.ADS, "readonly");
  const index = tx.store.index("seen_at");
  const results = [];
  let cursor = await index.openCursor(null, "prev");
  while (cursor && results.length < limit) {
    if (cursor.value.is_alerted && !cursor.value.is_discarded) results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

export async function markAdAlerted(id, extra = {}) {
  const ad = await getAd(id);
  if (ad) return saveAd({ ...ad, is_alerted: true, ...extra });
}

/**
 * Return the most recent `limit` ads that were alerted (is_alerted === true),
 * ordered newest-first by seen_at.  Uses an index cursor so it does NOT load
 * all ads into memory — safe with large databases.
 */
export async function getAlertedAds(limit = 20) {
  if (_isDemoMode) return DEMO_ALERTS.filter((a) => !a.is_discarded).slice(0, limit);
  const db = await getDb();
  const tx = db.transaction(STORES.ADS, "readonly");
  const results = [];
  let cursor = await tx.store.index("seen_at").openCursor(null, "prev");
  while (cursor && results.length < limit) {
    if (cursor.value.is_alerted && !cursor.value.is_discarded) results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

export async function markAdMessaged(id) {
  const ad = await getAd(id);
  if (ad) {
    ad.is_messaged = true;
    return saveAd(ad);
  }
}

export async function adExists(id) {
  return !!(await getAd(String(id)));
}

// ── Price history ─────────────────────────────

export async function savePriceHistory(record) {
  if (!record.id) record.id = uuid();
  return dbAdd(STORES.PRICE_HISTORY, record);
}

export async function getLatestMarketStats(keyword, category_id) {
  const db = await getDb();
  // Use keyword index to fetch only this keyword's records — O(M) where M is
  // the count for this keyword, not O(N) over the entire price_history store.
  //
  // Strict category match: `null` (no category) MUST NOT match records saved
  // with a concrete category, and vice versa. The earlier
  // `(!category_id || r.category_id === category_id)` clause returned the
  // first-keyword-matching row regardless of category when the query's
  // category was falsy — so a "no-category" watchlist sharing a keyword with
  // a category-filtered watchlist would read the WRONG market baseline and
  // evaluate every ad's pct_below_market / alert_tier against a narrower
  // price distribution than the one it was configured for.
  const wantCat = category_id || null;
  const all = await db.getAllFromIndex(STORES.PRICE_HISTORY, "keyword", keyword);
  const filtered = all.filter((r) => (r.category_id ?? null) === wantCat);
  if (!filtered.length) return null;
  return filtered.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
}

export async function getPriceHistory(keyword, category_id, limit = 90) {
  if (_isDemoMode) return DEMO_PRICE_HISTORY.slice(0, limit);
  const db = await getDb();
  const all = await db.getAllFromIndex(STORES.PRICE_HISTORY, "keyword", keyword);
  // Strict category match — same rationale as getLatestMarketStats. When the
  // caller asks for the "no category" bucket, only return rows saved with a
  // null category; when the caller asks for a specific category, only return
  // rows for that category. The previous `category_id ? filter : all` branch
  // silently returned every category's history on the no-category query,
  // polluting the adpage price chart and the dashboard market view.
  const wantCat = category_id || null;
  const filtered = all.filter((r) => (r.category_id ?? null) === wantCat);
  return filtered.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function purgePriceHistory(olderThanMs = 366 * 24 * 60 * 60 * 1000) {
  const db = await getDb();
  const cutoff = Date.now() - olderThanMs;
  // Timestamp index range-scan: only cursor over records older than cutoff — O(deleted) not O(total).
  const tx = db.transaction(STORES.PRICE_HISTORY, "readwrite");
  let cursor = await tx.store.index("timestamp").openCursor(IDBKeyRange.upperBound(cutoff));
  let count = 0;
  while (cursor) {
    await cursor.delete();
    count++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return count;
}

// ── Templates ─────────────────────────────────

export async function getTemplates() {
  if (_isDemoMode) return DEFAULT_TEMPLATES.map((t, i) => ({ ...t, id: `demo-tpl-${i}`, created_at: 0 }));
  let result = await dbGetAll(STORES.TEMPLATES);
  // Seed any default templates not yet in the store (name-based dedup — handles partial seeding)
  const existingNames = new Set(result.map((t) => t.name));
  const missing = DEFAULT_TEMPLATES.filter((t) => !existingNames.has(t.name));
  if (missing.length) {
    for (const tpl of missing) await saveTemplate({ ...tpl });
    result = await dbGetAll(STORES.TEMPLATES);
  }
  return result;
}

export async function saveTemplate(tpl) {
  if (!tpl.id) tpl.id = uuid();
  if (!tpl.created_at) tpl.created_at = Date.now();
  return dbPut(STORES.TEMPLATES, tpl);
}

export async function deleteTemplate(id) {
  return dbDelete(STORES.TEMPLATES, id);
}

// ── Purchases ─────────────────────────────────

export async function getPurchases() {
  if (_isDemoMode) return DEMO_PURCHASES;
  return dbGetAll(STORES.PURCHASES);
}

export async function savePurchase(purchase) {
  if (!purchase.id) purchase.id = uuid();
  return dbPut(STORES.PURCHASES, purchase);
}

/**
 * Return all purchase records for a given ad_id, newest-first.
 * Used by the checkout idempotency guard — a second Buy click for the same ad
 * within the dedup window must NOT create a duplicate purchase row or
 * double-increment daily_spend.
 */
export async function getPurchasesByAdId(adId) {
  const db = await getDb();
  const tx = db.transaction(STORES.PURCHASES, "readonly");
  const idx = tx.store.index("ad_id");
  const rows = await idx.getAll(String(adId));
  return rows.sort((a, b) => (b.purchased_at || 0) - (a.purchased_at || 0));
}

export async function deletePurchase(id) {
  return dbDelete(STORES.PURCHASES, id);
}

// ── Blacklist ─────────────────────────────────

export async function getBlacklist() {
  return dbGetAll(STORES.BLACKLIST);
}

export async function addToBlacklist(seller_id, reason = "") {
  return dbPut(STORES.BLACKLIST, { seller_id, reason, added_at: Date.now() });
}

export async function removeFromBlacklist(seller_id) {
  return dbDelete(STORES.BLACKLIST, seller_id);
}

export async function isBlacklisted(seller_id) {
  return !!(await dbGet(STORES.BLACKLIST, seller_id));
}

// ── Export / Import ───────────────────────────

export async function exportAllData() {
  const db = await getDb();
  const result = {};
  for (const store of Object.values(STORES)) {
    // NEVER export the session store — it contains the captured LBC `api_key`
    // and `user_agent`, which grant full impersonation on lbc.fr until
    // the token rotates. Users frequently share backups with friends or paste
    // them into support threads; leaking the session token would let anyone
    // poll LBC (or worse, send messages / checkout) as that user.
    if (store === STORES.SESSION) continue;
    result[store] = await db.getAll(store);
  }
  return result;
}

export async function importAllData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid import payload: expected an object");
  }
  const db = await getDb();
  // Zeroize session before importing user data to avoid carrying over stale
  // or previously-captured api keys from an earlier local state.
  await clearSession();
  // Whitelist: only import stores we know about. CRITICAL: reject the session
  // store — a malicious export could inject attacker-controlled `api_key` /
  // `user_agent` that the SW would happily use to poll LBC, silently
  // compromising the user's account.
  const allowed = new Set(Object.values(STORES).filter((s) => s !== STORES.SESSION));
  for (const [store, records] of Object.entries(data)) {
    if (!allowed.has(store)) continue;
    if (!Array.isArray(records)) continue; // malformed store payload — skip
    const tx = db.transaction(store, "readwrite");
    for (const record of records) {
      // Reject non-object rows (strings, numbers, null, arrays) that could
      // bypass IDB type checks on some engines and produce corrupt cursors.
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      try {
        await tx.store.put(record);
      } catch (_) {
        /* skip bad record, keep importing */
      }
    }
    await tx.done;
  }
}

// ── Feed queries ────────────────────────────

/**
 * Get ads seen after cutoffMs, optionally filtered by watchlist_id.
 * Returns at most `limit` records, skipping `offset`, sorted newest first.
 */
export async function getAdsFeed(cutoffMs = 0, watchlistIdFilter = null, limit = 50, offset = 0) {
  if (_isDemoMode) {
    let demo = DEMO_FEED.filter((a) => a.seen_at >= cutoffMs);
    demo = demo.filter((a) => !a.is_discarded);
    if (watchlistIdFilter) demo = demo.filter((a) => a.list_id === watchlistIdFilter);
    return demo.slice(offset, offset + limit);
  }
  const db = await getDb();
  const tx = db.transaction(STORES.ADS, "readonly");
  const index = tx.store.index("seen_at");
  const range = IDBKeyRange.lowerBound(cutoffMs);
  const results = [];
  let cursor = await index.openCursor(range, "prev");
  let skipped = 0;
  while (cursor) {
    const ad = cursor.value;
    if (!ad.is_discarded && (!watchlistIdFilter || ad.list_id === watchlistIdFilter)) {
      if (skipped < offset) {
        skipped++;
      } else if (results.length < limit) {
        results.push(ad);
      } else {
        break;
      }
    }
    cursor = await cursor.continue();
  }
  return results;
}

export async function getAdsInPeriod(fromMs, toMs, watchlistIds = []) {
  const db = await getDb();
  const tx = db.transaction(STORES.ADS, "readonly");
  const index = tx.store.index("seen_at");
  const range = IDBKeyRange.bound(fromMs, toMs);
  const all = (await index.getAll(range)).filter((ad) => !ad.is_discarded);
  if (!watchlistIds.length) return all;
  return all.filter((ad) => watchlistIds.includes(ad.list_id));
}

export async function getPurchasesInPeriod(fromMs, toMs) {
  const all = await dbGetAll(STORES.PURCHASES);
  return all.filter((p) => {
    // Purchases come from two writers:
    //   1. automator.savePurchase \u2014 sets BOTH `purchased_at` AND `buy_date`
    //   2. dashboard manual add    \u2014 sets `buy_date` ONLY
    // The earlier `p.purchased_at || p.created_at` fallback resolved to 0
    // for manually-added purchases, silently excluding them from every
    // email / weekly report period filter. Falling through to `buy_date`
    // keeps the automator-written path intact while restoring manual rows.
    const ts = p.purchased_at || p.buy_date || p.created_at || 0;
    return ts >= fromMs && ts <= toMs;
  });
}

// ── Storage health ────────────────────────────

export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}

export async function purgeOldAds(olderThanMs = 30 * 24 * 60 * 60 * 1000) {
  const db = await getDb();
  const cutoff = Date.now() - olderThanMs;
  const tx = db.transaction(STORES.ADS, "readwrite");
  // Purge on `indexed_at` (when WE first stored the ad) rather than
  // `seen_at` (which now reflects the ad's real publication date on
  // backfilled records for the Feed tab UX). Without this change, the
  // dashboard's auto-call of purgeOldAds() on load would wipe an entire
  // multi-month backfill within seconds — every backfilled ad with a
  // publication date older than 30 days would match the cutoff.
  //
  // Fallback: older records pre-dating the indexed_at field (written before
  // this change landed) lack the attribute. Iterate all ads so legacy rows
  // still get cleaned up based on their seen_at. `indexed_at` index exists
  // for new rows; for legacy rows we scan and filter in the cursor body.
  let cursor = await tx.store.openCursor();
  let count = 0;
  while (cursor) {
    const ad = cursor.value;
    const stamp = ad.indexed_at ?? ad.seen_at ?? 0;
    if (stamp < cutoff && !ad.is_flagged && !ad.is_purchased) {
      // Never purge user-curated records (favorites / bought) regardless
      // of age — user explicitly marked these as worth keeping.
      await cursor.delete();
      count++;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return count;
}

// ── Test-only exports ──
// Expose an internal close hook so the unit-test harness can flush the
// cached connection between tests (fake-indexeddb's deleteDatabase blocks
// while any connection is open). Not part of the public API.
export const __test__ = {
  close() {
    if (_db) {
      _db.close();
      _db = null;
    }
  },
  reset() {
    _db = null;
  },
};
