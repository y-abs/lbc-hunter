// ─────────────────────────────────────────────
//  LbC Hunter — Alerts Sidebar
//  Floating collapsible panel injected on all
//  lbc.fr pages.  Shows the 20 most recent
//  alerts straight from IndexedDB.
// ─────────────────────────────────────────────

import { getAlertedAds } from "@/db/content-db-proxy.js";
import { MSG } from "@/shared/messages.js";
import { UI_FEEDBACK } from "@/shared/constants.js";
import { formatPrice, relativeTime, adUrl, safeUrl, escapeHtml } from "@/shared/utils.js";

// ── Helpers ───────────────────────────────────

function esc(str) {
  return escapeHtml(str);
}

// getAlertedAds uses a cursor on the seen_at index and stops as soon as it has
// collected `limit` alerted records — never loads all ads into memory.
async function getRecentAlerts(limit = 20) {
  return getAlertedAds(limit);
}

// ── Styles ────────────────────────────────────

const STYLE_ID = "lbch-sidebar-styles";

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #lbch-sidebar-toggle {
      position: fixed;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2147483646;
      background: #FF6B35;
      color: #fff;
      border: none;
      border-radius: 8px 0 0 8px;
      width: 28px;
      height: 64px;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      box-shadow: -2px 0 8px rgba(0,0,0,0.25);
      transition: background 0.15s;
      padding: 0;
    }
    #lbch-sidebar-toggle:hover { background: #e85c2a; }
    #lbch-sidebar-toggle .lbch-sb-badge {
      background: #fff;
      color: #FF6B35;
      border-radius: 8px;
      font-size: 9px;
      font-weight: 800;
      line-height: 1;
      padding: 1px 4px;
      min-width: 14px;
      text-align: center;
    }
    #lbch-sidebar-panel {
      position: fixed;
      right: 28px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2147483645;
      width: 340px;
      max-height: 70vh;
      background: #0D1117;
      border: 1px solid #30363d;
      border-radius: 10px 0 0 10px;
      box-shadow: -4px 0 24px rgba(0,0,0,0.5);
      font-family: 'DM Sans', system-ui, sans-serif;
      color: #e6edf3;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
      transform: translateY(-50%) translateX(20px);
      transition: opacity 0.2s, transform 0.2s;
    }
    #lbch-sidebar-panel.lbch-open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(-50%) translateX(0);
    }
    .lbch-sb-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid #30363d;
      flex-shrink: 0;
    }
    .lbch-sb-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .7px;
      color: #8b949e;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .lbch-sb-title svg { flex-shrink: 0; }
    .lbch-sb-dash-link {
      font-size: 11px;
      color: #FF6B35;
      text-decoration: none;
      font-weight: 600;
      opacity: .85;
    }
    .lbch-sb-dash-link:hover { opacity: 1; text-decoration: underline; }
    .lbch-sb-list {
      overflow-y: auto;
      flex: 1;
      padding: 6px 0;
    }
    .lbch-sb-empty {
      padding: 28px 0;
      text-align: center;
      font-size: 12px;
      color: #8b949e;
    }
    .lbch-sb-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      cursor: pointer;
      text-decoration: none;
      color: inherit;
      transition: background 0.1s;
      border-left: 3px solid transparent;
    }
    .lbch-sb-row:hover { background: #161b22; }
    .lbch-sb-row--red    { border-left-color: #c0392b; }
    .lbch-sb-row--orange { border-left-color: #e67e22; }
    .lbch-sb-row--green  { border-left-color: #2a9d4e; }
    .lbch-sb-discard {
      margin-left: auto;
      color: #8b949e;
      font-size: 12px;
      line-height: 1;
      border-radius: 4px;
      padding: 2px 4px;
      cursor: pointer;
      user-select: none;
      transition: color .12s, background .12s;
    }
    .lbch-sb-discard:hover {
      color: #e6edf3;
      background: rgba(255,255,255,.08);
    }
    .lbch-sb-thumb {
      width: 40px;
      height: 40px;
      border-radius: 5px;
      object-fit: cover;
      flex-shrink: 0;
      background: #21262d;
    }
    .lbch-sb-thumb-placeholder {
      width: 40px;
      height: 40px;
      border-radius: 5px;
      flex-shrink: 0;
      background: #21262d;
    }
    .lbch-sb-info { flex: 1; min-width: 0; }
    .lbch-sb-name {
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #e6edf3;
      margin-bottom: 2px;
    }
    .lbch-sb-meta {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: #8b949e;
      flex-wrap: wrap;
    }
    .lbch-sb-price { color: #e6edf3; font-weight: 700; font-family: monospace; }
    .lbch-sb-pct {
      border-radius: 3px;
      padding: 0 4px;
      font-size: 10px;
      font-weight: 700;
      color: #fff;
    }
    .lbch-sb-pct--green { background: #2a9d4e; }
    .lbch-sb-pct--red   { background: #c0392b; }
    .lbch-sb-footer {
      border-top: 1px solid #30363d;
      padding: 7px 14px;
      font-size: 11px;
      color: #8b949e;
      text-align: center;
      flex-shrink: 0;
    }
    .lbch-sb-footer a { color: #FF6B35; text-decoration: none; }
    .lbch-sb-footer a:hover { text-decoration: underline; }
    .lbch-sb-toast {
      position: absolute;
      left: 12px;
      right: 12px;
      bottom: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 700;
      text-align: center;
      background: #1f6f43;
      color: #fff;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      opacity: 1;
      transform: translateY(0);
      transition: opacity .2s, transform .2s;
      z-index: 2;
    }
    .lbch-sb-toast.lbch-sb-toast--error { background: #9d2f2f; }
    .lbch-sb-toast.hidden {
      opacity: 0;
      transform: translateY(4px);
      pointer-events: none;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ── Build UI ──────────────────────────────────

function buildToggleBtn() {
  const btn = document.createElement("button");
  btn.id = "lbch-sidebar-toggle";
  btn.title = "LBC Hunter — Alertes récentes";
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
      <path d="M4 10 L8 5 L12 10 L16 5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M4 15 L8 10 L12 15 L16 10" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>
    </svg>
    <span class="lbch-sb-badge" id="lbch-sb-count">0</span>
  `;
  return btn;
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.id = "lbch-sidebar-panel";
  panel.innerHTML = `
    <div class="lbch-sb-header">
      <span class="lbch-sb-title">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
          <path d="M4 10 L8 5 L12 10 L16 5" stroke="#FF6B35" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 15 L8 10 L12 15 L16 10" stroke="#FF6B35" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>
        </svg>
        Mes alertes
      </span>
      <a id="lbch-sb-dashlink" class="lbch-sb-dash-link" href="#" title="Voir dans le dashboard">Tout voir →</a>
    </div>
    <div class="lbch-sb-list" id="lbch-sb-list">
      <div class="lbch-sb-empty">Chargement…</div>
    </div>
    <div class="lbch-sb-footer" id="lbch-sb-footer" style="display:none">
      <a id="lbch-sb-dashlink2" href="#">Ouvrir le dashboard complet</a>
    </div>
    <div id="lbch-sb-toast" class="lbch-sb-toast hidden"></div>
  `;
  return panel;
}

let sidebarToastTimer = null;
const SIDEBAR_TOAST_MS = 3000;

function showSidebarToast(message, type = "success") {
  const toast = document.getElementById("lbch-sb-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `lbch-sb-toast${type === "error" ? " lbch-sb-toast--error" : ""}`;
  if (sidebarToastTimer) clearTimeout(sidebarToastTimer);
  sidebarToastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, SIDEBAR_TOAST_MS);
}

// ── Render alerts into panel ──────────────────

async function renderSidebar(list) {
  let alerts;
  try {
    alerts = await getRecentAlerts(20);
  } catch (_) {
    list.innerHTML = '<div class="lbch-sb-empty">Erreur de lecture — rechargez la page.</div>';
    return 0;
  }

  const countEl = document.getElementById("lbch-sb-count");
  if (countEl) countEl.textContent = alerts.length;

  if (!alerts.length) {
    list.innerHTML = '<div class="lbch-sb-empty">Aucune alerte pour l\'instant.</div>';
    return 0;
  }

  list.innerHTML = "";
  for (const ad of alerts) {
    const tier = ad.alert_tier || "orange";
    const price = Array.isArray(ad.price) ? ad.price[0] : ad.price;
    const thumb = ad.images?.[0] || "";
    const ago = relativeTime(ad.seen_at);

    const pctHtml =
      ad.pct_below_market != null && Math.abs(ad.pct_below_market) <= 150
        ? `<span class="lbch-sb-pct lbch-sb-pct--${ad.pct_below_market >= 10 ? "green" : "red"}">${ad.pct_below_market >= 0 ? "−" : "+"}${Math.round(Math.abs(ad.pct_below_market))}%</span>`
        : "";

    const safeThumb = safeUrl(thumb, "");
    const thumbEl = safeThumb
      ? `<img class="lbch-sb-thumb" src="${esc(safeThumb)}" alt="" loading="lazy" data-lbch-hide-on-err="1">`
      : `<div class="lbch-sb-thumb-placeholder"></div>`;

    const row = document.createElement("a");
    row.className = `lbch-sb-row lbch-sb-row--${tier}`;
    row.href = adUrl(ad.id);
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    row.innerHTML = `
      ${thumbEl}
      <div class="lbch-sb-info">
        <div class="lbch-sb-name">${esc(ad.title)}</div>
        <div class="lbch-sb-meta">
          <span class="lbch-sb-price">${formatPrice(price)}</span>
          ${pctHtml}
          <span>${esc(ago)}</span>
        </div>
      </div>
      <span class="lbch-sb-discard" data-ad-id="${esc(String(ad.id))}" title="Écarter partout">🗑</span>
    `;
    list.appendChild(row);
  }

  // LBC page CSP blocks inline onerror on injected DOM — wire imperatively
  list.querySelectorAll('img[data-lbch-hide-on-err="1"]').forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        img.style.display = "none";
      },
      { once: true },
    );
  });

  list.querySelectorAll(".lbch-sb-discard[data-ad-id]").forEach((discard) => {
    discard.addEventListener(
      "click",
      async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const adId = String(discard.getAttribute("data-ad-id") || "");
        if (!adId) return;
        if (!confirm("Écarter définitivement cette annonce (elle sera exclue des alertes, vues et stats) ?")) return;
        const res = await chrome.runtime.sendMessage({ type: MSG.DISCARD_AD, adId }).catch(() => null);
        if (!res?.ok) {
          showSidebarToast(UI_FEEDBACK.discardError, "error");
          return;
        }
        await renderSidebar(list);
        showSidebarToast(UI_FEEDBACK.discardSuccess);
      },
      { once: true },
    );
  });

  return alerts.length;
}

// ── Init ──────────────────────────────────────

async function init() {
  // Avoid double injection (e.g. SPA navigation)
  if (document.getElementById("lbch-sidebar-toggle")) return;

  ensureStyles();

  const toggle = buildToggleBtn();
  const panel = buildPanel();
  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  // Wire dashboard links to open extension dashboard page
  const dashUrl = chrome.runtime.getURL("src/dashboard/dashboard.html");
  document.getElementById("lbch-sb-dashlink").href = dashUrl;
  document.getElementById("lbch-sb-dashlink2").href = dashUrl;

  const list = document.getElementById("lbch-sb-list");
  const footer = document.getElementById("lbch-sb-footer");

  let isOpen = false;

  toggle.addEventListener("click", async () => {
    isOpen = !isOpen;
    panel.classList.toggle("lbch-open", isOpen);
    if (isOpen) {
      const count = await renderSidebar(list);
      footer.style.display = count > 10 ? "" : "none";
    }
  });

  // Close panel when clicking outside
  document.addEventListener(
    "click",
    (e) => {
      if (isOpen && !panel.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
        isOpen = false;
        panel.classList.remove("lbch-open");
      }
    },
    true,
  );

  // Initial count badge (don't open the panel)
  try {
    const alerts = await getRecentAlerts(20);
    const countEl = document.getElementById("lbch-sb-count");
    if (countEl) countEl.textContent = alerts.length;
  } catch (_) {
    /* IDB not ready yet */
  }

  // Refresh every 15s (re-render only if panel is open)
  setInterval(async () => {
    try {
      const alerts = await getRecentAlerts(20);
      const countEl = document.getElementById("lbch-sb-count");
      if (countEl) countEl.textContent = alerts.length;
      if (isOpen) await renderSidebar(list);
    } catch (_) {
      /* ignore */
    }
  }, 15_000);
}

// Wait for body to be available (document_idle, but defensive)
if (document.body) {
  init();
} else {
  document.addEventListener("DOMContentLoaded", init);
}
