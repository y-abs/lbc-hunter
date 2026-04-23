// ─────────────────────────────────────────────
//  LbC Hunter — Ad Page Injection
//  Injects price history chart + market data on /ad/ pages.
// ─────────────────────────────────────────────

import Chart from "chart.js/auto";
import { getAd, getPriceHistory, getWatchlist } from "@/db/content-db-proxy.js";
import { formatPrice, resolveShipping } from "@/shared/utils.js";
// Chart.js is bundled inline by Rollup (IIFE build) — CDN loading doesn't work
// from an ISOLATED-world content script because the MAIN-world <script> tag sets
// window.Chart in the page's JS context, which is invisible to the isolated world.

// Module-level handle to the current price chart so SPA navigations can destroy
// the previous instance before creating a new one.
let _priceChartInstance = null;

function extractAdIdFromUrl() {
  // Handles /ad/collection/{id} (current canonical) and /annonce/{id} (legacy)
  const match = window.location.pathname.match(/\/(?:ad\/collection|annonce)\/(\d+)/);
  return match?.[1] ?? null;
}

async function getAdData(adId) {
  return getAd(String(adId));
}

async function getPriceChartData(keyword, categoryId) {
  if (!keyword) return [];
  const data = await getPriceHistory(keyword, categoryId || null, 90);
  return [...data].sort((a, b) => a.timestamp - b.timestamp);
}

function buildWidget(ad, chartData) {
  const container = document.createElement("div");
  container.id = "lbch-adpage-widget";
  container.style.cssText = `
    margin: 16px 0;
    padding: 16px;
    background: #0D1117;
    border-radius: 8px;
    border: 1px solid #30363d;
    font-family: DM Sans, system-ui, sans-serif;
    color: #e6edf3;
  `;

  const latest = chartData.length ? chartData[chartData.length - 1] : null;
  const adPrice = Array.isArray(ad.price) ? ad.price[0] : ad.price;

  // Shipping cost row
  // Self-heal via shared resolver so legacy IDB records with stale
  // `is_shipping_enabled: false` still render delivery info when the raw
  // `attributes[]` array indicates shipping is supported.
  const shipInfo = resolveShipping(ad);
  let shippingHtml = "";
  if (shipInfo.enabled) {
    const cost = shipInfo.cost != null ? `${shipInfo.cost}€` : "inclus/gratuit";
    // Pass 48-B: guard the total computation — adPrice is undefined/NaN for
    // "à débattre" listings, otherwise the panel rendered
    // "(total estimé : NaN€)". Only show a total when both operands are
    // finite numbers; otherwise omit the estimate row silently.
    const canTotal = shipInfo.cost != null && Number.isFinite(adPrice) && adPrice > 0;
    const total = canTotal ? `(total estimé : ${adPrice + shipInfo.cost}€)` : "";
    shippingHtml = `
      <div style="margin-bottom:10px;padding:8px 12px;background:#161b22;border-radius:6px;font-size:13px;color:#8b949e;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <span>🚚 <strong style="color:#e6edf3;">Livraison disponible</strong></span>
        <span>Frais : <strong style="color:#e6edf3;font-family:monospace">${cost}</strong></span>
        ${total ? `<span style="color:#8b949e;">${total}</span>` : ""}
      </div>
    `;
  }

  let fairValueHtml = "";
  if (latest?.median_price && Number.isFinite(adPrice) && adPrice > 0) {
    // Pass 48-B: guard against non-positive / non-finite adPrice. LBC
    // "à débattre" listings come through with `price: []` (persisted as 0)
    // and the unguarded formula produced a "−100% vs marché" banner on
    // every free/donation ad — wildly misleading. Matching the badges logic.
    const pct = ((latest.median_price - adPrice) / latest.median_price) * 100;
    const sign = pct >= 0 ? "−" : "+";
    const color = pct >= 10 ? "#2a9d4e" : pct >= 0 ? "#FFC300" : "#E63946";
    fairValueHtml = `
      <div style="margin-bottom:12px;padding:10px;background:#161b22;border-radius:6px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:13px;color:#8b949e;">Valeur marché estimée</span>
        <strong style="color:#e6edf3;font-family:'Roboto Mono',monospace;">${formatPrice(latest.median_price)}</strong>
        <span style="font-size:13px;color:#8b949e;">Ce prix</span>
        <strong style="font-family:'Roboto Mono',monospace;">${formatPrice(adPrice)}</strong>
        <span style="background:${color};color:#fff;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;">${sign}${Math.round(Math.abs(pct))}%</span>
      </div>
    `;
  }

  const statsHtml = latest
    ? `
    <div style="display:flex;gap:24px;font-size:12px;color:#8b949e;margin-bottom:12px;flex-wrap:wrap;">
      <span>Min: <strong style="color:#e6edf3;font-family:monospace">${formatPrice(latest.min_price)}</strong></span>
      <span>Moy: <strong style="color:#e6edf3;font-family:monospace">${formatPrice(latest.avg_price)}</strong></span>
      <span>Médiane: <strong style="color:#e6edf3;font-family:monospace">${formatPrice(latest.median_price)}</strong></span>
      <span>Max: <strong style="color:#e6edf3;font-family:monospace">${formatPrice(latest.max_price)}</strong></span>
      <span>Échantillon: <strong style="color:#e6edf3;">${latest.sample_count} annonces</strong></span>
    </div>
  `
    : "";

  container.innerHTML = `
    <div style="font-size:13px;font-weight:700;color:#FF6B35;margin-bottom:10px;letter-spacing:.5px;">📊 LbC Hunter — Intelligence Marché</div>
    ${fairValueHtml}
    ${shippingHtml}
    ${statsHtml}
    <canvas id="lbch-price-chart" height="80"></canvas>
    ${!chartData.length ? '<p style="color:#8b949e;font-size:12px;text-align:center;margin-top:8px;">Pas encore de données de marché — des données apparaîtront après quelques cycles de polling.</p>' : ""}
  `;
  return container;
}

