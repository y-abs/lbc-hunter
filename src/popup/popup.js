// ─────────────────────────────────────────────
//  LbC Hunter — Popup Script
// ─────────────────────────────────────────────

import { MSG } from "@/shared/messages.js";
import { getAdsFeed, getWatchlists, saveWatchlist, discardAd as discardDbAd, setDemoMode } from "@/db/indexeddb.js";
import { formatPrice, relativeTime, adUrl, safeUrl, escapeHtml } from "@/shared/utils.js";

// ── DOM refs ──────────────────────────────────

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const togglePause = document.getElementById("toggle-pause");
const sessionWarn = document.getElementById("session-warning");
const noTabWarn = document.getElementById("no-tab-warning");
const alertList = document.getElementById("alert-list");
const emptyAlerts = document.getElementById("empty-alerts");
const watchlistList = document.getElementById("watchlist-list");
const emptyWatchlists = document.getElementById("empty-watchlists");
const btnDashboard = document.getElementById("btn-dashboard");
const btnOptions = document.getElementById("btn-options");
const btnSoundToggle = document.getElementById("btn-sound-toggle");
const btnMarkAllRead = document.getElementById("btn-mark-all-read");
const btnOpenAlerts = document.getElementById("btn-open-alerts");
const btnAddWatchlist = document.getElementById("btn-add-watchlist");

// Tracks the cutoff time for "mark all as read" and individually-dismissed ids.
//
// Storage: chrome.storage.LOCAL (not session).
// chrome.storage.session is cleared on every browser restart AND every MV3
// service-worker kill/reload. Using session storage meant all dismissed state
// was wiped silently, causing every previously-dismissed ad to reappear the
// next time the popup opened. chrome.storage.local persists across restarts.
//
// Gate: render() awaits _dismissRestored before reading these values so the
// first render never flashes stale state.
let dismissedBefore = 0;
const dismissedIds = new Set();
const _dismissRestored = chrome.storage.local
  .get(["dismissedBefore", "dismissedIds"])
  .then((r) => {
    dismissedBefore = r.dismissedBefore ?? 0;
    (r.dismissedIds ?? []).forEach((id) => {
      dismissedIds.add(String(id));
    });
  })
  .catch(() => {});

// Per-watchlist force-poll button state (survives setInterval re-renders)
// watchlistId → 'polling' | 'done' | 'no_tab' | 'no_session'
const pollingState = new Map();

// Per-watchlist live backfill state. Populated by the POLL_STATUS broadcast
// emitted by `core/poller.js` when it enters/exits the backfill branch.
//   watchlistId → 'running'    (backfill_start received, no done yet)
//   watchlistId → 'error'      (backfill_error received — auto-clears after 5s)
// Keys are deleted on `backfill_done` so the card flips from the transient
// "📋 Seed…" badge to the persistent "📋 N (time)" badge read from IDB.
const backfillState = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== MSG.POLL_STATUS) return;
  if (msg.phase === "backfill_start") {
    backfillState.set(msg.watchlistId, "running");
    render();
  } else if (msg.phase === "backfill_done") {
    backfillState.delete(msg.watchlistId);
    render();
  } else if (msg.phase === "backfill_error") {
    backfillState.set(msg.watchlistId, "error");
    render();
    setTimeout(() => {
      if (backfillState.get(msg.watchlistId) === "error") {
        backfillState.delete(msg.watchlistId);
        render();
      }
    }, 5000);
  }
});

// ── Demo mode ──
const demoModeKey = "lbch_demo";
let _demoOn = localStorage.getItem(demoModeKey) === "true";
if (_demoOn) setDemoMode(true);
const demoFooter = document.getElementById("demo-footer");
const demoDot = document.getElementById("demo-dot");
const demoLabel = document.getElementById("demo-label");
const btnDemoToggle = document.getElementById("btn-demo-toggle");

function applyDemoUI() {
  if (_demoOn) {
    demoDot.style.background = "#FF6B35";
    demoLabel.textContent = "Démo ON";
    document.querySelector(".header").setAttribute("data-demo", "true");
  } else {
    demoDot.style.background = "#444";
    demoLabel.textContent = "Démo OFF";
    document.querySelector(".header").removeAttribute("data-demo");
  }
}

