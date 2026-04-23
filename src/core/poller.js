// ─────────────────────────────────────────────
//  LbC Hunter — Polling Engine
// ─────────────────────────────────────────────

import { API_ENDPOINT } from "@/shared/constants.js";
import { MSG } from "@/shared/messages.js";
import {
  getEnabledWatchlists,
  saveWatchlist,
  saveAd,
  bulkSaveAds,
  adExists,
  getAd,
  getSession,
  markAdAlerted,
  savePriceHistory,
  dbGet,
} from "@/db/indexeddb.js";
import { STORES } from "@/db/schema.js";
import { updateMarketStats, getMarketStats } from "./pricer.js";
import { evaluateDeal } from "./matcher.js";
import { fireAlert, incrementCount } from "./notifier.js";
import { sendAutoMessage, autoOpenAdTab } from "./automator.js";
import { log, warn, swKeepAlive, adUrl, mean, median, resolveShipping } from "@/shared/utils.js";

// Burst guard for end-user channels (Chrome notifications + ntfy).
// Without this cap, a broad query with many fresh matches can fan out to
// 100+ immediate notifications in one poll, overwhelming users and creating
// outbound push bursts. Matched ads are still persisted/flagged; suppressed
// ones are reflected in badge count via incrementCount().
const MAX_ALERT_NOTIFICATIONS_PER_POLL = 10;

// ── Proxy tab management ──────────────────────
//  EXECUTE_FETCH is proxied through any LBC tab whose content script is running.
//  Root cause of overnight silent failures: Chrome Memory Saver freezes background
//  tabs → the frozen content script never responds → 20s FETCH_TIMEOUT per poll →
//  zero backfill progress, zero alerts, for hours.
//
//  Fix: ping-based health check before committing to a real fetch. If ALL user LBC
//  tabs are frozen, open a background proxy tab we manage ourselves and mark it
//  autoDiscardable:false so Memory Saver can't freeze it.

const PROXY_TAB_SESSION_KEY = "poll_proxy_tab_id";

// Module-level: reference restored from session storage on SW wakeup (below)
// and used to detect/reuse an already-open proxy tab across poll cycles.
let _proxyTabId = null;

// Single-flight guard: prevent two concurrent poll cycles from both trying to
// open a proxy tab when all user tabs are unresponsive.
let _proxyTabOpening = false;

// Restore proxy tab reference after SW restart. Stored as an AWAITABLE promise
// (_proxyTabRestored) so _getPollTabId() can gate on it before reading _proxyTabId.
//
// BUG-A (fixed): the old fire-and-forget .then() resolved AFTER onAlarm fired
// the first poll cycle, leaving _proxyTabId=null → Step 3 skipped → new proxy
// tab opened → session storage overwritten with new ID → old tab orphaned forever.
// With Chrome killing MV3 SWs every ~5 min, this produced ~96 orphaned LBC tabs
// overnight. Each orphan is eventually frozen by Memory Saver, re-triggering the
// very problem the proxy tab was meant to solve.
const _proxyTabRestored = (async () => {
  try {
    const r = await chrome.storage.session.get(PROXY_TAB_SESSION_KEY);
    if (r && r[PROXY_TAB_SESSION_KEY]) _proxyTabId = r[PROXY_TAB_SESSION_KEY];
  } catch (_) {
    // storage session unavailable in this context
  }
})();

function swallowChromeCall(fn) {
  try {
    const maybePromise = fn();
    if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
  } catch (_) {
    // best effort only
  }
}

async function tryAwait(fn, fallback = null) {
  try {
    return await fn();
  } catch (_) {
    return fallback;
  }
}

/**
 * Ping a tab's content script with a lightweight PING message.
 * Returns true if the content script is alive and responds within timeoutMs.
 * A frozen (Memory Saver) tab or one without a loaded content script returns false.
 */
function _pingTab(tabId, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    chrome.tabs.sendMessage(tabId, { type: MSG.PING }, (response) => {
      clearTimeout(t);
      if (chrome.runtime.lastError) return resolve(false);
      resolve(response?.pong === true);
    });
  });
}

/**
 * Return a tabId whose content script can proxy an EXECUTE_FETCH right now.
 *
 * Priority chain:
 *   1. User's active LBC tab — Memory Saver never freezes active tabs
 *   2. Any other non-discarded LBC tab that responds to a PING
 *   3. Cached background proxy tab (opened by us in a previous cycle)
 *   4. New background proxy tab (opened now, tab marked autoDiscardable:false)
 *
 * Throws 'NO_LBC_TAB' only if a new proxy tab can't be opened or loaded.
 */
