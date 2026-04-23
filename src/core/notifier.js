// ─────────────────────────────────────────────
//  LbC Hunter — Notification Dispatcher
// ─────────────────────────────────────────────

import { MSG } from "@/shared/messages.js";
import { log, warn, adUrl, lbcAdUrl } from "@/shared/utils.js";
import { getAd, dbGet } from "@/db/indexeddb.js";
import { STORES } from "@/db/schema.js";
import { sendAutoMessage } from "./automator.js";

let _pendingCount = 0;

const NTFY_MAX_INFLIGHT = 1;
const NTFY_QUEUE_MAX = 25;
let _ntfyInFlight = 0;
let _ntfyDropped = 0;
const _ntfyQueue = [];

function _drainNtfyQueue() {
  while (_ntfyInFlight < NTFY_MAX_INFLIGHT && _ntfyQueue.length > 0) {
    const payload = _ntfyQueue.shift();
    _ntfyInFlight++;
    sendNtfyNotification(payload)
      .catch(() => {})
      .finally(() => {
        _ntfyInFlight--;
        if (_ntfyInFlight === 0 && _ntfyQueue.length === 0 && _ntfyDropped > 0) {
          warn(`ntfy queue dropped ${_ntfyDropped} notification(s) due to backpressure`);
          _ntfyDropped = 0;
        }
        _drainNtfyQueue();
      });
  }
}

export function enqueueNtfyNotification(payload) {
  if (_ntfyQueue.length >= NTFY_QUEUE_MAX) {
    _ntfyDropped++;
    return false;
  }
  _ntfyQueue.push(payload);
  _drainNtfyQueue();
  return true;
}

export function __getNtfyQueueStats() {
  return {
    inFlight: _ntfyInFlight,
    queued: _ntfyQueue.length,
    dropped: _ntfyDropped,
  };
}

export function __resetNtfyQueueForTests() {
  _ntfyQueue.length = 0;
  _ntfyInFlight = 0;
  _ntfyDropped = 0;
}

// Restore badge count across SW restarts (session storage survives SW death within browser session).
// ⚑ RACE: `chrome.storage.session.get(...)` is async, and between SW wakeup and
// the .then() resolving the listeners registered below can fire, reading the
// default `_pendingCount = 0` and mis-computing the badge. Every consumer
// (clearBadge / decrement / incrementCount / onButton...) must `await
// _countRestored` before touching _pendingCount so persisted value wins the
// race.
const _countRestored = (async () => {
  try {
    const r = await chrome.storage.session.get("alert_count");
    if (r && r.alert_count > 0) {
      _pendingCount = r.alert_count;
      updateBadge(_pendingCount);
    }
  } catch (_e) {
    // storage is not available in this context
  }
})();

function _persistCount() {
  if (chrome.storage && chrome.storage.session) {
    try {
      const maybePromise = chrome.storage.session.set({ alert_count: _pendingCount });
      if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
    } catch (_) {
      // storage API unavailable in current test/runtime context
    }
  }
}

/**
 * Fire a Chrome notification for a matched deal.
 */