// Triple-click on header logo reveals demo footer
let _headerClicks = 0;
document.querySelector(".header__logo").addEventListener("click", () => {
  _headerClicks++;
  if (_headerClicks >= 3) {
    _headerClicks = 0;
    demoFooter.classList.toggle("hidden");
  }
  setTimeout(() => {
    _headerClicks = 0;
  }, 800);
});

btnDemoToggle.addEventListener("click", () => {
  _demoOn = !_demoOn;
  localStorage.setItem(demoModeKey, _demoOn);
  setDemoMode(_demoOn);
  applyDemoUI();
  render();
});

applyDemoUI();

// ── Render ─────────────────────────────────────

async function render() {
  // Gate on the dismissed-state restoration before reading `dismissedBefore`
  // / `dismissedIds` in renderAlerts — without this, the first render after
  await _dismissRestored;
  // Show every recently-seen ad, not only alerted ones. The section is
  // labelled "Annonces récentes" (Recent Ads) — using getRecentAlerts() here
  // filtered to is_alerted === true, which left the section empty for hours
  // on broad watchlists ("iPhone 15", "Warcraft"…) where red/orange tier hits
  // are rare even though polling was healthy. getAdsFeed returns every ad in
  // the ADS store ordered by seen_at desc; non-alerted rows render with a
  // neutral style (see buildAlertRow / .alert-row--seen).
  // Use dismissedBefore as the IDB-level cutoff so the DB only returns ads
  // newer than the last "mark all read" — avoids fetching old hidden ads at
  // all. Fetch (10 + dismissedIds.size) rows so that even if some are
  // individually dismissed we still get up to 10 visible results.
  const feedLimit = 10 + dismissedIds.size;
  const [status, alerts, watchlists, soundSettings] = await Promise.all([
    sendMsg(MSG.GET_STATUS),
    getAdsFeed(dismissedBefore, null, feedLimit, 0),
    getWatchlists(),
    chrome.storage.local.get(["sound_pref"]),
  ]);

  updateStatusBar(status);
  updateSoundToggle(soundSettings?.sound_pref ?? "both");
  renderAlerts(alerts);
  renderWatchlists(watchlists, status?.isPaused ?? false);
}

function updateSoundToggle(soundPref) {
  if (!btnSoundToggle) return;
  const muted = soundPref === "none";
  btnSoundToggle.textContent = muted ? "🔇" : "🔊";
  btnSoundToggle.title = muted ? "Son coupé" : "Son activé";
  btnSoundToggle.classList.toggle("icon-btn--muted", muted);
}

function updateStatusBar(status) {
  if (!status) return;

  statusDot.className = "status-dot";
  if (status.isPaused) {
    statusDot.classList.add("status-dot--paused");
    statusText.textContent = "En pause";
  } else if (!status.hasLbcTab) {
    statusDot.classList.add("status-dot--error");
    statusText.textContent = "Aucun onglet LBC";
  } else if (!status.hasSession || status.sessionStale) {
    statusDot.classList.add("status-dot--error");
    statusText.textContent = `Session expirée`;
  } else {
    statusDot.classList.add("status-dot--active");
    statusText.textContent = status.alertCount
      ? `Actif · ${status.alertCount} alerte${status.alertCount > 1 ? "s" : ""}`
      : "Actif · surveillance en cours";
  }

  // Sync toggle with state (don't trigger change event)
  togglePause.checked = !status.isPaused;

  // Warnings
  sessionWarn.classList.toggle("hidden", status.hasSession && !status.sessionStale);
  noTabWarn.classList.toggle("hidden", status.hasLbcTab || !status.hasSession);
}

function renderAlerts(alerts) {
  const visible = alerts.filter((a) => (!a.seen_at || a.seen_at > dismissedBefore) && !dismissedIds.has(String(a.id)));
  if (!visible.length) {
    emptyAlerts.classList.remove("hidden");
    alertList.innerHTML = "";
    alertList.appendChild(emptyAlerts);
    return;
  }
  emptyAlerts.classList.add("hidden");
  alertList.innerHTML = "";
  for (const ad of visible) {
    alertList.appendChild(buildAlertRow(ad));
  }
}