async function _getPollTabId() {
  // Gate on proxy tab ID restoration from session storage (survives SW restarts).
  // Without this await, _proxyTabId is still null when the first alarm-driven
  // poll runs after an SW wakeup, causing Step 3 to be skipped and a new orphan
  // proxy tab to be opened on every SW restart cycle.
  await _proxyTabRestored;
  if (!_proxyTabId) {
    const stored = await tryAwait(() => chrome.storage.session.get(PROXY_TAB_SESSION_KEY), null);
    if (stored && stored[PROXY_TAB_SESSION_KEY]) _proxyTabId = stored[PROXY_TAB_SESSION_KEY];
  }

  // Step 1 & 2: query complete, non-discarded LBC tabs and ping them
  const allLbc = await chrome.tabs.query({ url: "*://www.lbc.fr/*", status: "complete" });
  const candidates = allLbc.filter((t) => !t.discarded); // discarded = cannot receive messages

  // Sort: active tab first (never frozen), then most-recently-accessed
  candidates.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });

  for (const tab of candidates) {
    const alive = await _pingTab(tab.id, 1500);
    if (alive) return tab.id;
  }

  // Step 3: all user LBC tabs frozen/dead — try cached proxy tab
  if (_proxyTabId) {
    try {
      const tab = await chrome.tabs.get(_proxyTabId);
      if (!tab.discarded) {
        const alive = await _pingTab(_proxyTabId, 1500);
        if (alive) {
          // Reset the idle-cleanup alarm — tab is actively in use
          chrome.alarms.create("proxy-poll-tab-cleanup", { delayInMinutes: 10 });
          return _proxyTabId;
        }
      }
    } catch (_) {
      /* tab was closed */
    }
    // Cached proxy tab is dead — clean up before opening a new one
    await tryAwait(() => chrome.tabs.remove(_proxyTabId));
    _proxyTabId = null;
    await chrome.storage.session.remove(PROXY_TAB_SESSION_KEY);
  }

  // Step 4: open a new background proxy tab (single-flight: one attempt at a time)
  if (_proxyTabOpening) throw new Error("NO_LBC_TAB");
  _proxyTabOpening = true;
  try {
    // BUG-E fix: close any orphaned proxy tab from a previous SW restart race.
    // When _proxyTabId was null on entry (BUG-A: .then() lost the race), Step 3
    // was bypassed and session storage still held the old tab ID. That old tab
    // was never closed. Explicitly read and close it before opening a new one.
    const prevStored = await chrome.storage.session.get(PROXY_TAB_SESSION_KEY);
    const staleProxyId = prevStored[PROXY_TAB_SESSION_KEY];
    if (staleProxyId && staleProxyId !== _proxyTabId) {
      await tryAwait(() => chrome.tabs.remove(staleProxyId));
      await chrome.storage.session.remove(PROXY_TAB_SESSION_KEY);
      log("Closed orphaned proxy tab:", staleProxyId);
    }

    log("No healthy LBC tab — opening background proxy tab for polling");

    // Pass 4 fix (R1): the previous implementation used
    //   `await new Promise(r => { setTimeout(r, 15000); onUpdated.addListener(...) })`
    // to wait for tab load. This was a SW kill site — during the await, NO
    // Chrome Extension API call was in flight (a registered listener does NOT
    // keep the SW alive; only pending API calls do). If LBC's homepage took
    // >30 s to reach `status:'complete'` (slow network, captcha interstitial,
    // throttled connection), Chrome killed the SW mid-wait, module state reset,
    // `_proxyTabId` was lost, the opened tab became an orphan, and the next
    // master-poll wake-up ran Step 4 again — repeating overnight until Memory
    // Saver had frozen every orphan and every poll cycle failed with NO_LBC_TAB.
    //
    // Replacement: polling loop with `chrome.tabs.get()` as the keep-alive
    // anchor. Each call is an active Chrome Extension API invocation, so the
    // SW stays alive on every iteration regardless of how long the page takes
    // to load. Bounded by 15 s (30 iterations × 500 ms).
    const tab = await chrome.tabs.create({ url: "https://www.lbc.fr/", active: false });
    _proxyTabId = tab.id;
    await chrome.storage.session.set({ [PROXY_TAB_SESSION_KEY]: tab.id });
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch (_e) {}

    let loaded = false;
    const LOAD_POLL_INTERVAL = 500;
    const LOAD_MAX_ITERATIONS = 30; // 30 * 500ms = 15s budget
    for (let i = 0; i < LOAD_MAX_ITERATIONS; i++) {
      // swKeepAlive also uses chrome.storage.session.set as a keep-alive anchor,
      // but we still want a real tabs.get on every iteration to observe status.
      await swKeepAlive(LOAD_POLL_INTERVAL);
      const tabNow = await tryAwait(() => chrome.tabs.get(tab.id), null);
      if (!tabNow) {
        // Tab closed by user or external code during load — bail out immediately.
        _proxyTabId = null;
        await chrome.storage.session.remove(PROXY_TAB_SESSION_KEY);
        throw new Error("NO_LBC_TAB");
      }
      if (tabNow.status === "complete") {
        loaded = true;
        break;
      }
    }

    if (!loaded) {
      await tryAwait(() => chrome.tabs.remove(tab.id));
      _proxyTabId = null;
      await chrome.storage.session.remove(PROXY_TAB_SESSION_KEY);
      throw new Error("NO_LBC_TAB");
    }

    // Content scripts need ~300-500 ms after page-load to initialise.
    // Use swKeepAlive (not sleep) so the SW doesn't get killed during this wait.
    await swKeepAlive(500);

    const alive = await _pingTab(tab.id, 2000);
    if (!alive) {
      await tryAwait(() => chrome.tabs.remove(tab.id));
      _proxyTabId = null;
      await chrome.storage.session.remove(PROXY_TAB_SESSION_KEY);
      throw new Error("NO_LBC_TAB");
    }

    log("Background proxy tab ready, id:", tab.id);
    // Schedule idle cleanup — auto-close this tab after 10 min of no polling
    chrome.alarms.create("proxy-poll-tab-cleanup", { delayInMinutes: 10 });
    return tab.id;
  } finally {
    _proxyTabOpening = false;
  }
}

/**
 * Close the background proxy poll tab and clear its session reference.
 * Called by the 'proxy-poll-tab-cleanup' alarm after 10 min of no polling —
 * prevents the extension from leaving a permanent LBC background tab open.
 */
export async function cleanupProxyPollTab() {
  const stored = await chrome.storage.session.get(PROXY_TAB_SESSION_KEY);
  const tabId = stored[PROXY_TAB_SESSION_KEY] ?? _proxyTabId;
  if (tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_e) {
      // ignore if tab is already gone
    }
    _proxyTabId = null;
    await chrome.storage.session.remove(PROXY_TAB_SESSION_KEY);
    log("Proxy poll tab closed by idle cleanup alarm");
  }
}

// ── Fetch via content-script proxy ───────────

export async function fetchViaContentScript(url, options = {}) {
  const tabId = await _getPollTabId();

  return new Promise((resolve, reject) => {
    // NOTE: setTimeout here is safe — the SW stays alive while this Promise is pending
    const timeout = setTimeout(() => reject(new Error("FETCH_TIMEOUT")), 20000);
    chrome.tabs.sendMessage(
      tabId,
      {
        type: MSG.EXECUTE_FETCH,
        url,
        options,
        requestId: crypto.randomUUID(),
      },
      (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok) return reject(new Error(response?.error || "FETCH_FAILED"));
        resolve(response.data);
      },
    );
  });
}

// ── Backfill error broadcast ──────────────────
// Centralised helper so every failure path (no_tab, fetch_error, page_failed)
// emits a consistent POLL_STATUS 'backfill_error' message that UI surfaces
// (popup badge, options toast) can render without duplicating the payload shape.
// Falls through silently when no receiver is listening (normal when all
// extension pages are closed).
function _broadcastBackfillError(watchlistId, reason, message, extra = {}) {
  swallowChromeCall(() =>
    chrome.runtime.sendMessage({
      type: MSG.POLL_STATUS,
      watchlistId,
      phase: "backfill_error",
      reason,
      message,
      timestamp: Date.now(),
      ...extra,
    }),
  );
}

async function _savePollFailureState(watchlistId, errorMessage) {
  const latest = await tryAwait(() => dbGet(STORES.WATCHLISTS, watchlistId), null);
  if (!latest) return;

  const now = Date.now();
  await saveWatchlist({
    ...latest,
    last_polled_at: now,
    last_poll_attempt_at: now,
    last_poll_error: { message: errorMessage, at: now },
    consecutive_poll_failures: (latest.consecutive_poll_failures ?? 0) + 1,
  });
}

async function _savePollSuccessState(watchlistId, extra = null) {
  const latest = await tryAwait(() => dbGet(STORES.WATCHLISTS, watchlistId), null);
  if (!latest) return null;

  const now = Date.now();
  const extraFields = typeof extra === "function" ? extra(latest) || {} : extra || {};
  const updated = {
    ...latest,
    last_polled_at: now,
    last_poll_attempt_at: now,
    last_successful_poll_at: now,
    last_poll_error: null,
    consecutive_poll_failures: 0,
    ...extraFields,
  };
  await saveWatchlist(updated);
  return { latest, updated };
}

async function _applyMatchedAdSideEffects({ ad, watchlist, matchResult, isBackfill }) {
  await markAdAlerted(String(ad.list_id), {
    alert_tier: matchResult.alert_tier,
    pct_below_market: matchResult.pct_below_market,
  });

  if (!isBackfill && watchlist.auto_open_tab && ["red", "orange"].includes(matchResult.alert_tier)) {
    await autoOpenAdTab(ad);
  }
  if (!isBackfill && watchlist.auto_message_enabled) {
    await sendAutoMessage(ad, watchlist.auto_message_template_id);
  }
}