async function renderChart(canvasEl, chartData, adPrice) {
  if (!chartData.length) return;

  const labels = chartData.map((d) =>
    new Date(d.timestamp).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }),
  );
  const medians = chartData.map((d) => d.median_price);

  // Destroy any Chart instance attached to a previous canvas node.
  // LBC is a Next.js SPA; on route change we re-`inject()` and create a new
  // canvas. Without destroying the old Chart, its internal registry holds
  // the detached canvas + animation frame callbacks indefinitely (memory
  // leak that compounds across dozens of ad-page navigations in one session)
  // and Chart.js emits "Canvas is already in use" warnings. The registry is
  // keyed by canvas DOM node, so `Chart.getChart(canvas)` also catches the
  // edge case where React reuses the same canvas element on re-render.
  try {
    _priceChartInstance?.destroy();
  } catch (_) {
    /* ignore */
  }
  try {
    Chart.getChart(canvasEl)?.destroy();
  } catch (_) {
    /* ignore */
  }

  _priceChartInstance = new Chart(canvasEl, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Prix médian",
          data: medians,
          borderColor: "#FF6B35",
          backgroundColor: "rgba(255,107,53,0.08)",
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.3,
          fill: true,
        },
        {
          label: "Ce prix",
          data: new Array(labels.length).fill(adPrice),
          borderColor: "#FFC300",
          borderDash: [6, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: false,
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 10 }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e", callback: (v) => formatPrice(v) }, grid: { color: "#21262d" } },
      },
      plugins: {
        legend: { labels: { color: "#e6edf3", font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${formatPrice(ctx.raw)}` } },
      },
    },
  });
}

async function inject() {
  const adId = extractAdIdFromUrl();
  if (!adId) return;

  const ad = await getAdData(adId);
  // Look up the watchlist by ad.list_id (= watchlist UUID) to get the real search keyword.
  // Fallback to first 2 title words if watchlist was deleted or ad not yet in IDB.
  let keyword = ad?.title?.split(" ").slice(0, 2).join(" ") || "";
  if (ad?.list_id) {
    const wl = await getWatchlist(ad.list_id);
    if (wl?.keywords) keyword = wl.keywords;
  }
  const categoryId = ad?.category_id || null;
  const chartData = await getPriceChartData(keyword, categoryId);
  const adPrice = ad ? (Array.isArray(ad.price) ? ad.price[0] : ad.price) : 0;

  // Wait for price element, retry up to 5s
  let priceEl = document.querySelector('[data-qa-id="adview_price"]');
  if (!priceEl) {
    await new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        priceEl = document.querySelector('[data-qa-id="adview_price"]');
        if (priceEl) {
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve();
      }, 5000);
    });
  }

  if (!priceEl) return; // page doesn't have this element

  // On SPA navigation, a widget from the previous ad may still be in the DOM.
  // Remove it so the new ad's data is shown rather than the stale previous one.
  document.getElementById("lbch-adpage-widget")?.remove();

  const widget = buildWidget(ad || { price: adPrice }, chartData);
  priceEl.insertAdjacentElement("afterend", widget);

  const canvas = widget.querySelector("#lbch-price-chart");
  if (canvas) await renderChart(canvas, chartData, adPrice);
}

// ── SPA navigation support ───────────────────────────────────────────────────
// LbC is a Next.js SPA — navigating between ad pages uses history.pushState,
// which does NOT reload the page or re-run content scripts. Without this block,
// the price intelligence widget only appears on the first hard-loaded ad page.
// Observe the whole <head> (not the specific <title> node — React may replace
// the element itself on route change, which would orphan a title-bound observer).
//
// In-flight guard: if the user navigates quickly (multiple path changes before
// the first inject() resolves), two concurrent inject() calls both reach
// renderChart() and the second one destroys the chart just created by the first,
// leaving the widget with a blank canvas. Mirror the guard used in inject-badges.js.
let _lastAdPath = location.pathname;
let _injectInFlight = false;

async function safeInject() {
  if (_injectInFlight) return;
  _injectInFlight = true;
  try {
    await inject();
  } finally {
    _injectInFlight = false;
  }
}

new MutationObserver(() => {
  const p = location.pathname;
  if (p === _lastAdPath) return;
  _lastAdPath = p;
  if (/\/(?:ad\/collection|annonce)\/\d+/.test(p)) safeInject();
}).observe(document.head || document.documentElement, {
  childList: true,
  characterData: true,
  subtree: true,
});

safeInject();