export async function fireAlert(ad, watchlist, matchResult) {
  await _countRestored; // ensure badge count is up-to-date before incrementing
  const adId = String(ad.list_id || ad.id);
  const price = Array.isArray(ad.price) ? ad.price[0] : ad.price;

  const title =
    matchResult.alert_tier === "red" ? `🔴 DEAL ALERT — ${watchlist.name}` : `🟠 Nouvelle annonce — ${watchlist.name}`;

  const pctText =
    matchResult.pct_below_market != null ? ` (−${Math.round(Math.abs(matchResult.pct_below_market))}% vs marché)` : "";

  const city = ad.location?.city || "";
  // Raw API ads expose seller type at `ad.owner.type` (values: 'pro' | 'private').
  // IDB-persisted ads also carry a flattened `seller_type` copy written by
  // persistAd. Read `owner.type` first so the notification fires with the
  // correct badge even when the ad object coming from the poll cycle has not
  // yet been round-tripped through IDB. The prior `ad.seller_type` check was
  // always undefined for the poll-cycle path — every alert announced
  // "Particulier" even for pro sellers, misleading users who filter pro out.
  const sellerTypeRaw = ad.owner?.type ?? ad.seller_type;
  const sellerBadge = sellerTypeRaw === "pro" ? " · Pro" : " · Particulier";

  // Shipping cost display
  let priceText = `${price}€${pctText}`;
  if (matchResult.is_shipping && matchResult.shipping_cost != null) {
    priceText = `${price}€ + ${matchResult.shipping_cost}€ livraison = ${matchResult.estimated_total}€${pctText}`;
  } else if (matchResult.is_shipping) {
    priceText = `${price}€ 🚚 livraison dispo${pctText}`;
  }

  const body = `${ad.subject || ad.title}\n${priceText}${city ? " · " + city : ""}${sellerBadge}`;
  const iconUrl = ad.images?.urls_large?.[0] || ad.images?.[0] || "assets/icons/icon128.png";

  _pendingCount++;
  updateBadge(_pendingCount);
  _persistCount();

  // Build notification buttons.
  // Chrome's chrome.notifications API caps buttons at 2 — a 3rd button is silently dropped.
  // In lite-purchase mode we replace the Message button with the Buy button.
  const isLitePurchase = matchResult.alert_tier === "red" && watchlist.purchase_mode === "lite";
  const buttons = isLitePurchase
    ? [{ title: "👁 Voir l'annonce" }, { title: "🛒 Acheter maintenant" }]
    : [{ title: "👁 Voir l'annonce" }, { title: "✉ Envoyer message" }];

  // Distinct notifId prefixes let BOTH button handlers (this module + service-worker.js)
  // classify the click synchronously, without a racing `chrome.storage.session.get` read.
  // The prior "read lite_purchase_notifs to discriminate" approach TOCTOU'd: if the SW
  // handler ran first and deleted the map entry before this module read it, the click was
  // misclassified as "Message" and triggered an unwanted auto-message in addition to the
  // checkout. Prefix check is race-free.
  const notifId = isLitePurchase ? `alert-lite-${adId}` : `alert-${adId}`;

  chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl,
    title,
    message: body,
    buttons,
    priority: matchResult.alert_tier === "red" ? 2 : 1,
    requireInteraction: matchResult.alert_tier === "red",
  });

  // Store pending purchase info for button-click handler.
  // Keyed MAP (not a scalar slot) — two concurrent lite alerts would otherwise
  // overwrite each other, killing the Buy button on the earlier notif AND
  // causing notifier.js to mis-classify the click as a Message request.
  //
  // Serialised via `_updateLiteNotifs` Promise-chain lock — chrome.storage.session
  // offers no atomic update primitive, and fireAlert / _pruneLiteNotifEntry can
  // run concurrently when a FORCE_POLL for watchlist B fires in parallel with a
  // master-cycle alert for watchlist A (the per-watchlist `_wlInflight` lock in
  // poller.js serialises same-watchlist polls, not cross-watchlist ones). A
  // racing get→set would silently drop the earlier entry, breaking the Buy
  // button handler which then falls through to the Message branch.
  if (isLitePurchase) {
    await _updateLiteNotifs((map) => {
      map[notifId] = { adId, watchlistId: watchlist.id, price };
      return map;
    });
  }

  // Play sound through offscreen document
  await playAlertSound(matchResult.alert_tier, watchlist);

  // Send phone push via ntfy.sh with bounded async queue (non-blocking).
  enqueueNtfyNotification({ ad, adId, price, matchResult, watchlist, body: priceText, city });

  log(`Alert fired: [${matchResult.alert_tier}] ${ad.subject || ad.title} @ ${price}€`);
}

export async function playAlertSound(tier, _watchlist) {
  try {
    // Check sound pref
    const stored = chrome.storage?.local?.get ? await chrome.storage.local.get("sound_pref") : {};
    const pref = stored?.sound_pref ?? "both";
    if (pref === "none") return;
    if (pref === "red" && tier !== "red") return;

    try {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play alert sound for deal notification",
      });
    } catch (_) {
      // ignore "already exists" and unsupported contexts
    }

    try {
      const maybePromise = chrome.runtime.sendMessage({ type: MSG.PLAY_SOUND, tier });
      if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
    } catch (_) {
      // best effort only
    }
  } catch (e) {
    log("Audio offscreen error:", e);
  }
}

export function updateBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: "#E63946" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

export function clearBadge() {
  _countRestored.then(() => {
    _pendingCount = 0;
    updateBadge(0);
    _persistCount();
  });
}

export function getPendingCount() {
  return _pendingCount;
}

