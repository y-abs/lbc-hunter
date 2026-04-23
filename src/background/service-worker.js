// ─────────────────────────────────────────────
//  LbC Hunter — Service Worker (MV3)
//  Entry point for all background logic.
// ─────────────────────────────────────────────

import { MSG } from "@/shared/messages.js";
import { SESSION_TTL_MS, SESSION_REFRESH_INTERVAL_MIN } from "@/shared/constants.js";
import {
  saveSession,
  getSession,
  clearSession,
  getAd,
  getWatchlists,
  getAlertedAds,
  getLatestMarketStats,
  getPriceHistory,
  dbGet,
  purgePriceHistory,
  discardAd,
} from "@/db/indexeddb.js";
import { STORES } from "@/db/schema.js";
import { runPollCycle, pollWatchlist, cleanupProxyPollTab } from "@/core/poller.js";
import { clearBadge, decrementCount, getPendingCount, _updateLiteNotifs } from "@/core/notifier.js";
import { attemptCheckout } from "@/core/automator.js";
import { log, warn } from "@/shared/utils.js";

// ── Global state ─────────────────────────────

let isPaused = false;
let fullAutoPaused = true; // Full auto OFF by default — user must explicitly enable
let pendingRefreshTabId = null; // tab opened invisibly for session refresh
const SECURITY_COUNTERS_KEY = "security_counters";

async function bumpSecurityCounter(name, details = null) {
  if (typeof name !== "string" || !name) return;
  try {
    const current = await chrome.storage.local.get(SECURITY_COUNTERS_KEY);
    const counters = current?.[SECURITY_COUNTERS_KEY] || {};
    const next = {
      ...counters,
      [name]: (counters[name] || 0) + 1,
      last_event_at: Date.now(),
      total: (counters.total || 0) + 1,
      last_event: details || { name },
    };
    await chrome.storage.local.set({ [SECURITY_COUNTERS_KEY]: next });
  } catch (_) {
    // best effort telemetry
  }
}

// Restore persisted state immediately when SW wakes up (killed & respawned by Chrome).
// Both flags are module-level; without persistence they'd silently reset on every SW
// restart, losing the user's pause/kill-switch intent.
//
// ⚑ RACE: chrome.storage.session.get(...) is async. If the SW was just woken by an
// alarm event, onAlarm may fire BEFORE this promise resolves and would read the
// defaults (isPaused=false, fullAutoPaused=true), silently overriding the user's
// pause intent. Every consumer MUST `await _stateRestored` before reading these
// flags. Exported as a module-scope promise so the handler can gate on it.
const _stateRestored = (async () => {
  try {
    const r = await chrome.storage.session.get(["full_auto_paused", "is_paused"]);
    if (r && r.full_auto_paused !== undefined) fullAutoPaused = !!r.full_auto_paused;
    if (r && r.is_paused !== undefined) isPaused = !!r.is_paused;
  } catch (_) {
    /* default values remain */
  }
})();

// ── Alarm bootstrap ───────────────────────────

function ensureAlarms() {
  chrome.alarms.get("master-poll", (a) => {
    if (!a) chrome.alarms.create("master-poll", { periodInMinutes: 0.5 });
  });
  chrome.alarms.get("session-check", (a) => {
    if (!a) chrome.alarms.create("session-check", { periodInMinutes: 30 });
  });
  chrome.alarms.get("session-refresh", (a) => {
    if (!a) chrome.alarms.create("session-refresh", { periodInMinutes: SESSION_REFRESH_INTERVAL_MIN });
  });
  chrome.alarms.get("email-report", (a) => {
    if (!a) chrome.alarms.create("email-report", { periodInMinutes: 60 });
  });
  chrome.alarms.get("daily-cleanup", (a) => {
    if (!a) chrome.alarms.create("daily-cleanup", { periodInMinutes: 1440 });
  });
}

// ⚑ CRITICAL: run eagerly every time the SW script is evaluated (install, startup,
// OR any Chrome-triggered wakeup). Ensures alarms are never permanently lost even
// if Chrome drops them while the SW was idle — the callback-based get/create is
// non-blocking and safe to call here unconditionally.
ensureAlarms();