async function _handleAlertNotificationEmission({
  ad,
  watchlist,
  matchResult,
  isBackfill,
  emittedNotifications,
  suppressedNotifications,
}) {
  if (isBackfill) {
    return { emittedNotifications, suppressedNotifications };
  }

  if (emittedNotifications < MAX_ALERT_NOTIFICATIONS_PER_POLL) {
    await fireAlert(ad, watchlist, matchResult);
    return { emittedNotifications: emittedNotifications + 1, suppressedNotifications };
  }

  // Keep unread count honest even when individual push notifications
  // are suppressed by the burst guard.
  void incrementCount();
  return { emittedNotifications, suppressedNotifications: suppressedNotifications + 1 };
}

function _buildSuppressedNotificationsWarning({ watchlistName, suppressedNotifications }) {
  return (
    `Poll [${watchlistName}]: suppressed ${suppressedNotifications} push notifications ` +
    `(burst guard ${MAX_ALERT_NOTIFICATIONS_PER_POLL}/poll)`
  );
}

function _buildPollSuccessExtraFields({ latest, sortedAds, watchlistPendingBackfillDays, isBackfill }) {
  return {
    last_seen_ad_id: String(sortedAds[0]?.list_id ?? latest.last_seen_ad_id ?? ""),
    // Only clear `pending_backfill_days` here for the non-backfill paths
    // (isFirstPoll, incremental). For backfill runs the checkpoint already
    // cleared it and wrote last_backfill_* — preserve those values.
    // Guard: same concurrent-edit check — don't wipe a newly-queued seed.
    pending_backfill_days:
      !isBackfill && (latest.pending_backfill_days ?? 0) === (watchlistPendingBackfillDays ?? 0)
        ? 0
        : (latest.pending_backfill_days ?? 0),
  };
}

// ── Build API request body ────────────────────

function buildSearchBody(watchlist) {
  const filters = {
    keywords: { text: watchlist.keywords, type: "all" },
    enums: { ad_type: ["offer"] },
  };

  if (watchlist.category_id) {
    filters.category = { id: String(watchlist.category_id) };
  }

  if (watchlist.price_min || watchlist.price_max) {
    filters.ranges = {
      price: {
        min: watchlist.price_min || 0,
        max: watchlist.price_max || 99999,
      },
    };
  }

  if (watchlist.location_zip && watchlist.location_lat) {
    filters.location = {
      zipcode: [watchlist.location_zip],
      ...(watchlist.location_radius_km > 0 && watchlist.location_lat
        ? {
            area: {
              lat: watchlist.location_lat,
              lng: watchlist.location_lng,
              radius: watchlist.location_radius_km * 1000, // API expects meters
            },
          }
        : {}),
    };
  }

  if (watchlist.seller_type && watchlist.seller_type !== "all") {
    filters.enums.owner_type = [watchlist.seller_type];
  }

  // Shipping / delivery filter
  if (watchlist.shipping_filter === "delivery_only") {
    filters.shipping = { enabled: true };
  } else if (watchlist.shipping_filter === "local_only") {
    filters.shipping = { enabled: false };
  }

  return {
    filters,
    limit: 35,
    limit_alu: 3,
    sort_by: "time",
    sort_order: "desc",
    offset: 0,
  };
}

// ── Single watchlist poll ─────────────────────

// Per-watchlist inflight lock. Needed because `FORCE_POLL` (popup/options
// button) calls pollWatchlist DIRECTLY, bypassing the `_pollCycleInFlight`
// cycle mutex. If the master-poll alarm is already mid-await on wlA and the
// user clicks force-poll on wlA, both invocations race:
//   1. Both fetchViaContentScript → two full LBC API calls (rate-limit waste)
//   2. Both updateMarketStats → two near-identical price_history rows
//      with the same keyword+category, visible as a duplicate/spike in the
//      chart and as inflated sample_count in the next baseline read.
//   3. Both evaluateDeal + fireAlert → Chrome notifications dedupe by id,
//      but `_pendingCount++` runs twice (badge = 2× reality), alert sound
//      plays twice, ntfy push sent twice.
//   4. Both markAdAlerted + last-writer saveWatchlist (idempotent).
// The per-id Map lets the two lock granularities (cycle-wide vs watchlist)
// coexist: cycle mutex still prevents overlapping FULL cycles; this lock
// prevents a force-poll from colliding with an in-progress single-wl poll.
const _wlInflight = new Map(); // watchlistId → Promise

export function pollWatchlist(watchlist) {
  const key = watchlist?.id;
  if (!key) return _doPollWatchlist(watchlist); // degenerate — no dedup possible
  const existing = _wlInflight.get(key);
  if (existing) {
    log(`Poll [${watchlist.name}] coalesced — returning inflight promise`);
    return existing;
  }
  const p = _doPollWatchlist(watchlist).finally(() => {
    // Delete only if we're still the inflight owner. Guards against a
    // theoretical race where another caller overwrote the Map entry during
    // our await chain (shouldn't happen with single-threaded JS, but cheap
    // defence against future refactors that add reentrancy).
    if (_wlInflight.get(key) === p) _wlInflight.delete(key);
    // STUCK-BADGE GUARD (Pass 48-A): if `_doPollWatchlist` threw AFTER
    // broadcasting `backfill_start`, the inner emit helpers never ran and
    // the popup stays showing "📋 Seed…" until it is closed. Invoke the
    // helper exposed on the watchlist object — it no-ops if already fired.
    try {
      watchlist?.__emitBackfillDone?.(0);
    } catch (_) {
      /* ignore */
    }
  });
  _wlInflight.set(key, p);
  return p;
}