function buildAlertRow(ad) {
  const row = document.createElement("div");
  // Only alerted ads carry a meaningful tier. Previously we defaulted to
  // 'orange' when ad.alert_tier was missing, which painted every recently-
  // seen ad with an orange left border and made the list indistinguishable
  // from actual alerts. Neutral 'seen' style keeps alerts visually prominent
  // while still surfacing the full polling activity to the user.
  const tier = ad.is_alerted ? ad.alert_tier || "orange" : "seen";
  row.className = `alert-row alert-row--${tier}`;
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");

  const thumb = ad.images?.[0] || "";
  const safeThumb = thumb ? safeUrl(thumb, "") : "";
  const price = Array.isArray(ad.price) ? ad.price[0] : ad.price;
  const ago = relativeTime(ad.seen_at);
  const city = ad.location?.city || "";

  row.innerHTML = `
    ${safeThumb ? `<img class="alert-thumb" src="${escHtml(safeThumb)}" alt="" loading="lazy">` : '<div class="alert-thumb"></div>'}
    <div class="alert-info">
      <div class="alert-title">${escHtml(ad.title || "")}</div>
      <div class="alert-meta">
        <span class="alert-price">${formatPrice(price)}</span>
        ${ad.pct_below_market != null && Math.abs(ad.pct_below_market) <= 150 ? `<span class="alert-pct alert-pct--${ad.pct_below_market >= 10 ? "green" : "red"}">${ad.pct_below_market >= 0 ? "−" : "+"}${Math.round(Math.abs(ad.pct_below_market))}%</span>` : ""}
        ${city ? `<span> · ${escHtml(city)}</span>` : ""}
        ${ad.is_backfill ? '<span class="popup-backfill-badge">📋 Seed</span>' : ""}
        <span> · ${ago}</span>
      </div>
    </div>
    <div class="alert-actions">
      <button class="action-btn" data-action="open" data-id="${ad.id}" title="Voir l'annonce">👁</button>
      <button class="action-btn" data-action="dismiss" data-id="${ad.id}" title="Ignorer">✕</button>
      <button class="action-btn" data-action="discard" data-id="${ad.id}" title="Écarter partout">🗑</button>
    </div>
  `;

  // MV3 CSP blocks inline onerror handlers — wire image fallback imperatively.
  const thumbImg = row.querySelector("img.alert-thumb");
  if (thumbImg) thumbImg.addEventListener("error", () => thumbImg.classList.add("alert-thumb--error"), { once: true });

  row.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return openAd(ad.id);
    if (btn.dataset.action === "open") openAd(ad.id);
    if (btn.dataset.action === "dismiss") dismissAlert(ad.id, row);
    if (btn.dataset.action === "discard") discardAlertEverywhere(ad, row);
  });

  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openAd(ad.id);
  });
  return row;
}

function renderWatchlists(watchlists, _isPaused) {
  if (!watchlists.length) {
    emptyWatchlists.classList.remove("hidden");
    watchlistList.innerHTML = "";
    watchlistList.appendChild(emptyWatchlists);
    return;
  }
  emptyWatchlists.classList.add("hidden");
  watchlistList.innerHTML = "";
  for (const wl of watchlists) {
    watchlistList.appendChild(buildWatchlistRow(wl));
  }
}

