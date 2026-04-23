// ─────────────────────────────────────────────
//  LbC Hunter — message type constants
//  All chrome.runtime messages must use these.
// ─────────────────────────────────────────────

export const MSG = {
  // content → background
  SESSION_CAPTURED: "SESSION_CAPTURED", // { apiKey, userAgent }
  SECURITY_EVENT: "SECURITY_EVENT", // { event, source?, reason? }

  // background → content
  EXECUTE_FETCH: "EXECUTE_FETCH", // { url, options, requestId }
  INJECT_MESSAGE_FORM: "INJECT_MESSAGE_FORM", // { adUrl, messageBody }

  // popup/options → background
  FORCE_POLL: "FORCE_POLL", // { watchlistId }
  PAUSE_ALL: "PAUSE_ALL",
  RESUME_ALL: "RESUME_ALL",
  CLEAR_BADGE: "CLEAR_BADGE",
  DECREMENT_BADGE: "DECREMENT_BADGE", // popup: dismiss a single alert (−1 count)
  GET_STATUS: "GET_STATUS", // → { session, paused, alertCount }

  // background → popup
  ALERT_FIRED: "ALERT_FIRED", // { ad, matchResult, watchlist }
  POLL_STATUS: "POLL_STATUS", // { watchlistId, phase: 'backfill_start'|'backfill_done'|'backfill_error', days, count?, durationMs?, reason?, message?, timestamp }

  // offscreen
  PLAY_SOUND: "PLAY_SOUND", // { tier: 'red' | 'orange' }

  // session keep-alive
  REFRESH_SESSION: "REFRESH_SESSION", // background → content: force re-capture

  // background → content: liveness check (synchronous pong — detects Memory-Saver-frozen tabs)
  PING: "PING",

  TOGGLE_FULL_AUTO: "TOGGLE_FULL_AUTO", // popup → background: toggle full-auto mode

  // purchase flow
  CONFIRM_PURCHASE: "CONFIRM_PURCHASE", // { adId, watchlistId }
  REJECT_PURCHASE: "REJECT_PURCHASE", // { adId }

  // content → background: permanently discard an ad everywhere
  DISCARD_AD: "DISCARD_AD", // { adId }

  // email reports
  GENERATE_REPORT: "GENERATE_REPORT", // { from, to, watchlistIds, email } → options page

  // content-script → background IDB proxy.
  // CRITICAL: Chrome content scripts run in an isolated JS world but share
  // the *page's* origin for Web Storage (IndexedDB, localStorage, Cache API).
  // A content script on leboncoin.fr that calls `openDB('lbc-hunter-db')`
  // opens a DIFFERENT database than the service worker's extension-origin DB.
  // All content-script reads (badges, sidebar, ad-page chart) MUST proxy
  // through the SW via this message; otherwise every read returns empty.
  DB_QUERY: "DB_QUERY", // { op, args } → op-specific result
};