async function _doPollWatchlist(watchlistParam) {
  const session = await getSession();
  if (!session) {
    warn("No session — skipping poll for", watchlistParam.name);
    // If a backfill is pending, tell the user immediately why it appears stuck.
    // `watchlistParam` is a fresh IDB snapshot for FORCE_POLL and a recent
    // cycle snapshot for runPollCycle — both reliably carry pending_backfill_days.
    if ((watchlistParam.pending_backfill_days ?? 0) > 0) {
      _broadcastBackfillError(
        watchlistParam.id,
        "no_session",
        `Historique en attente (${watchlistParam.pending_backfill_days}j): session LBC manquante — visitez lbc.fr pour vous connecter`,
        { days: watchlistParam.pending_backfill_days },
      );
    }
    // BUG-D fix: increment failure counter so the ⚠ badge and options warning
    // surface on session-loss. Previously no_session returned silently without
    // updating telemetry, so the badge never appeared no matter how long the
    // session was absent (e.g., logged-out overnight).
    await _savePollFailureState(watchlistParam.id, "no_session");
    return { status: "no_session" };
  }

  // Ghost-poll guard: `runPollCycle` snapshots the enabled watchlists once,
  // then sleeps for stagger (up to N*2s + 3s jitter) between each poll.
  // FORCE_POLL from the popup also hands in a snapshot read seconds ago.
  // In both windows the user may have DELETED this watchlist. Without this
  // check we still fetch one last API page, evaluate/alert, run auto-open
  // + auto-message, and persist a price_history row for a watchlist that
  // no longer exists. All wasted side-effects, all fired against a ghost.
  // Re-read IDB up-front and short-circuit on null.
  const stillExists = await tryAwait(() => dbGet(STORES.WATCHLISTS, watchlistParam.id), null);
  if (!stillExists) {
    log(`Poll [${watchlistParam.name}]: watchlist no longer exists — skipping`);
    return { status: "deleted" };
  }
  // Also respect a mid-cycle disable: user toggled the card off during stagger.
  if (stillExists.enabled === false) {
    log(`Poll [${watchlistParam.name}]: watchlist disabled mid-cycle — skipping`);
    return { status: "disabled" };
  }

  // ── STALE-SNAPSHOT FIX ─────────────────────────────────────────────
  // `watchlistParam` was snapshotted in `runPollCycle` (or by the popup for
  // FORCE_POLL) potentially many seconds before this poll actually runs —
  // stagger (N*2s), jitter (up to 3s), session-wait, master-poll alarm
  // coalescence. During that window the user may have:
  //   • scheduled a backfill via the options form (pending_backfill_days)
  //   • changed keywords / category_id → buildSearchBody with stale terms
  //   • tightened price filters / location → stale body
  //   • toggled auto_open_tab / auto_message_enabled → wrong auto-actions
  //   • adjusted undermarket_threshold_pct → wrong tier classification
  //   • edited require_market_data → wrong null-marketStats handling
  // Reading those fields from the stale param silently ignored every edit
  // for at least one poll cycle (sometimes many, since the backfill branch
  // never enters if its trigger field is stale). Use the fresh IDB record
  // as the SINGLE source of truth for every read from here on.
  // `watchlistParam` is still mutated later to attach `__emitBackfillDone`
  // because the outer `pollWatchlist()` wrapper's stuck-badge guard reads
  // that helper off the ORIGINAL reference it holds.
  const watchlist = stillExists;

  const body = buildSearchBody(watchlist);
  let responseData;

  // Build headers — include api_key if we have a real one (not cookie-auth sentinel)
  const fetchHeaders = { "Content-Type": "application/json" };
  if (session.api_key && session.api_key !== "__cookie_auth__") {
    fetchHeaders["api_key"] = session.api_key;
  }
  if (session.user_agent) fetchHeaders["User-Agent"] = session.user_agent;

  try {
    responseData = await fetchViaContentScript(API_ENDPOINT, {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.message === "NO_LBC_TAB") {
      warn("No LBC tab open — cannot poll");
      // If a backfill is pending, surface the blockage to the user immediately
      // rather than silently waiting for the next 30-second cycle. The `no_tab`
      // error is the most common reason a fresh watchlist shows "Seed en cours…"
      // for minutes with zero progress — the user may not realise they need an
      // open LBC tab for the proxy fetch to work.
      if ((watchlist.pending_backfill_days ?? 0) > 0) {
        _broadcastBackfillError(
          watchlist.id,
          "no_tab",
          `Historique en attente (${watchlist.pending_backfill_days}j): aucun onglet lbc.fr ouvert — ouvrir un onglet LBC pour débloquer`,
          { days: watchlist.pending_backfill_days },
        );
      }
      // Still stamp last_polled_at so popup shows a recent "last attempt" time
      // instead of a stale timestamp from the last successful poll. Re-read
      // the watchlist first — stale-stomp + resurrection guard, same rationale
      // as the post-fetch error branch below. The tab-check window is short
      // but a concurrent delete/edit is still possible (user opens options,
      // deletes the watchlist just as the master-poll cycle lands here).
      await _savePollFailureState(watchlist.id, "NO_LBC_TAB");
      return { status: "no_tab" };
    }
    // Server-side auth failure (revoked token, logged out in another tab, etc).
    // The session-check alarm only evaluates token AGE, so without this branch
    // the poller 401-loops silently for up to SESSION_TTL_MS. Schedule the
    // same alarm used at SW cold-start so autoRefreshSession runs ASAP.
    if (/^HTTP (401|403)$/.test(err.message || "")) {
      warn("Poll auth failure (" + err.message + ") — scheduling session refresh");
      swallowChromeCall(() => chrome.alarms.create("startup-session-check", { delayInMinutes: 0.05 }));
    }
    warn("Poll fetch error:", err.message);
    // Surface backfill blockage to the user. The pending_backfill_days flag is
    // still set in IDB (we never reached the checkpoint), so the next cycle
    // retries — but the user deserves immediate feedback about WHY the seed
    // appears stuck, especially for auth failures (401/403) which won't self-
    // heal until the session is refreshed.
    if ((watchlist.pending_backfill_days ?? 0) > 0) {
      _broadcastBackfillError(
        watchlist.id,
        "fetch_error",
        `Historique en attente (${watchlist.pending_backfill_days}j): erreur réseau [${err.message}] — réessai automatique`,
        { days: watchlist.pending_backfill_days },
      );
    }
    // Stale-stomp + resurrection guard (same rationale as the end-of-poll
    // write below): re-read the watchlist and skip the write if the user
    // deleted it during this (possibly seconds-long) failed fetch. The
    // `...watchlist` snapshot is also the poll-start value, so edits made
    // during the fetch would be reverted without this merge-on-latest.
    await _savePollFailureState(watchlist.id, err.message);
    return { status: "error", error: err.message };
  }

  const ads = responseData?.ads ?? [];
  if (!ads.length) {
    log(`Poll [${watchlist.name}]: 0 ads`);
    // Still update last_polled_at so the popup shows the last check time.
    // Same stale-stomp + resurrection guard as the main write path.
    const saved = await _savePollSuccessState(watchlist.id, { pending_backfill_days: 0 });
    if (!saved) return { status: "ok", newCount: 0 };
    const hadPending = (saved.latest.pending_backfill_days ?? 0) > 0;
    // Clear any in-progress backfill badge so the UI doesn't show "Seed…" forever
    // when LBC returns 0 results for the query (narrow search, deleted category, etc.).
    // Without this broadcast the hasPendingBackfill bypass would retry every 30s
    // indefinitely and the badge would stay stuck.
    if (hadPending) {
      swallowChromeCall(() =>
        chrome.runtime.sendMessage({
          type: MSG.POLL_STATUS,
          watchlistId: watchlist.id,
          phase: "backfill_done",
          count: 0,
          days: saved.latest.pending_backfill_days,
          durationMs: 0,
          timestamp: Date.now(),
        }),
      );
    }
    return { status: "ok", newCount: 0 };
  }

  // Deduplication: find new ads since last poll
  const isFirstPoll = !watchlist.last_seen_ad_id;
  // Re-backfill hook. Existing watchlists can set `pending_backfill_days` via
  // the options form ("Recharger l'historique") to re-run the seed branch on
  // the next poll without nuking `last_seen_ad_id`. Value overrides the
  // original `backfill_days` for THIS run only — we clear the flag once the
  // backfill branch completes, so subsequent polls resume normal incremental
  // behaviour. Without this hook, users stuck with broad searches set up
  // early (when backfill_days=0 was the default) have no way to rebuild
  // their price history or seed the Feed tab with historical context.
  const backfillDays = watchlist.pending_backfill_days || (isFirstPoll ? watchlist.backfill_days : 0);
  const shouldBackfill = backfillDays > 0;

  // Update market stats from page-1 ads.
  // Skip on backfill runs — the backfill branch below runs
  // updateMarketStats again with the full multi-page dataset, so doing it here
  // would persist a page-1-only price_history row that's immediately superseded
  // and pollutes the chart with a stale data point.
  if (!shouldBackfill) {
    await updateMarketStats(watchlist.keywords, watchlist.category_id || null, ads);
  }

  // NOTE: marketStats is read *after* the backfill branch below (if any) runs
  // its own updateMarketStats, so evaluateDeal() always sees the freshest
  // baseline. Reading it here would capture a stale/null row on
  // first-poll-with-backfill and the evaluator would compute wrong
  // pct_below_market / alert_tier for every ad in the seed batch — values we
  // persist to IDB and surface in the dashboard Feed & Alerts views.
  const sortedAds = [...ads].sort((a, b) => {
    return new Date(b.first_publication_date) - new Date(a.first_publication_date);
  });

  // ── Backfill constants ────────────────────────
  // Adaptive pagination: scale the hard ceiling with the requested window.
  //
  // The prior hardcoded `BACKFILL_MAX_PAGES = 5` (= 175 ads) was the root
  // cause of "1-year backfill looks empty": a single day of results on a
  // broad query (iPhone 15, Warcraft) already fills 5 pages, so the seed
  // covered the last ~1-3 days regardless of the user's 365-day selection.
  //
  // Two independent stop conditions govern the loop:
  //   1. Window cutoff — stop once the OLDEST ad on a page predates
  //      `now - backfillDays`. We have enough history.
  //   2. API exhaustion — LBC returns an empty or short (<35) page.
  //
  // The hard ceiling is a safety net (network pathologies, abusive configs).
  // 40 pages × 35 ads × 200ms = ~8s max wall-clock, 1400 ads for a full
  // 365-day seed on a dense query.
  // 200ms is the minimum delay that keeps us below LBC's observed rate-limit
  // threshold (tested empirically — the API tolerates bursts up to ~5 req/s
  // without returning 429s on typical queries). Do not go below 150ms.
  const BACKFILL_MAX_PAGES = Math.min(40, Math.max(5, Math.ceil(backfillDays / 7)));
  const BACKFILL_PAGE_DELAY = 200; // ms between paginated API calls

  // Number of additional retry attempts per page on transient failure.
  // Total attempts = 1 (initial) + BACKFILL_PAGE_RETRIES.
  // Delay between attempts: BACKFILL_RETRY_DELAY_MS * attempt (linear backoff).
  // Keeps the total stall bounded: worst case = 3 pages × 3s = 9s extra, far
  // below the 20s FETCH_TIMEOUT already in place. The retry target is
  // specifically transient network glitches (socket reset, proxy timeout) — a
  // permanent error (NO_LBC_TAB, 401) surfaces on attempt 0 and fails fast.
  const BACKFILL_PAGE_RETRIES = 2;
  const BACKFILL_RETRY_DELAY_MS = 1000;

  let newAds = [];
  let isBackfill = false;
  let backfillStartMs = 0;
  // STUCK-BADGE GUARD (Pass 48-A): once we broadcast `backfill_start`, every
  // exit path — normal return, mid-poll delete, thrown exception bubbling up
  // to the outer wrapper — MUST broadcast `backfill_done` exactly once, or
  // the popup stays showing "📋 Seed…" until it is reopened. Flag flips true
  // on the first emission; the outer wrapper calls `emitBackfillDone()` in a
  // `.finally()` that no-ops if already fired.
  let backfillDoneFired = false;
  const emitBackfillDone = (count) => {
    if (backfillDoneFired) return;
    backfillDoneFired = true;
    swallowChromeCall(() =>
      chrome.runtime.sendMessage({
        type: MSG.POLL_STATUS,
        watchlistId: watchlist.id,
        phase: "backfill_done",
        count: count ?? 0,
        days: backfillDays,
        durationMs: Date.now() - backfillStartMs,
        timestamp: Date.now(),
      }),
    );
  };
  if (shouldBackfill) {
    // ── Multi-page collection ───────────────
    backfillStartMs = Date.now();
    // Pass 48-C: expose the emit helper ONLY after entering the backfill
    // branch. Previously it was hoisted above so the outer `.finally()`
    // stuck-badge guard could always reach it — but that also meant EVERY
    // non-backfill poll broadcast a spurious `backfill_done` with
    // `durationMs ≈ Date.now()` (backfillStartMs was still 0). Options-page
    // re-rendered on every poll, popup received phantom `backfill_done` for
    // a transition that never started. Now the guard only fires when a
    // matching `backfill_start` was actually broadcast.
    // Attach to BOTH the fresh `watchlist` reference (used internally) AND
    // the original `watchlistParam` (what the outer pollWatchlist wrapper
    // holds in its closure and reads in its `.finally()` stuck-badge guard).
    // Without the second attach, a throw mid-backfill leaves the popup badge
    // stuck at "📋 Seed…" because the outer guard reads `undefined?.(0)`.
    watchlist.__emitBackfillDone = emitBackfillDone;
    watchlistParam.__emitBackfillDone = emitBackfillDone;
    // Broadcast a start event so any open popup/options panel can render a
    // "📋 Seed en cours…" indicator immediately (instead of waiting for the
    // backfill to land in IDB via `last_backfill_at`).
    swallowChromeCall(() =>
      chrome.runtime.sendMessage({
        type: MSG.POLL_STATUS,
        watchlistId: watchlist.id,
        phase: "backfill_start",
        days: backfillDays,
        timestamp: backfillStartMs,
      }),
    ); // no listeners is fine
    let allBackfillAds = [...sortedAds]; // page 0 already fetched above
    const backfillMs = backfillDays * 86_400_000;
    const cutoffMs = Date.now() - backfillMs;
    // Tracks whether any page failed ALL retries. Used by the checkpoint block
    // to decide whether to preserve `pending_backfill_days` for the next cycle.
    let pageFailed = false;

    for (let page = 1; page < BACKFILL_MAX_PAGES; page++) {
      // Early-exit check: are we already past the window cutoff? Use the
      // oldest ad we've fetched so far. `first_publication_date` is an
      // ISO-8601 string from LBC; parse once.
      const oldest = allBackfillAds[allBackfillAds.length - 1];
      const oldestMs = oldest?.first_publication_date ? new Date(oldest.first_publication_date).getTime() : null;
      if (oldestMs != null && oldestMs < cutoffMs) {
        log(`Backfill: reached ${backfillDays}-day cutoff after ${page} page(s) — stopping`);
        break;
      }

      // SW-safe delay between pages. We DON'T use sleep() here — a bare setTimeout
      // has no Chrome Extension API keep-alive anchor, and Chrome kills MV3 SWs after
      // ~30s of no active extension API calls. Each fetchViaContentScript call keeps
      // the SW alive on its own (active message channel), so the 200ms between pages
      // is achieved via a noop chrome.storage.session.set (swKeepAlive ≤ 200ms fires
      // a single set() + a 100ms setTimeout, then one more set() before returning).
      // The overall cadence is still ≥200ms because fetchViaContentScript itself takes
      // 200-500ms of network round-trip.
      await swKeepAlive(BACKFILL_PAGE_DELAY);

      // Per-page retry loop. Each page gets BACKFILL_PAGE_RETRIES additional
      // attempts (total = 1 + BACKFILL_PAGE_RETRIES) before the backfill
      // branch treats it as a hard failure and breaks pagination.
      // Rationale: a single transient socket-reset should not silently truncate
      // a 365-day seed to the first 140 ads (4 pages × 35). Linear back-off
      // keeps the wall-clock overhead bounded while giving the network time
      // to recover from transient blips.
      let pageData = null;
      for (let attempt = 0; attempt <= BACKFILL_PAGE_RETRIES; attempt++) {
        if (attempt > 0) await swKeepAlive(BACKFILL_RETRY_DELAY_MS * attempt);
        try {
          const pageBody = { ...buildSearchBody(watchlist), offset: page * 35 };
          pageData = await fetchViaContentScript(API_ENDPOINT, {
            method: "POST",
            headers: fetchHeaders,
            body: JSON.stringify(pageBody),
          });
          break; // successful fetch — exit retry loop
        } catch (e) {
          if (attempt < BACKFILL_PAGE_RETRIES) {
            warn(
              `Backfill page ${page} attempt ${attempt + 1} failed: ${e.message} — retrying in ${BACKFILL_RETRY_DELAY_MS * (attempt + 1)}ms`,
            );
          } else {
            warn(
              `Backfill page ${page} failed after ${BACKFILL_PAGE_RETRIES + 1} attempts: ${e.message} — stopping pagination`,
            );
            pageFailed = true;
          }
        }
      }

      if (pageFailed) break; // exit page loop — checkpoint will preserve pending flag

      const pageAds = pageData?.ads ?? [];
      if (!pageAds.length) break; // LBC exhausted
      allBackfillAds.push(...pageAds);
      if (pageAds.length < 35) break; // Last partial page — LBC exhausted
    }

    // De-duplicate by list_id across pages
    const seenIds = new Set();
    allBackfillAds = allBackfillAds.filter((a) => {
      const k = String(a.list_id);
      if (seenIds.has(k)) return false;
      seenIds.add(k);
      return true;
    });

    // Clip ads that fell outside the requested window (safer than relying on
    // the loop's early-exit: the last fetched page may contain some ads on
    // either side of the cutoff since LBC returns batches of 35).
    allBackfillAds = allBackfillAds.filter((a) => {
      const ms = a.first_publication_date ? new Date(a.first_publication_date).getTime() : null;
      return ms == null || ms >= cutoffMs;
    });

    // Sort newest → oldest
    allBackfillAds.sort((a, b) => new Date(b.first_publication_date) - new Date(a.first_publication_date));

    log(`Backfill: collected ${allBackfillAds.length} ads over ${backfillDays}d window`);

    // Re-run market stats with the full multi-page dataset for a better baseline
    await updateMarketStats(watchlist.keywords, watchlist.category_id || null, allBackfillAds);

    // ── Atomic bulk persist ─────────────────────────────────────────────
    // All 1400 ads in a SINGLE IDB readwrite transaction via bulkSaveAds.
    //
    // Previous approach: Promise.all(allBackfillAds.map(persistAd)) ran
    // 2 × N individual transactions (one get + one put per ad) sequentially
    // over 5–30 seconds. Every point in that window was an MV3 SW-kill site:
    //   • Kill mid-loop → some ads persisted, some not → partial seed
    //     pollutes the Feed with gaps. Re-run next poll re-persists all →
    //     but pending_backfill_days was already cleared by the "before-
    //     persist" checkpoint → re-run NEVER happens → seed stays partial.
    //
    // bulkSaveAds wraps everything in ONE IDB transaction:
    //   • Kill before commit → IDB rolls back entirely → zero ads written
    //     → pending_backfill_days still set → next poll retries in full.
    //   • Kill after commit but before checkpoint below → all ads written
    //     → next poll re-runs pagination (idempotent: mergeFn preserves
    //     user flags; duplicate price_history rows are the only cost).
    //   • Commit + checkpoint → pending_backfill_days cleared → done.
    //
    // This reduces the vulnerability window from "tens of seconds" to the
    // IDB transaction flush itself (milliseconds on Chrome's IDB engine).
    const now = Date.now();
    const total = allBackfillAds.length;

    await bulkSaveAds(
      allBackfillAds.map((ad, i) => {
        const realMs = ad.first_publication_date ? new Date(ad.first_publication_date).getTime() : NaN;
        const seenAt =
          Number.isFinite(realMs) && realMs <= now && realMs >= now - backfillMs
            ? realMs
            : now - Math.round((i / Math.max(total - 1, 1)) * backfillMs);
        const adPrice = Array.isArray(ad.price) ? ad.price[0] : (ad.price ?? 0);
        const shipping = resolveShipping(ad);

        return {
          id: String(ad.list_id),
          mergeFn: (existing) => {
            // Preserve ONLY user-owned flags (same logic as former persistAd).
            // Poll-derived fields are intentionally refreshed.
            const preservedFlags = existing
              ? {
                  is_flagged: !!existing.is_flagged,
                  is_archived: !!existing.is_archived,
                  is_discarded: !!existing.is_discarded,
                  is_messaged: !!existing.is_messaged,
                  is_purchased: !!existing.is_purchased,
                  ad_status: existing.ad_status,
                  notes: existing.notes,
                }
              : {};
            return {
              id: String(ad.list_id),
              list_id: watchlist.id,
              title: ad.subject || "",
              price: adPrice,
              category_id: String(ad.category_id || watchlist.category_id || ""),
              location: {
                city: ad.location?.city || "",
                zipcode: ad.location?.zipcode || "",
                lat: ad.location?.lat || 0,
                lng: ad.location?.lng || 0,
              },
              seller_type: ad.owner?.type || "private",
              seller_id: String(ad.owner?.store_id || ad.owner?.user_id || ""),
              url: adUrl(ad.list_id),
              images: ad.images?.urls_large ?? (ad.images?.thumb_url ? [ad.images.thumb_url] : []),
              created_at: ad.first_publication_date ? new Date(ad.first_publication_date).getTime() : Date.now(),
              seen_at: seenAt,
              indexed_at: existing?.indexed_at ?? Date.now(),
              is_alerted: false,
              is_backfill: true,
              is_messaged: false,
              is_purchased: false,
              is_shipping_enabled: shipping.enabled,
              shipping_cost: shipping.cost,
              attributes: ad.attributes || [],
              ...preservedFlags,
            };
          },
        };
      }),
    );

    newAds = allBackfillAds;
    isBackfill = true;

    // ── Seed price_history ──────────────────
    // Use ALL collected ads for a richer baseline (not just page-1 prices).
    const bfPrices = allBackfillAds
      .map((a) => (Array.isArray(a.price) ? a.price[0] : a.price))
      .filter((p) => typeof p === "number" && p > 0)
      .sort((a, b) => a - b);
    if (bfPrices.length >= 5) {
      const trimmed = bfPrices.slice(Math.floor(bfPrices.length * 0.05), Math.ceil(bfPrices.length * 0.95));
      const numPts = Math.min(20, backfillDays);
      const stepMs = backfillMs / Math.max(numPts - 1, 1);
      await Promise.all(
        Array.from({ length: numPts }, (_, s) =>
          savePriceHistory({
            id: crypto.randomUUID(),
            keyword: watchlist.keywords,
            category_id: watchlist.category_id || null,
            timestamp: now - Math.round((numPts - 1 - s) * stepMs),
            avg_price: mean(trimmed),
            median_price: median(trimmed),
            min_price: trimmed[0],
            max_price: trimmed[trimmed.length - 1],
            sample_count: trimmed.length,
          }),
        ),
      );
    }

    // ── Checkpoint: commit telemetry AFTER ads + price_history committed ──
    // Both IDB transactions above have completed at this point.
    // If the SW is killed before this write, the next poll finds:
    //   • All ads already in IDB (bulkSaveAds mergeFn is idempotent)
    //   • pending_backfill_days still set → re-runs pagination → re-runs
    //     bulkSaveAds (idempotent) → reaches this checkpoint → clears flag
    //   • The only cost of a re-run is duplicate price_history rows for
    //     the seed window — the minimum unavoidable gap when atomicity
    //     cannot span three different IDB object stores.
    //
    // Guard: only clear pending_backfill_days if it still matches what we
    // read at poll-start (value may differ if the user queued a NEW seed
    // while we were mid-pagination — preserve the new request).
    {
      const ckpt = await tryAwait(() => dbGet(STORES.WATCHLISTS, watchlist.id), null);
      if (ckpt) {
        const shouldClearPending =
          !pageFailed && // don't clear if pages failed — preserve for retry next cycle
          (ckpt.pending_backfill_days ?? 0) === (watchlist.pending_backfill_days ?? 0);
        await saveWatchlist({
          ...ckpt,
          pending_backfill_days: shouldClearPending ? 0 : (ckpt.pending_backfill_days ?? 0),
          last_backfill_at: Date.now(),
          last_backfill_count: allBackfillAds.length,
          last_backfill_days: backfillDays,
          last_backfill_duration: Date.now() - backfillStartMs,
        });
      }
      if (pageFailed) {
        _broadcastBackfillError(
          watchlist.id,
          "page_failed",
          `Chargement partiel: ${allBackfillAds.length} annonces chargées (erreur réseau — réessai auto)`,
          { count: allBackfillAds.length, days: backfillDays },
        );
      }
    }
  } else if (isFirstPoll) {
    // Standard first poll (no backfill): store all silently in parallel, don't alert
    await Promise.all(sortedAds.map((ad) => persistAd({ ad, watchlist })));
    newAds = [];
  } else {
    const lastIdx = sortedAds.findIndex((a) => String(a.list_id) === String(watchlist.last_seen_ad_id));
    const candidates = lastIdx === -1 ? sortedAds : sortedAds.slice(0, lastIdx);

    // Parallel existence check — 35 serial IDB reads → 1 parallel batch
    const existsFlags = await Promise.all(candidates.map((ad) => adExists(String(ad.list_id))));
    newAds = candidates.filter((_, i) => !existsFlags[i]);

    // Parallel persist — same pattern as backfill
    await Promise.all(newAds.map((ad) => persistAd({ ad, watchlist })));
  }

  // Process new ads — evaluate all in parallel, then handle side-effects sequentially
  // NOTE: save watchlist AFTER processing so a mid-loop SW kill doesn't silently
  // lose ads (last_seen_ad_id would be set but alerts not fired).
  // (Chrome notifications must remain sequential to avoid notification storms)
  //
  // Read marketStats HERE (not at the top of pollWatchlist): on
  // first-poll-with-backfill the backfill branch above ran a fresh
  // updateMarketStats() with the full multi-page dataset; reading earlier
  // would pass a stale/null row to evaluateDeal and every backfilled ad
  // would get a wrong pct_below_market / alert_tier persisted.
  const marketStats = await getMarketStats(watchlist.keywords, watchlist.category_id);
  const matchResults = await Promise.all(newAds.map((ad) => evaluateDeal(ad, watchlist, marketStats)));

  let emittedNotifications = 0;
  let suppressedNotifications = 0;

  for (let i = 0; i < newAds.length; i++) {
    const ad = newAds[i];
    const matchResult = matchResults[i];
    if (matchResult.is_match) {
      ({ emittedNotifications, suppressedNotifications } = await _handleAlertNotificationEmission({
        ad,
        watchlist,
        matchResult,
        isBackfill,
        emittedNotifications,
        suppressedNotifications,
      }));
      await _applyMatchedAdSideEffects({ ad, watchlist, matchResult, isBackfill });
    }
    // Non-matched ads intentionally do NOT increment the badge counter.
    // The badge reflects unread ALERTED ads (the set rendered by popup's
    // `renderAlerts` and dashboard Alerts tab, both driven by
    // `getRecentAlerts` which filters `is_alerted === true` since P24-A).
    // Counting non-matches here desynchronised the two: user saw "5 new"
    // but the popup's "Alertes récentes" list was empty (all 5 ads had been
    // filtered out by price/seller/location/market rules). New arrivals that
    // don't match any watchlist filter are still discoverable via the
    // dashboard Feed tab.
  }

  if (!isBackfill && suppressedNotifications > 0) {
    warn(
      _buildSuppressedNotificationsWarning({
        watchlistName: watchlist.name,
        suppressedNotifications,
      }),
    );
  }

  // Update watchlist's last_seen_ad_id & last_polled_at — after alert processing.
  // For backfill runs, `pending_backfill_days` was already cleared and
  // `last_backfill_*` telemetry was already committed by the checkpoint block
  // inside the backfill branch. This final write only carries runtime poll fields.
  //
  // STALE-WRITE GUARD: a poll cycle can take tens of seconds (especially on
  // multi-page backfill). If the user edits this watchlist through the
  // options UI during that window, the edited record lands in IDB BEFORE
  // this write. Spreading the poll-start snapshot (`...watchlist`) would
  // silently revert the edit — keywords, price filters, thresholds, enabled
  // flag, purchase_mode, etc. Re-read the current record and merge only the
  // poll-derived runtime fields on top of it so user edits survive.
  //
  // DELETE-DURING-POLL GUARD: if the user deleted this watchlist mid-poll,
  // `latest` is null. Writing would RESURRECT the deleted record with stale
  // data and the poller would keep polling a watchlist the user removed.
  // Skip the write entirely in that case.
  const saved = await _savePollSuccessState(watchlist.id, (latest) =>
    _buildPollSuccessExtraFields({
      latest,
      sortedAds,
      watchlistPendingBackfillDays: watchlist.pending_backfill_days,
      isBackfill,
    }),
  );
  if (!saved) {
    log(`Poll [${watchlist.name}]: watchlist deleted during poll — skipping save`);
    // Clear any in-flight "📋 Seed…" badge on open popup/options pages —
    // otherwise the indicator stays forever since the `.finally()` in the
    // outer wrapper will also no-op (delete case: we want a clean exit).
    if (isBackfill) emitBackfillDone(newAds.length);
    return { status: "ok", newCount: newAds.length };
  }
  if (isBackfill) {
    const durationMs = Date.now() - backfillStartMs;
    log(
      `Backfill [${watchlist.name}]: ${newAds.length} ads over ${backfillDays}d in ${Math.round(durationMs / 100) / 10}s`,
    );
    emitBackfillDone(newAds.length);
  }

  log(`Poll [${watchlist.name}]: ${ads.length} total, ${newAds.length} new`);
  return { status: "ok", newCount: newAds.length, backfillCount: isBackfill ? newAds.length : 0 };
}

async function persistAd({ ad, watchlist, overrideSeenAt = null, isBackfill = false }) {
  const price = Array.isArray(ad.price) ? ad.price[0] : (ad.price ?? 0);

  // Re-seed safety: preserve user-mutable flags when the ad already exists.
  //
  // Without this read-then-merge, a re-backfill (pending_backfill_days)
  // silently WIPES every field the user curated in the UI — favorites
  // (is_flagged), archive state (is_archived), sold/available toggle
  // (ad_status), message-sent marker (is_messaged), purchase state
  // (is_purchased) — because saveAd is a blind dbPut and the new record
  // doesn't include those fields. Data loss on an explicit user action.
  //
  // Preserve ONLY user-owned fields. Poll-derived fields (price, title,
  // images, attributes, location, seller, shipping...) are intentionally
  // refreshed because the ad on LBC may have been edited by the seller.
  //
  // `is_alerted` is special: we reset it so the re-seeded ad is re-evaluated
  // against the current market stats — a seller who dropped their price
  // should be re-alerted. The `first-poll-skips-alerts` guarantee in
  // poller.js ensures this re-evaluation doesn't trigger a notification
  // storm on re-backfill (backfill branch uses isNew=false).
  const existing = await getAd(String(ad.list_id));
  const preservedFlags = existing
    ? {
        is_flagged: !!existing.is_flagged,
        is_archived: !!existing.is_archived,
        is_discarded: !!existing.is_discarded,
        is_messaged: !!existing.is_messaged,
        is_purchased: !!existing.is_purchased,
        ad_status: existing.ad_status,
        notes: existing.notes,
      }
    : {};

  // Extract shipping info — delegated to `resolveShipping()` in shared/utils.js
  // so every surface (poller write, matcher raw-API fallback, dashboard
  // self-heal, inject-badges, inject-adpage) uses the SAME detection logic.
  // Checks 6 paths: pre-processed fields, `attributes[]` keys
  // (`is_shipping_enabled` / `shipping_type`), `options.shippable`,
  // `has_options.shippable`, nested `shipping.enabled`, and cost presence.
  // Single-path detection was the root cause of "🤝 Main propre" showing
  // on every ad + empty "Livraison" column in the Feed — the legacy
  // `is_shipping_enabled` attribute is absent from modern LBC API payloads
  // that use `shipping_type` or `options.shippable` instead.
  const shipping = resolveShipping(ad);
  const isShipping = shipping.enabled;
  const shippingCost = shipping.cost;

  await saveAd({
    id: String(ad.list_id),
    list_id: watchlist.id,
    title: ad.subject || "",
    price,
    category_id: String(ad.category_id || watchlist.category_id || ""),
    location: {
      city: ad.location?.city || "",
      zipcode: ad.location?.zipcode || "",
      lat: ad.location?.lat || 0,
      lng: ad.location?.lng || 0,
    },
    seller_type: ad.owner?.type || "private",
    seller_id: String(ad.owner?.store_id || ad.owner?.user_id || ""),
    url: adUrl(ad.list_id),
    images: ad.images?.urls_large ?? (ad.images?.thumb_url ? [ad.images.thumb_url] : []),
    created_at: ad.first_publication_date ? new Date(ad.first_publication_date).getTime() : Date.now(),
    seen_at: overrideSeenAt ?? Date.now(),
    // indexed_at is ALWAYS Date.now() regardless of backfill. Used by
    // `purgeOldAds` so purging a 30-day-old ad doesn't wipe the just-
    // fetched 365-day backfill (whose `seen_at` intentionally reflects the
    // ad's real publication date for the Feed tab UX). Preserve existing
    // indexed_at on re-seed so a refreshed ad isn't "renewed" forever.
    indexed_at: existing?.indexed_at ?? Date.now(),
    is_alerted: false,
    is_backfill: isBackfill,
    is_messaged: false,
    is_purchased: false,
    is_shipping_enabled: isShipping,
    shipping_cost: shippingCost,
    attributes: ad.attributes || [],
    // Merge LAST so user-curated fields survive a re-seed. Spread order
    // matters: these override any defaults set above.
    ...preservedFlags,
  });
}

// ── Run a full poll cycle (all enabled watchlists) ──

// Module-level mutex. master-poll alarm fires every 30 s but a cycle with many
// watchlists (stagger + jitter + fetch) can exceed that, causing concurrent
// cycles. Concurrent cycles duplicate API calls and persist duplicate
// price_history rows via updateMarketStats(). SW lifetime covers a single
// cycle; if SW is killed, flag resets on next wake — which is what we want.
let _pollCycleInFlight = false;

export async function runPollCycle() {
  if (_pollCycleInFlight) {
    log("Poll cycle skipped (already in flight)");
    return;
  }
  _pollCycleInFlight = true;
  // Suspend the proxy-tab cleanup alarm while polling is active so it doesn't
  // close the proxy tab mid-poll or mid-backfill. We re-arm it at the end.
  // Without this, a backfill that takes >10 min (or a run of many watchlists)
  // has its proxy tab killed by the cleanup alarm and has to re-open it.
  swallowChromeCall(() => chrome.alarms.clear("proxy-poll-tab-cleanup"));
  try {
    const watchlists = await getEnabledWatchlists();
    if (!watchlists.length) return;

    for (let i = 0; i < watchlists.length; i++) {
      const wl = watchlists[i];
      const now = Date.now();
      const interval = (wl.poll_interval_seconds || 60) * 1000;
      const lastPoll = wl.last_polled_at || 0;

      // Also bypass the interval gate when a backfill is pending — the user
      // explicitly requested a seed and waiting up to `poll_interval_seconds`
      // (potentially hours) before the first retry is unacceptable. Without this
      // bypass a transient failure on the initial FORCE_POLL (no LBC tab open at
      // save time, session not yet captured, network blip on page 1) sets
      // `last_polled_at` via the `no_tab` error handler and the regular cycle
      // then skips the watchlist for the full poll interval — the user sees
      // "en cours" for hours with zero ads loaded.
      const hasPendingBackfill = (wl.pending_backfill_days ?? 0) > 0;
      if (now - lastPoll >= interval || hasPendingBackfill) {
        // Stagger: 2s delay per watchlist index.
        // MUST use swKeepAlive (not sleep) — sleep() is a bare setTimeout with no
        // Chrome API keep-alive anchor. Chrome kills MV3 SWs during idle sleeps,
        // resetting _pollCycleInFlight=false. The next 30s alarm then restarts the
        // cycle from scratch, and watchlists at index > 0 are never reached.
        if (i > 0) await swKeepAlive(i * 2000);
        // Jitter: skip for first-ever poll (needs backfill ASAP), small for recurring.
        // Keep under 3s — 10s caused SW lifetime issues with many watchlists.
        await swKeepAlive(lastPoll === 0 ? Math.random() * 500 : Math.random() * 3000);
        try {
          await pollWatchlist(wl);
        } catch (e) {
          warn("Poll error:", e.message);
        }
      }
    }
  } finally {
    _pollCycleInFlight = false;
    // Re-arm the proxy tab cleanup alarm now that the poll cycle is done.
    // It fires 10 min after the last poll cycle — if no new cycle starts by
    // then (browser idle, no watchlists, etc.), the proxy tab is closed.
    if (_proxyTabId) {
      chrome.alarms.create("proxy-poll-tab-cleanup", { delayInMinutes: 10 });
    }
  }
}

// ── Test-only exports (internal functions exposed for unit testing) ──
// Not part of the public API — do NOT import these from production code.
export const __test__ = { buildSearchBody };