// On every SW wakeup, if there is no valid session, trigger a refresh immediately
// rather than waiting up to 45 min for the session-refresh alarm to fire.
// This covers the cold-start case where the user opens Chrome and the LBC tab is
// already loaded but SESSION_CAPTURED hasn't been sent yet.
(async () => {
  try {
    const session = await getSession();
    const fresh = session && Date.now() - session.captured_at < 30 * 60 * 1000;
    if (!fresh) {
      // Short delay so the LBC tab has time to reach status:'complete' after browser start
      chrome.alarms.create("startup-session-check", { delayInMinutes: 0.25 }); // 15 s
    }
  } catch (_) {
    // best effort startup check only
  }
})();

chrome.runtime.onInstalled.addListener((details) => {
  log("Extension installed / updated:", details.reason);
  // Only default full_auto_paused to true on a FRESH install. The prior
  // unconditional reset silently disabled full-auto for every user whenever
  // Chrome auto-updated the extension — a behaviour the user had explicitly
  // opted into, reverted without any UI affordance.
  if (details.reason === "install") {
    chrome.storage.session.set({ full_auto_paused: true });
  }
  ensureAlarms();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  ensureAlarms(); // re-create if SW was killed and alarms dropped
  await _stateRestored; // must observe persisted pause state before any alarm acts

  if (alarm.name === "master-poll") {
    if (!isPaused) {
      await runPollCycle().catch((e) => warn("Poll cycle error:", e.message));
      await _updatePollErrorBadge().catch(() => {});
    }
  }
  if (alarm.name === "session-check") {
    await checkSessionHealth();
  }
  if (alarm.name === "session-refresh") {
    await autoRefreshSession();
  }
  if (alarm.name === "email-report") {
    await checkEmailReportSchedule();
  }
  if (alarm.name === "daily-cleanup") {
    await purgePriceHistory().catch((e) => warn("purgePriceHistory error:", e.message));
  }
  if (alarm.name === "startup-session-check") {
    await autoRefreshSession();
  }
  if (alarm.name === "proxy-poll-tab-cleanup") {
    await cleanupProxyPollTab().catch((e) => warn("Proxy tab cleanup error:", e.message));
  }
  if (alarm.name === "refresh-tab-timeout") {
    // Safety cleanup: if background refresh tab was never closed, close it now
    const { pending_refresh_tab } = await chrome.storage.session.get("pending_refresh_tab");
    if (pending_refresh_tab) {
      chrome.tabs.remove(pending_refresh_tab).catch(() => {});
      await chrome.storage.session.remove("pending_refresh_tab");
      pendingRefreshTabId = null;
      warn("Background refresh tab closed (1-min timeout alarm)");
    }
  }
  if (alarm.name === "checkout-tab-ready") {
    // Safety: only fires if the checkout tab never reached status:'complete'.
    // We store {tabId, mode} so we know whether to force-close. For `full` mode
    // the tab is a hidden background tab — safe to remove. For `lite` it's the
    // user's ACTIVE foreground tab — removing it would yank the page the user
    // is looking at, so we only clear the pending marker.
    const { checkout_pending_tab } = await chrome.storage.session.get("checkout_pending_tab");
    if (checkout_pending_tab) {
      const { tabId, mode } =
        typeof checkout_pending_tab === "object" ? checkout_pending_tab : { tabId: checkout_pending_tab, mode: "full" }; // legacy format safety
      if (mode === "full") {
        // Race guard: if `complete` fired concurrently with this alarm, the
        // automator's onUpdated handler may have already resolved and the tab
        // is perfectly healthy. Re-check tab status before killing it.
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && tab.status !== "complete") {
          chrome.tabs.remove(tabId).catch(() => {});
          warn("Checkout tab closed (30s timeout alarm — tab never loaded)");
        } else {
          warn("Checkout alarm fired but tab already complete — not closing");
        }
      } else {
        warn("Checkout tab load timeout reached — leaving foreground lite tab open");
      }
      await chrome.storage.session.remove("checkout_pending_tab");
    }
  }
});

// ── Poll error badge ──────────────────────────
// Shows a ⚠ badge (orange) when consecutive poll failures accumulate.
// Alert count badge (red) always takes priority — errors only surface when idle.