// Increment badge for a new ad that didn't trigger a Chrome notification
export function incrementCount() {
  _countRestored.then(() => {
    _pendingCount++;
    updateBadge(_pendingCount);
    _persistCount();
  });
}

// Decrement by one (used when the popup dismisses a single alert row).
// Uses `_countRestored` so a freshly-awoken SW doesn't decrement a stale 0
// and then later overwrite the persisted value.
export function decrementCount() {
  _countRestored.then(() => {
    if (_pendingCount > 0) _pendingCount--;
    updateBadge(_pendingCount);
    _persistCount();
  });
}

// ── Notification interaction handlers ─────────

// Serialises all read-modify-write access to the `lite_purchase_notifs` session
// storage map. `fireAlert` (writer) and `_pruneLiteNotifEntry` (writer) can run
// concurrently when a FORCE_POLL + master cycle both fire lite-purchase alerts
// for different watchlists — without this lock the later .set overwrites the
// earlier .get, silently losing a Buy-button entry.
let _liteMapLock = Promise.resolve();
export async function _updateLiteNotifs(mutator) {
  const prev = _liteMapLock;
  let release;
  _liteMapLock = new Promise((r) => {
    release = r;
  });
  try {
    await prev;
    try {
      const { lite_purchase_notifs } = await chrome.storage.session.get("lite_purchase_notifs");
      const next = mutator({ ...(lite_purchase_notifs || {}) });
      if (next !== null) await chrome.storage.session.set({ lite_purchase_notifs: next });
    } catch (_) {
      /* session storage unavailable — ignore */
    }
  } finally {
    release();
  }
}

// Purge a lite-purchase map entry when a notification is gone (clicked, dismissed,
// or closed by Chrome). Without this, the map accumulates dead entries every time
// a user ignores or "views" a lite-purchase alert — session storage (~1 MB quota)
// would eventually fill up after days of heavy alerting.
async function _pruneLiteNotifEntry(notifId) {
  await _updateLiteNotifs((map) => {
    if (!map[notifId]) return null; // no-op — skip set()
    delete map[notifId];
    return map;
  });
}

// Extract the adId from a notifId, stripping whichever prefix was used at creation
// (`alert-lite-<adId>` for lite-purchase, `alert-<adId>` otherwise). Order matters:
// test the longer prefix first, or `alert-` would strip to `lite-<adId>`.
function _adIdFromNotifId(notifId) {
  if (notifId.startsWith("alert-lite-")) return notifId.slice("alert-lite-".length);
  if (notifId.startsWith("alert-")) return notifId.slice("alert-".length);
  return notifId;
}
function _isLiteNotifId(notifId) {
  return notifId.startsWith("alert-lite-");
}

if (chrome.notifications?.onButtonClicked?.addListener)
  chrome.notifications.onButtonClicked.addListener(async (notifId, buttonIndex) => {
    await _countRestored;
    // Button 1 has two meanings: Message (normal alerts) or Buy (lite-purchase alerts).
    // Buy-button checkout is executed by service-worker.js; here we only trigger auto-message
    // when this notif is NOT a lite-purchase notif. The discrimination is based on the
    // notifId prefix (set at creation time, immutable) — race-free with the SW handler's
    // `_updateLiteNotifs` delete of the map entry.
    const adId = _adIdFromNotifId(notifId);
    if (buttonIndex === 0) {
      openAdTab(adId);
      // View clicked on a lite-purchase notif — caller abandoned Buy, drop the map entry.
      _pruneLiteNotifEntry(notifId);
    } else if (buttonIndex === 1) {
      if (!_isLiteNotifId(notifId)) triggerAutoMessage(adId);
      // SW handles Buy + map cleanup for lite-purchase; nothing to do here.
    }
    // For lite-purchase Buy clicks, leave the clear() to the SW handler.
    // If we clear() here, Chrome fires onClosed → _pruneLiteNotifEntry → takes
    // _liteMapLock and deletes the entry. If that prune wins the lock race
    // against the SW handler's `chrome.storage.session.get`, the SW reads an
    // empty `pending` and the Buy click is silently lost (no checkout). The
    // SW handler calls chrome.notifications.clear(notifId) after checkout, so
    // the notification is still dismissed — just sequenced correctly.
    const isLiteBuy = _isLiteNotifId(notifId) && buttonIndex === 1;
    if (!isLiteBuy) chrome.notifications.clear(notifId);
    if (_pendingCount > 0) _pendingCount--;
    updateBadge(_pendingCount);
    _persistCount();
  });