function buildWatchlistRow(wl) {
  const row = document.createElement("div");
  row.className = "watchlist-row";

  const lastPoll = wl.last_successful_poll_at
    ? relativeTime(wl.last_successful_poll_at)
    : wl.last_polled_at
      ? relativeTime(wl.last_polled_at)
      : "jamais";

  // ── Poll error badge ─────────────────────────
  let pollErrorBadge = "";
  const failures = wl.consecutive_poll_failures ?? 0;
  if (failures >= 3) {
    const errMsg = wl.last_poll_error?.message || "Erreur polling";
    pollErrorBadge = `<span class="watchlist-badge watchlist-badge--error" title="${escHtml(errMsg)}">⚠ ${failures} échec${failures > 1 ? "s" : ""}</span>`;
  }

  // Reflect current forced-poll state — survives setInterval re-renders
  const ps = pollingState.get(wl.id);
  const btnText = ps === "polling" ? "⏳" : ps === "done" ? "✓" : ps === "no_tab" || ps === "no_session" ? "⚠" : "▶";
  const btnTitle =
    ps === "no_tab"
      ? "Aucun onglet leboncoin.fr ouvert"
      : ps === "no_session"
        ? "Session expirée — visitez leboncoin.fr"
        : ps === "done"
          ? "Polling terminé"
          : "Forcer le polling";
  const btnDisabled = ps === "polling" ? "disabled" : "";

  // ── Backfill badges ──────────────────────────
  //  Three mutually-exclusive states worth showing on the card:
  //   1. Live seed in progress (POLL_STATUS 'backfill_start' seen this session)
  //   2. Recharge scheduled but not yet executed (pending_backfill_days > 0)
  //   3. Last completed seed summary (last_backfill_at + last_backfill_count)
  let backfillBadge = "";
  if (backfillState.get(wl.id) === "running") {
    backfillBadge = `<span class="watchlist-badge watchlist-badge--backfill" title="Rechargement de l'historique en cours…">📋 Seed…</span>`;
  } else if (backfillState.get(wl.id) === "error") {
    backfillBadge = `<span class="watchlist-badge watchlist-badge--error" title="Erreur réseau — réessai automatique au prochain cycle">⚠ Seed échoué</span>`;
  } else if (wl.pending_backfill_days > 0) {
    backfillBadge = `<span class="watchlist-badge watchlist-badge--backfill" title="Chargement des ${wl.pending_backfill_days} derniers jours en cours…">📋 Historique ${wl.pending_backfill_days}j…</span>`;
  } else if (wl.last_backfill_at && wl.last_backfill_count != null) {
    const rel = relativeTime(wl.last_backfill_at);
    const dur = wl.last_backfill_duration ? ` en ${Math.round(wl.last_backfill_duration / 100) / 10}s` : "";
    backfillBadge = `<span class="watchlist-badge watchlist-badge--seed" title="Dernier seed: ${wl.last_backfill_count} annonces sur ${wl.last_backfill_days ?? "?"}j${dur}">📋 ${wl.last_backfill_count} (${rel})</span>`;
  }

  row.innerHTML = `
    <label class="toggle-label mini-toggle" title="${wl.enabled ? "Désactiver" : "Activer"}">
      <input type="checkbox" ${wl.enabled ? "checked" : ""} data-id="${wl.id}">
      <span class="toggle-slider"></span>
    </label>
    <div class="watchlist-name">${escHtml(wl.name)}</div>
    <div class="watchlist-meta">${lastPoll}${pollErrorBadge ? " · " + pollErrorBadge : ""}${backfillBadge ? " · " + backfillBadge : ""}</div>
    <button class="action-btn" data-poll="${wl.id}" title="${btnTitle}" ${btnDisabled}>${btnText}</button>
  `;

  const toggle = row.querySelector('input[type="checkbox"]');
  toggle.addEventListener("change", () => toggleWatchlist(wl, toggle.checked));

  const pollBtn = row.querySelector("[data-poll]");
  pollBtn.addEventListener("click", () => forcePoll(wl.id));

  return row;
}

// ── Actions ───────────────────────────────────

function openAd(adId) {
  chrome.tabs.create({ url: adUrl(adId), active: true });
}

async function dismissAlert(adId, rowEl) {
  rowEl.remove();
  dismissedIds.add(String(adId));
  // Safety cap: IDB purges ads >30 days old; the dismissed-ids set can only
  // grow between "mark all read" calls. Keep the last 200 entries max so
  // chrome.storage.local doesn't accumulate unboundedly over many sessions.
  const arr = [...dismissedIds];
  if (arr.length > 200) {
    dismissedIds.clear();
    arr.slice(arr.length - 200).forEach((id) => {
      dismissedIds.add(id);
    });
  }
  chrome.storage.local.set({ dismissedIds: [...dismissedIds] });
  // Decrement by ONE — previously sent CLEAR_BADGE which wiped the entire
  // pending-alert counter every time a single row was dismissed, making the
  // badge lie about remaining unread alerts (a single ✕ click zeroed all
  // outstanding alerts from other watchlists).
  await sendMsg(MSG.DECREMENT_BADGE);
}