async function _updatePollErrorBadge() {
  const watchlists = await getWatchlists();
  const failingCount = watchlists.filter((w) => w.enabled && (w.consecutive_poll_failures ?? 0) >= 5).length;

  if (failingCount > 0 && getPendingCount() === 0) {
    chrome.action.setBadgeText({ text: "⚠" });
    chrome.action.setBadgeBackgroundColor({ color: "#FFC300" });
  } else if (failingCount === 0 && getPendingCount() === 0) {
    // All watchlists healthy again — clear any lingering error badge
    chrome.action.setBadgeText({ text: "" });
  }
  // If getPendingCount() > 0, alert badge is already set — don't touch it
}

// ── Session health ────────────────────────────

async function checkSessionHealth() {
  const session = await getSession();
  if (!session) {
    chrome.action.setBadgeText({ text: "⚠" });
    chrome.action.setBadgeBackgroundColor({ color: "#FFC300" });
    return;
  }
  const age = Date.now() - session.captured_at;
  if (age > SESSION_TTL_MS) {
    await clearSession();
    await bumpSecurityCounter("session_zeroized_ttl_expired", { age });
    warn("Session stale, triggering auto-refresh");
    await autoRefreshSession();
  }
}

// ── Session auto-refresh ──────────────────────
// If LBC tab exists → send REFRESH_SESSION to content script (fastest path).
// If not → open invisible background LBC tab → wait for SESSION_CAPTURED → close it.

async function autoRefreshSession() {
  const session = await getSession();
  // Skip if session captured within last 30 min
  if (session && Date.now() - session.captured_at < 30 * 60 * 1000) {
    log("Session fresh (<30 min) — skipping refresh");
    return;
  }

  const lbcTabs = await chrome.tabs.query({ url: "*://www.lbc.fr/*", status: "complete" });
  if (lbcTabs.length) {
    try {
      await chrome.tabs.sendMessage(lbcTabs[0].id, { type: MSG.REFRESH_SESSION });
      log("Session refresh triggered on existing LBC tab");
      return; // content script received it — SESSION_CAPTURED will follow
    } catch (e) {
      warn("REFRESH_SESSION failed on LBC tab (" + e.message + ") — opening background tab as fallback");
      // Fall through to background tab creation below
    }
  }

  // No LBC tab — open one in the background
  if (pendingRefreshTabId) return; // already waiting for one
  // Also check storage in case SW was restarted
  const stored = await chrome.storage.session.get("pending_refresh_tab");
  if (stored.pending_refresh_tab) {
    pendingRefreshTabId = stored.pending_refresh_tab;
    return;
  }
  try {
    const tab = await chrome.tabs.create({ url: "https://www.lbc.fr/", active: false });
    pendingRefreshTabId = tab.id;
    await chrome.storage.session.set({ pending_refresh_tab: tab.id });
    log("Background LBC tab opened for session refresh — tabId:", tab.id);
    // Safety: close after 1 min via alarm (setTimeout banned in SW)
    chrome.alarms.create("refresh-tab-timeout", { delayInMinutes: 1 });
  } catch (e) {
    warn("Could not open background LBC tab:", e.message);
  }
}

// ── Email report schedule ─────────────────────

async function checkEmailReportSchedule() {
  const stored = await chrome.storage.local.get([
    "email_report_enabled",
    "email_report_hour",
    "email_report_last_sent",
    "email_report_addr",
  ]);
  if (!stored.email_report_enabled) return;
  if (!stored.email_report_addr) return; // no recipient configured — skip silently

  const now = new Date();
  const today = now.toDateString();
  if (stored.email_report_last_sent === today) return;
  if (now.getHours() !== (stored.email_report_hour ?? 8)) return;

  await chrome.storage.local.set({ email_report_last_sent: today });

  // Compute report window and recipient — must be included in the message
  // so options.js can call buildReport({ from, to, watchlistIds }) correctly.
  const to = Date.now();
  const from = to - 7 * 86_400_000; // last 7 days

  // Delegate to options page (needs DOM for mailto:/EmailJS dispatch).
  // Query specifically for options.html — popup and dashboard do NOT have a
  // MSG.GENERATE_REPORT handler; sending there silently drops the report.
  const pages = await chrome.tabs.query({ url: chrome.runtime.getURL("src/options/options.html") });
  if (pages.length) {
    chrome.tabs
      .sendMessage(pages[0].id, {
        type: MSG.GENERATE_REPORT,
        from,
        to,
        email: stored.email_report_addr,
        watchlistIds: [],
      })
      .catch(() => {});
  } else {
    // No extension page open — open one in background and store the report params so
    // options.js can pick them up at init time and auto-trigger generation.
    await chrome.storage.session.set({
      pending_auto_report: { from, to, email: stored.email_report_addr },
    });
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/options/options.html") + "#auto-report",
      active: false,
    });
  }
}

