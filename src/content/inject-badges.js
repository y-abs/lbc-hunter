// ─────────────────────────────────────────────
//  LbC Hunter — Badge Injection
//  Injects price-vs-market badges on search results.
// ─────────────────────────────────────────────

import { getAd, getLatestMarketStats, getWatchlist } from "@/db/content-db-proxy.js";
import { resolveShipping } from "@/shared/utils.js";

// Inject badge stylesheet once
function ensureStyles() {
  if (document.getElementById("lbch-badge-styles")) return;
  const style = document.createElement("style");
  style.id = "lbch-badge-styles";
  style.textContent = `
    .lbch-badge {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 9999;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      color: #fff;
      line-height: 1.4;
      pointer-events: none;
      font-family: 'Roboto Mono', monospace, sans-serif;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      white-space: nowrap;
    }
    .lbch-badge--green  { background: #2a9d4e; }
    .lbch-badge--yellow { background: #b9860a; }
    .lbch-badge--red    { background: #c0392b; }
    .lbch-badge--blue   { background: #1a6cbc; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

async function getAdPriceData(adId) {
  try {
    const ad = await getAd(String(adId));
    if (!ad) return null;

    // ad.list_id = watchlist UUID — look up the watchlist to get the real search keyword
    const watchlist = await getWatchlist(ad.list_id);
    const keyword = watchlist?.keywords || "";
    const stats = keyword ? await getLatestMarketStats(keyword, ad.category_id || null) : null;

    return { ad, stats };
  } catch {
    return null;
  }
}

function extractAdId(card) {
  const link = card.querySelector('a[href*="/ad/"]');
  if (!link) return null;
  // Handles /ad/collection/{id} (current canonical) and /annonce/{id} (legacy)
  const match = link.href.match(/\/ad\/(?:collection\/)?(\d+)/);
  return match?.[1] ?? null;
}

function createBadge(text, colorClass) {
  const div = document.createElement("div");
  div.className = `lbch-badge lbch-badge--${colorClass}`;
  div.textContent = text;
  return div;
}

async function injectBadges() {
  ensureStyles();
  const cards = [...document.querySelectorAll('[data-qa-id="aditem_container"]:not([data-lbch-injected])')];
  if (!cards.length) return;

  // Mark all cards up-front so a concurrent observer-driven call skips them,
  // then fetch IDB data for every card in parallel (was 35+ sequential awaits).
  for (const card of cards) {
    card.setAttribute("data-lbch-injected", "true");
    if (getComputedStyle(card).position === "static") card.style.position = "relative";
  }
  const lookups = await Promise.all(
    cards.map((card) => {
      const adId = extractAdId(card);
      return adId ? getAdPriceData(adId) : Promise.resolve(null);
    }),
  );

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const data = lookups[i];

    // New badge: ad < 10 minutes old
    let badge = null;
    if (data?.ad) {
      const ageMin = (Date.now() - data.ad.seen_at) / 60000;
      if (ageMin < 10) {
        badge = createBadge("🔵 Nouveau", "blue");
      }
    }

    if (data?.ad && data?.stats?.median_price) {
      // Pass 48-B: guard against price <= 0 (LBC "à débattre" / donation / gift
      // listings are persisted with price=0 via the `?? 0` fallback in
      // persistAd). `(median - 0) / median * 100 === 100` used to paint a
      // spurious "🟢 −100% vs marché" badge on every free listing — wildly
      // misleading the user into thinking every price-on-request ad was a
      // once-in-a-lifetime deal. Skip the market badge entirely for
      // non-positive prices; the "Nouveau" / shipping badges still apply.
      const price = Number(data.ad.price);
      if (Number.isFinite(price) && price > 0) {
        const pct = ((data.stats.median_price - price) / data.stats.median_price) * 100;
        if (pct >= 10) {
          badge = createBadge(`🟢 −${Math.round(pct)}% vs marché`, "green");
        } else if (pct >= 0) {
          badge = createBadge("🟡 Prix marché", "yellow");
        } else {
          badge = createBadge(`🔴 +${Math.round(Math.abs(pct))}% vs marché`, "red");
        }
      }
    }

    if (badge) card.appendChild(badge);

    // Shipping badge (bottom-left corner)
    // Self-heal: resolve through shared helper so legacy IDB records that
    // stored `is_shipping_enabled: false` still display the correct badge.
    if (data?.ad) {
      const ship = resolveShipping(data.ad);
      if (ship.enabled) {
        const shipBadge = document.createElement("div");
        shipBadge.className = "lbch-badge lbch-badge--blue";
        shipBadge.style.cssText = "top:auto;bottom:8px;right:auto;left:8px;";
        shipBadge.textContent = ship.cost != null ? `🚚 +${ship.cost}€` : "🚚 livraison";
        card.appendChild(shipBadge);
      }
    }
  }
}

// MutationObserver to handle SPA navigation and infinite scroll.
// Debounce mandatory: every badge appendChild() triggers the observer again,
// and LBC's React tree mutates constantly on scroll/filter/hover. Without a
// debounce this pins a CPU core and fires hundreds of querySelectorAll/s.
let _injectTimer = null;
let _injectInFlight = false;
function scheduleInject() {
  if (_injectTimer) return;
  _injectTimer = setTimeout(async () => {
    _injectTimer = null;
    if (_injectInFlight) {
      scheduleInject();
      return;
    }
    _injectInFlight = true;
    try {
      await injectBadges();
    } finally {
      _injectInFlight = false;
    }
  }, 200);
}
const observer = new MutationObserver(scheduleInject);
observer.observe(document.body, { childList: true, subtree: true });
injectBadges();