async function discardAlertEverywhere(ad, rowEl) {
  if (!ad?.id) return;
  rowEl.remove();
  await discardDbAd(ad.id);
  if (ad.is_alerted) await sendMsg(MSG.DECREMENT_BADGE);
}

async function toggleWatchlist(wl, enabled) {
  // Stale-stomp guard: popup re-renders every 2s and `wl` is captured in the
  // row closure. A poll completing between render and toggle would write
  // fresh runtime fields (last_polled_at, last_seen_ad_id,
  // pending_backfill_days) that this blind-put would revert — potentially
  // re-triggering a backfill or causing an alert storm via reset dedup
  // anchor. Read the live record first, fall back to the closure snapshot.
  const all = await getWatchlists().catch(() => []);
  const latest = all.find((x) => x.id === wl.id) ?? wl;
  await saveWatchlist({ ...latest, enabled });
}

async function forcePoll(watchlistId) {
  pollingState.set(watchlistId, "polling");
  render(); // immediate feedback: button flips to ⏳

  const resp = await sendMsg(MSG.FORCE_POLL, { watchlistId });
  const status = resp?.result?.status;

  if (!resp) pollingState.set(watchlistId, "no_session");
  else if (status === "no_tab") pollingState.set(watchlistId, "no_tab");
  else if (status === "no_session") pollingState.set(watchlistId, "no_session");
  else pollingState.set(watchlistId, "done");

  // Small delay — ensures IDB cross-context write is visible before popup reads it
  await new Promise((r) => setTimeout(r, 150));
  render(); // show ✓ / ⚠ and refresh last_polled_at

  setTimeout(() => {
    pollingState.delete(watchlistId);
    render(); // reset button to ▶
  }, 2000);
}

// ── Utility ───────────────────────────────────

function sendMsg(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra }).catch(() => null);
}

function escHtml(str) {
  return escapeHtml(str);
}

// ── Event listeners ───────────────────────────

btnDashboard.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") });
});

btnOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

btnMarkAllRead.addEventListener("click", async () => {
  dismissedBefore = Date.now();
  // Clear dismissedIds: every individually-dismissed ad now has
  // seen_at <= dismissedBefore, so the timestamp filter alone hides them.
  // Keeping stale entries in dismissedIds wastes storage and causes the
  // feedLimit calculation (10 + dismissedIds.size) to over-fetch needlessly.
  dismissedIds.clear();
  chrome.storage.local.set({ dismissedBefore, dismissedIds: [] });
  alertList.innerHTML = "";
  alertList.appendChild(emptyAlerts);
  emptyAlerts.classList.remove("hidden");
  await sendMsg(MSG.CLEAR_BADGE);
});

btnAddWatchlist.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

if (btnOpenAlerts) {
  btnOpenAlerts.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") });
  });
}

togglePause.addEventListener("change", () => {
  sendMsg(togglePause.checked ? MSG.RESUME_ALL : MSG.PAUSE_ALL);
});

if (btnSoundToggle) {
  btnSoundToggle.addEventListener("click", async () => {
    const { sound_pref = "both", sound_pref_last_non_none = "both" } = await chrome.storage.local.get([
      "sound_pref",
      "sound_pref_last_non_none",
    ]);

    if (sound_pref === "none") {
      const restored = sound_pref_last_non_none !== "none" ? sound_pref_last_non_none : "both";
      await chrome.storage.local.set({ sound_pref: restored });
      updateSoundToggle(restored);
      return;
    }

    await chrome.storage.local.set({
      sound_pref: "none",
      sound_pref_last_non_none: sound_pref,
    });
    updateSoundToggle("none");
  });
}

// ── Init + live refresh ─────────────────────────

render();
const refreshInterval = setInterval(render, 2000);
window.addEventListener("unload", () => clearInterval(refreshInterval));

// Listen for real-time alert events from SW
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.ALERT_FIRED) render();
});