// ── Message routing ───────────────────────────

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidMessageEnvelope(msg) {
  return isPlainObject(msg) && typeof msg.type === "string" && msg.type.length <= 64;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isValidMessageEnvelope(msg)) {
    bumpSecurityCounter("blocked_message_envelope", {
      source: "service-worker",
      sender: sender?.id || null,
      reason: "invalid_message",
    });
    sendResponse({ ok: false, error: "invalid_message" });
    return false;
  }
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((e) => {
      warn("Message handler error:", e.message);
      sendResponse({ ok: false, error: e.message });
    });
  return true;
});

async function handleMessage(msg, sender) {
  ensureAlarms(); // belt & suspenders
  await _stateRestored; // ensure pause flags reflect persisted state before any branch reads them

  switch (msg.type) {
    case MSG.SESSION_CAPTURED: {
      if (typeof msg.apiKey !== "string" || msg.apiKey.length < 1 || msg.apiKey.length > 1024) {
        await bumpSecurityCounter("schema_rejection", {
          source: "service-worker",
          reason: "invalid_api_key",
        });
        return { ok: false, error: "invalid_api_key" };
      }
      if (msg.userAgent != null && (typeof msg.userAgent !== "string" || msg.userAgent.length > 512)) {
        await bumpSecurityCounter("schema_rejection", {
          source: "service-worker",
          reason: "invalid_user_agent",
        });
        return { ok: false, error: "invalid_user_agent" };
      }
      await saveSession(msg.apiKey, msg.userAgent);
      log("Session captured, api_key stored");

      // SW may have restarted between opening the refresh tab and receiving
      // SESSION_CAPTURED, which loses module-level pendingRefreshTabId.
      // Recover from session storage so cleanup remains reliable.
      if (!pendingRefreshTabId) {
        const stored = await chrome.storage.session.get("pending_refresh_tab");
        pendingRefreshTabId = stored.pending_refresh_tab ?? null;
      }

      // Close the background refresh tab if we opened it
      if (pendingRefreshTabId && sender.tab?.id === pendingRefreshTabId) {
        chrome.tabs.remove(pendingRefreshTabId).catch(() => {});
        chrome.alarms.clear("refresh-tab-timeout").catch(() => {});
        await chrome.storage.session.remove("pending_refresh_tab");
        pendingRefreshTabId = null;
        log("Background refresh tab closed after capture");
      }
      if (isPaused) {
        isPaused = false;
        // Persist the unpause — without this, the next SW cold-wake reads
        // the stale `is_paused: true` from session storage via `_stateRestored`
        // and silently re-pauses, clobbering the auto-resume that just fired.
        // User-visible symptom: session gets re-captured (good) but polling
        // stays paused after any SW restart (~every 5 min of idle).
        await chrome.storage.session.set({ is_paused: false });
        chrome.action.setBadgeText({ text: "" });
      }
      return { ok: true };
    }

    case MSG.FORCE_POLL: {
      if (msg.watchlistId != null && typeof msg.watchlistId !== "string") {
        await bumpSecurityCounter("schema_rejection", {
          source: "service-worker",
          reason: "invalid_watchlist_id",
        });
        return { ok: false, error: "invalid_watchlist_id" };
      }
      let wl;
      if (msg.watchlistId) {
        const all = await getWatchlists();
        wl = all.find((w) => w.id === msg.watchlistId);
        // If the caller targeted a specific watchlist but it doesn't exist
        // (deleted between UI render and click), surface an error instead of
        // silently falling through to `runPollCycle()` which would poll
        // EVERY watchlist — a very surprising side-effect of clicking ▶ on
        // a single deleted card.
        if (!wl) return { ok: false, error: "watchlist_not_found" };
      }
      if (wl) {
        const result = await pollWatchlist(wl);
        return { ok: true, result };
      }
      await runPollCycle();
      return { ok: true };
    }

    case MSG.PAUSE_ALL: {
      isPaused = true;
      await chrome.storage.session.set({ is_paused: true });
      log("Polling paused");
      return { ok: true };
    }
    case MSG.RESUME_ALL: {
      isPaused = false;
      await chrome.storage.session.set({ is_paused: false });
      log("Polling resumed");
      return { ok: true };
    }
    case MSG.CLEAR_BADGE: {
      clearBadge();
      return { ok: true };
    }
    case MSG.DECREMENT_BADGE: {
      decrementCount();
      return { ok: true };
    }

    case MSG.TOGGLE_FULL_AUTO: {
      if (msg.enabled != null && typeof msg.enabled !== "boolean") {
        await bumpSecurityCounter("schema_rejection", {
          source: "service-worker",
          reason: "invalid_toggle_state",
        });
        return { ok: false, error: "invalid_toggle_state" };
      }
      if (msg.paused != null && typeof msg.paused !== "boolean") {
        await bumpSecurityCounter("schema_rejection", {
          source: "service-worker",
          reason: "invalid_toggle_state",
        });
        return { ok: false, error: "invalid_toggle_state" };
      }
      // msg.enabled ∈ { true, false } from popup; msg.paused for legacy callers
      if (msg.enabled !== undefined) fullAutoPaused = !msg.enabled;
      else if (msg.paused !== undefined) fullAutoPaused = !!msg.paused;
      else fullAutoPaused = !fullAutoPaused; // toggle
      await chrome.storage.session.set({ full_auto_paused: fullAutoPaused });
      log("Full auto:", fullAutoPaused ? "PAUSED" : "ACTIVE");
      return { ok: true, fullAutoPaused };
    }

    case MSG.GET_STATUS: {
      const session = await getSession();
      let telemetry = {};
      try {
        telemetry = await chrome.storage.local.get(SECURITY_COUNTERS_KEY);
      } catch (_) {
        telemetry = {};
      }
      const sessionStale = session ? Date.now() - session.captured_at > SESSION_TTL_MS : true;
      const tabs = await chrome.tabs.query({ url: "*://www.lbc.fr/*" });
      const watchlists = await getWatchlists();
      const failingCount = watchlists.filter((w) => w.enabled && (w.consecutive_poll_failures ?? 0) >= 5).length;
      return {
        ok: true,
        isPaused,
        fullAutoPaused,
        hasSession: !!session?.api_key,
        sessionStale,
        sessionAge: session ? Math.round((Date.now() - session.captured_at) / 60000) : null,
        refreshCount: session?.refresh_count ?? 0,
        hasLbcTab: tabs.length > 0,
        alertCount: getPendingCount(),
        pollErrors: failingCount,
        securityCounters: telemetry?.[SECURITY_COUNTERS_KEY] || {},
      };
    }

    case MSG.SECURITY_EVENT: {
      if (typeof msg.event !== "string" || msg.event.length > 64) {
        await bumpSecurityCounter("schema_rejection", {
          source: "service-worker",
          reason: "invalid_security_event",
        });
        return { ok: false, error: "invalid_security_event" };
      }
      await bumpSecurityCounter(msg.event, {
        source: typeof msg.source === "string" ? msg.source : "unknown",
        reason: typeof msg.reason === "string" ? msg.reason : null,
      });
      return { ok: true };
    }

    case MSG.CONFIRM_PURCHASE: {
      if (typeof msg.adId !== "string" || typeof msg.watchlistId !== "string") {
        return { ok: false, error: "invalid_purchase_payload" };
      }
      const ad = await getAd(msg.adId);
      if (!ad) return { ok: false, error: "Ad not found" };
      const allWl = await getWatchlists();
      const watchlist = allWl.find((w) => w.id === msg.watchlistId);
      if (!watchlist) return { ok: false, error: "Watchlist not found" };
      await attemptCheckout(ad, "lite", watchlist);
      return { ok: true };
    }

    case MSG.DISCARD_AD: {
      if (typeof msg.adId !== "string" || !msg.adId) {
        await bumpSecurityCounter("schema_rejection", {
          source: "service-worker",
          reason: "invalid_discard_payload",
        });
        return { ok: false, error: "invalid_discard_payload" };
      }
      const ad = await getAd(msg.adId);
      if (!ad) return { ok: false, error: "Ad not found" };
      const wasAlerted = !!ad.is_alerted;
      const discarded = await discardAd(msg.adId);
      if (discarded && wasAlerted) decrementCount();
      return { ok: true, discarded };
    }

    case MSG.DB_QUERY: {
      // Content scripts (inject-badges, inject-sidebar, inject-adpage) live
      // under the page's origin for Web Storage APIs and cannot read the
      // extension-origin IDB directly. Route a small, read-only allowlist of
      // operations through the SW. Only arguments are accepted, never function
      // references; the op dispatcher below enforces the allowlist.
      try {
        if (typeof msg.op !== "string" || msg.op.length > 64) {
          await bumpSecurityCounter("schema_rejection", {
            source: "service-worker",
            reason: "invalid_db_op",
          });
          return { ok: false, error: "invalid_db_op" };
        }
        const args = Array.isArray(msg.args) ? msg.args : [];
        switch (msg.op) {
          case "getAd":
            return { ok: true, result: await getAd(String(args[0])) };
          case "getWatchlist":
            return { ok: true, result: await dbGet(STORES.WATCHLISTS, args[0]) };
          case "getLatestMarketStats":
            return { ok: true, result: await getLatestMarketStats(args[0], args[1] ?? null) };
          case "getPriceHistory":
            return { ok: true, result: await getPriceHistory(args[0], args[1] ?? null, args[2] ?? 90) };
          case "getAlertedAds":
            return { ok: true, result: await getAlertedAds(args[0] ?? 20) };
          default:
            await bumpSecurityCounter("schema_rejection", {
              source: "service-worker",
              reason: "unknown_db_op",
            });
            return { ok: false, error: "unknown db op" };
        }
      } catch (e) {
        await bumpSecurityCounter("db_query_error", {
          source: "service-worker",
          reason: e.message,
        });
        return { ok: false, error: e.message };
      }
    }

    default:
      await bumpSecurityCounter("blocked_message_type", {
        source: "service-worker",
        reason: msg.type,
      });
      return { ok: false, error: "unknown message type" };
  }
}