if (chrome.notifications?.onClicked?.addListener)
  chrome.notifications.onClicked.addListener((notifId) => {
    const adId = _adIdFromNotifId(notifId);
    openAdTab(adId);
    chrome.notifications.clear(notifId);
    // Body click = user abandoned Buy/Message — drop any lite-purchase map entry.
    _pruneLiteNotifEntry(notifId);
    _countRestored.then(() => {
      if (_pendingCount > 0) _pendingCount--;
      updateBadge(_pendingCount);
      _persistCount();
    });
  });

// Fires when the user explicitly dismisses OR when Chrome auto-closes after the
// notification times out. Needed so map entries don't leak on ignore-until-timeout.
if (chrome.notifications?.onClosed?.addListener)
  chrome.notifications.onClosed.addListener((notifId, _byUser) => {
    _pruneLiteNotifEntry(notifId);
  });

async function openAdTab(adId) {
  const ad = await getAd(adId);
  // Gate `ad.url` through lbcAdUrl — the stored value came from the LBC API
  // and flows straight into `chrome.tabs.create({url})`. Without the gate a
  // malformed/attacker-shaped URL (javascript:, data:, non-LBC https) would
  // open in a fresh tab that still has the user's LBC session cookies via
  // any later navigation. P22-B covered automator sinks but missed this one.
  const url = lbcAdUrl(ad?.url, adId);
  chrome.tabs.create({ url, active: true });
}

async function triggerAutoMessage(adId) {
  const ad = await getAd(adId);
  if (!ad) return;
  // Honour the watchlist's configured template — ad.list_id is the watchlist UUID.
  // Falling back to undefined lets sendAutoMessage pick templates[0] by default.
  const watchlist = ad.list_id ? await dbGet(STORES.WATCHLISTS, ad.list_id) : null;
  await sendAutoMessage(ad, watchlist?.auto_message_template_id ?? undefined);
}

// ── ntfy.sh push notification ─────────────────

export async function sendNtfyNotification({ ad, adId, price, matchResult, watchlist, body, city }) {
  const stored = await chrome.storage.local.get(["ntfy_topic", "ntfy_server", "ntfy_threshold"]);
  const topic = stored.ntfy_topic;
  if (!topic?.trim()) return;

  const threshold = stored.ntfy_threshold ?? "red";
  if (threshold === "red" && matchResult.alert_tier !== "red") return;

  const server = (stored.ntfy_server || "https://ntfy.sh").replace(/\/$/, "");
  const emoji = matchResult.alert_tier === "red" ? "🔴" : "🟠";
  const adTitle = ad.subject || ad.title || "Annonce";
  const pct = matchResult.pct_below_market != null ? ` (−${Math.round(Math.abs(matchResult.pct_below_market))}%)` : "";

  try {
    const titleRaw = `${emoji} ${adTitle} — ${price}€${pct}`;
    const msgBody = `${body}${city ? " · " + city : ""} · ${watchlist.name}`;
    const ntfyPriority = matchResult.alert_tier === "red" ? 5 : 4;
    const adLbcUrl = adUrl(adId); // /ad/collection/{id} — canonical LBC URL format
    // ntfy JSON-publish MUST target the server ROOT URL, not `/<topic>`.
    // Per https://docs.ntfy.sh/publish/#publish-as-json the topic URL expects
    // the body to BE the plain-text message; POSTing JSON there makes ntfy
    // treat the whole JSON string as the message text and users saw their
    // push notifications deliver the raw blob `{"topic":"...","title":"..."}`
    // instead of the formatted title/body. Posting to root (`${server}/`)
    // with `topic` inside the JSON triggers the JSON parser path correctly.
    // UTF-8 (emoji, accents, em-dash) is preserved by JSON — using the
    // alternative header-based API would require RFC2047-encoding the Title
    // header, a known ntfy pitfall.
    await fetch(`${server}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title: titleRaw,
        message: msgBody,
        priority: ntfyPriority,
        tags: matchResult.alert_tier === "red" ? ["warning", "moneybag"] : ["moneybag"],
        click: adLbcUrl,
        actions: [{ action: "view", label: "Voir annonce", url: adLbcUrl, clear: true }],
      }),
    });
    log("ntfy push sent:", topic);
  } catch (e) {
    warn("ntfy push failed:", e.message);
  }
}