// ── Notification button handler (lite-purchase Buy = index 1 in lite alerts) ──────
// Chrome notifications support only 2 buttons. In lite-purchase alerts, button 1 is Buy
// (replacing the normal Message button). We disambiguate via pending_purchase.notifId —
// only notifs that populated pending_purchase are lite-purchase alerts, so the non-lite
// case is a harmless no-op here (notifier.js handles Message in the non-lite branch).

chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
  if (buttonIndex !== 1) return; // 0 = view — handled in notifier.js
  // Synchronous discrimination via notifId prefix — race-free with notifier.js's
  // concurrent handler (see notifier.js fireAlert for rationale). A `lite_purchase_notifs`
  // storage read here cannot be used to classify: by the time we read it, notifier.js may
  // have already pruned the entry (or vice versa), leading to one handler mis-firing.
  if (!notifId.startsWith("alert-lite-")) return; // normal alert — notifier.js runs Message
  const { lite_purchase_notifs } = await chrome.storage.session.get("lite_purchase_notifs");
  const pending = lite_purchase_notifs?.[notifId];
  if (!pending) return; // lite notif but map entry already consumed

  const ad = await getAd(pending.adId);
  const allWl = await getWatchlists();
  const watchlist = allWl.find((w) => w.id === pending.watchlistId);
  // Guard both ad and watchlist — either may be deleted between alert creation and button click
  if (ad && watchlist) await attemptCheckout(ad, "lite", watchlist).catch((e) => warn("Checkout error:", e.message));
  // Remove only this notif's entry — leave any other pending lite-purchase notifs intact.
  // Serialised via `_updateLiteNotifs` — a parallel fireAlert in notifier.js
  // must not race this delete (racing get→set would silently resurrect the
  // consumed entry OR drop a concurrently-added one).
  await _updateLiteNotifs((map) => {
    if (!map[notifId]) return null;
    delete map[notifId];
    return map;
  });
  chrome.notifications.clear(notifId);
});

// ── Startup ───────────────────────────────────

// Clean up orphaned background refresh tab if user manually closes it
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === pendingRefreshTabId) {
    pendingRefreshTabId = null;
    await chrome.storage.session.remove("pending_refresh_tab").catch(() => {});
    chrome.alarms.clear("refresh-tab-timeout").catch(() => {});
    log("Background refresh tab was closed externally");
  }
});

chrome.runtime.onStartup.addListener(async () => {
  ensureAlarms();
  await checkSessionHealth();
  log("Service worker started");
});
