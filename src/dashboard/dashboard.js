// ─────────────────────────────────────────────
//  LbC Hunter — Dashboard Script
// ─────────────────────────────────────────────

import {
  getPurchases,
  savePurchase,
  deletePurchase,
  getRecentAlerts,
  getAdsFeed,
  getWatchlists,
  getPriceHistory,
  purgeOldAds,
  setDemoMode,
  isDemoMode,
  patchAd,
  discardAd as discardDbAd,
  dbGet,
} from "@/db/indexeddb.js";
import { STORES } from "@/db/schema.js";
import { UI_FEEDBACK } from "@/shared/constants.js";
import { formatPrice, safeUrl, csvCell, resolveShipping, escapeHtml } from "@/shared/utils.js";
import { filterAlertsRows } from "@/dashboard/alerts-filter.js";
import { buildAlertsRow } from "@/dashboard/alerts-row.js";
import { renderAlertsPaginationControls } from "@/dashboard/alerts-pagination.js";
import { sortAlertsRows } from "@/dashboard/alerts-sort.js";
import { updateAlertsSortIndicators } from "@/dashboard/alerts-sort-indicators.js";
import { Chart, registerables } from "chart.js";
Chart.register(...registerables);

// ── State ─────────────────────────────────────

let allPurchases = [];
let sortCol = "buy_date";
let sortDir = "desc";
let filterStatus = "";
let filterPlatform = "";
let period = "all";

// Alerts tab state
let alertsAllRows = [];
let alertsFilterPeriod = 0;
let alertsFilterTier = "";
let alertsFilterStatus = ""; // '' | 'available' | 'sold'
let alertsFilterType = ""; // '' | 'real' | 'backfill'
let alertsFilterWatchlist = "";
let alertsFilterFlagged = false;
let alertsFilterArchived = false;
let alertsSearch = "";
let alertsSortCol = "seen_at";
let alertsSortDir = "desc";
let alertsPage = 0;
const ALERTS_PAGE_SIZE = 50;
let alertsWatchlistOptionsInitialized = false;

// Market tab state
let marketWatchlists = [];
let marketData = [];

// Watchlists cache (shared)
let _watchlistsCache = [];

const charts = {};

// ── Init ──────────────────────────────────────

async function init() {
  allPurchases = await getPurchases();
  _watchlistsCache = await getWatchlists();
  renderAll();
  await renderAlertsTab(); // default tab
}

function getFilteredPurchases() {
  const now = Date.now();
  const cutoff = period === "month" ? now - 30 * 86400000 : period === "quarter" ? now - 90 * 86400000 : 0;
  return allPurchases
    .filter((p) => !filterStatus || p.status === filterStatus)
    .filter((p) => !filterPlatform || p.sell_platform === filterPlatform)
    .filter((p) => !cutoff || p.buy_date >= cutoff)
    .sort((a, b) => {
      // 'profit' is computed, not stored — use calcProfit() rather than a[sortCol]
      // which would always return undefined (sorted as 0 for all rows, no-op sort).
      const av = sortCol === "profit" ? (calcProfit(a) ?? 0) : (a[sortCol] ?? 0);
      const bv = sortCol === "profit" ? (calcProfit(b) ?? 0) : (b[sortCol] ?? 0);
      return sortDir === "asc" ? (av > bv ? 1 : -1) : av < bv ? 1 : -1;
    });
}

// ── Computed metrics ──────────────────────────

function calcProfit(p) {
  if (!p.sell_price) return null;
  const fees = (p.sell_price * (p.sell_fees_pct || 0)) / 100;
  return p.sell_price - fees - p.buy_price;
}

function computeKPIs(purchases) {
  const sold = purchases.filter((p) => p.status === "sold" && p.sell_price);
  const totalProfit = sold.reduce((s, p) => s + (calcProfit(p) ?? 0), 0);
  const avgROI = sold.length
    ? sold.reduce((s, p) => s + ((calcProfit(p) ?? 0) / p.buy_price) * 100, 0) / sold.length
    : null;

  // Best category
  const catProfit = {};
  for (const p of sold) {
    const cat = p.category || "Autre";
    catProfit[cat] = (catProfit[cat] || 0) + calcProfit(p);
  }
  const bestCat = Object.entries(catProfit).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";

  // "Actifs" = purchases in flight: bought-and-held, listed for resale,
  // plus automator rows still awaiting user confirmation (pending) or the
  // full-auto checkout pipeline (auto_pending). Rejected rows are excluded.
  const active = allPurchases.filter(
    (p) => p.status === "bought" || p.status === "listed" || p.status === "pending" || p.status === "auto_pending",
  ).length;

  return { totalProfit, buys: purchases.length, avgROI, bestCat, active };
}

// ── Render ─────────────────────────────────────

function renderAll() {
  const filtered = getFilteredPurchases();
  renderKPIs(filtered);
  renderTable(filtered);
  renderCharts(filtered);
}

function renderKPIs(purchases) {
  const k = computeKPIs(purchases);
  document.getElementById("kpi-profit").textContent = k.totalProfit != null ? formatPrice(k.totalProfit) : "—";
  document.getElementById("kpi-buys").textContent = k.buys;
  document.getElementById("kpi-roi").textContent = k.avgROI != null ? `${k.avgROI.toFixed(1)}%` : "—";
  document.getElementById("kpi-cat").textContent = k.bestCat;
  document.getElementById("kpi-active").textContent = k.active;
}

function renderTable(purchases) {
  const tbody = document.getElementById("stats-tbody");
  const empty = document.getElementById("stats-empty");
  tbody.innerHTML = "";

  if (!purchases.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const p of purchases) {
    const profit = calcProfit(p);
    const profitClass = profit == null ? "" : profit >= 0 ? "profit-pos" : "profit-neg";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(p.title)}</td>
      <td>${p.buy_date ? new Date(p.buy_date).toLocaleDateString("fr-FR") : "—"}</td>
      <td class="price-cell">${formatPrice(p.buy_price)}</td>
      <td>${p.sell_date ? new Date(p.sell_date).toLocaleDateString("fr-FR") : "—"}</td>
      <td class="price-cell">${p.sell_price ? formatPrice(p.sell_price) : "—"}</td>
      <td>${esc(p.sell_platform || "—")}</td>
      <td>${p.sell_fees_pct ? `${p.sell_fees_pct}%` : "—"}</td>
      <td class="${profitClass}">${profit != null ? formatPrice(profit) : "—"}</td>
      <td><span class="status-badge status-badge--${p.status}">${statusLabel(p.status)}</span></td>
      <td>
        <button class="btn btn--ghost btn--sm" data-edit="${p.id}">✏</button>
        <button class="btn btn--danger btn--sm" data-del="${p.id}">✕</button>
      </td>
    `;
    tr.querySelector("[data-edit]").addEventListener("click", () => openPurchaseModal(p));
    tr.querySelector("[data-del]").addEventListener("click", async () => {
      if (await confirm(`Supprimer "${p.title}" ?`)) {
        await deletePurchase(p.id);
        allPurchases = allPurchases.filter((x) => x.id !== p.id);
        renderAll();
        showToast("Supprimé");
      }
    });
    tbody.appendChild(tr);
  }
}

function statusLabel(s) {
  // Manual purchase flow uses 'bought' | 'listed' | 'sold'.
  // Automator flow (notifier Buy button / CONFIRM_PURCHASE) uses
  // 'pending' (lite, user confirms manually) | 'auto_pending' (full auto)
  // | 'rejected' (tab closed before load / injection failure). Without
  // mapping these the UI shows `undefined` in the status badge and the
  // KPI `active` counter ignores them.
  switch (s) {
    case "bought":
      return "Acheté";
    case "listed":
      return "En vente";
    case "sold":
      return "Vendu";
    case "pending":
      return "En attente";
    case "auto_pending":
      return "Auto (en cours)";
    case "rejected":
      return "Annulé";
    default:
      return s || "—";
  }
}

// ── Alerts tab ─────────────────────────────────

async function renderAlertsTab() {
  alertsAllRows = await getRecentAlerts(1000);
  _ensureAlertsWatchlistFilterOptions();

  // Update count badge on tab button — show only genuinely new (non-backfill) alerts
  const badge = document.getElementById("alerts-tab-count");
  const realCount = alertsAllRows.filter((a) => !a.is_backfill).length;
  if (badge) badge.textContent = realCount || "";

  renderAlertsTable();
}

function _ensureAlertsWatchlistFilterOptions() {
  if (alertsWatchlistOptionsInitialized) return;
  const sel = document.getElementById("alerts-filter-watchlist");
  if (!sel) return;
  for (const wl of _watchlistsCache) {
    const opt = document.createElement("option");
    opt.value = wl.id;
    opt.textContent = wl.name;
    sel.appendChild(opt);
  }
  alertsWatchlistOptionsInitialized = true;
}

function _getFilteredAlertsRows() {
  return filterAlertsRows(alertsAllRows, {
    now: Date.now(),
    periodDays: alertsFilterPeriod,
    tier: alertsFilterTier,
    status: alertsFilterStatus,
    type: alertsFilterType,
    watchlistId: alertsFilterWatchlist,
    flaggedOnly: alertsFilterFlagged,
    includeArchived: alertsFilterArchived,
    search: alertsSearch,
  });
}

function renderAlertsTable() {
  const wlMap = Object.fromEntries(_watchlistsCache.map((w) => [w.id, w.name]));
  let rows = _getFilteredAlertsRows();

  // Sort
  rows = sortAlertsRows(rows, alertsSortCol, alertsSortDir);

  // Update sort indicators on headers
  updateAlertsSortIndicators({
    selector: "#alerts-full-table th[data-sortcol]",
    sortCol: alertsSortCol,
    sortDir: alertsSortDir,
  });

  const tbody = document.getElementById("alerts-full-tbody");
  const empty = document.getElementById("alerts-full-empty");
  tbody.innerHTML = "";

  const totalRows = rows.length;
  rows = rows.slice(alertsPage * ALERTS_PAGE_SIZE, (alertsPage + 1) * ALERTS_PAGE_SIZE);

  if (!totalRows) {
    empty.classList.remove("hidden");
    renderAlertsPagination(0);
    return;
  }
  empty.classList.add("hidden");

  for (const ad of rows) {
    const wlName = wlMap[ad.list_id] || "—";
    const row = buildAlertsRow(ad, wlName);

    const tr = document.createElement("tr");
    tr.dataset.adId = row.id;
    if (row.flagged) tr.classList.add("row-flagged");
    if (row.archived) tr.classList.add("row-archived");
    tr.innerHTML = row.html;
    tbody.appendChild(tr);
  }
  // MV3 CSP blocks inline onerror — hide broken thumbnails imperatively
  tbody.querySelectorAll('img[data-lbch-hide-on-err="1"]').forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        img.style.display = "none";
      },
      { once: true },
    );
  });
  renderAlertsPagination(totalRows);
}

function renderAlertsPagination(total) {
  const container = document.getElementById("alerts-pagination");
  renderAlertsPaginationControls({
    container,
    page: alertsPage,
    totalRows: total,
    pageSize: ALERTS_PAGE_SIZE,
    onPageChange: (nextPage) => {
      alertsPage = nextPage;
      renderAlertsTable();
    },
  });
}

// ── Alerts: flag & status toggle (event delegation) ────────────────────
document.getElementById("alerts-full-tbody").addEventListener("click", async (e) => {
  const flagBtn = e.target.closest(".flag-btn");
  const statusBtn = e.target.closest(".status-toggle");
  const archiveBtn = e.target.closest(".archive-btn");
  const discardBtn = e.target.closest(".discard-btn");
  if (flagBtn) {
    const id = flagBtn.dataset.id;
    const row = alertsAllRows.find((a) => String(a.id) === id);
    if (!row) return;
    const newVal = !row.is_flagged;
    row.is_flagged = newVal; // optimistic in-memory
    if (!isDemoMode()) await patchAd(id, { is_flagged: newVal });
    renderAlertsTable();
  }
  if (statusBtn) {
    const id = statusBtn.dataset.id;
    const current = statusBtn.dataset.status || "available";
    const next = current === "available" ? "sold" : "available";
    const row = alertsAllRows.find((a) => String(a.id) === id);
    if (!row) return;
    row.ad_status = next; // optimistic in-memory
    if (!isDemoMode()) await patchAd(id, { ad_status: next });
    renderAlertsTable();
  }
  if (archiveBtn) {
    const id = archiveBtn.dataset.id;
    const row = alertsAllRows.find((a) => String(a.id) === id);
    if (!row) return;
    row.is_archived = !row.is_archived;
    if (!isDemoMode()) await patchAd(id, { is_archived: row.is_archived });
    renderAlertsTable();
  }
  if (discardBtn) {
    const id = discardBtn.dataset.id;
    if (!id) return;
    if (!(await confirm("Écarter définitivement cette annonce (elle sera exclue des alertes, vues et stats) ?")))
      return;

    const row = alertsAllRows.find((a) => String(a.id) === id);
    const wasAlerted = !!row?.is_alerted;

    if (!isDemoMode()) await discardDbAd(id);
    alertsAllRows = alertsAllRows.filter((a) => String(a.id) !== id);
    renderAlertsTable();

    if (wasAlerted) {
      await chrome.runtime.sendMessage({ type: "DECREMENT_BADGE" }).catch(() => null);
    }
    showToast(UI_FEEDBACK.discardSuccess);
  }
});

// ── Alerts: sort headers (event delegation) ────────────────────────────
document.getElementById("alerts-full-table").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sortcol]");
  if (!th) return;
  const col = th.dataset.sortcol;
  if (alertsSortCol === col) {
    alertsSortDir = alertsSortDir === "desc" ? "asc" : "desc";
  } else {
    alertsSortCol = col;
    alertsSortDir = "desc";
  }
  renderAlertsTable();
});

// ── Alerts tab filter listeners ────────────────────────────────────────
document.getElementById("alerts-filter-period").addEventListener("change", (e) => {
  alertsPage = 0;
  alertsFilterPeriod = Number(e.target.value);
  renderAlertsTable();
});
document.getElementById("alerts-filter-tier").addEventListener("change", (e) => {
  alertsPage = 0;
  alertsFilterTier = e.target.value;
  renderAlertsTable();
});
document.getElementById("alerts-filter-status").addEventListener("change", (e) => {
  alertsPage = 0;
  alertsFilterStatus = e.target.value;
  renderAlertsTable();
});
document.getElementById("alerts-filter-type").addEventListener("change", (e) => {
  alertsPage = 0;
  alertsFilterType = e.target.value;
  renderAlertsTable();
});
document.getElementById("alerts-filter-watchlist").addEventListener("change", (e) => {
  alertsPage = 0;
  alertsFilterWatchlist = e.target.value;
  renderAlertsTable();
});
document.getElementById("btn-alerts-filter-flagged").addEventListener("click", (e) => {
  alertsPage = 0;
  alertsFilterFlagged = !alertsFilterFlagged;
  e.currentTarget.classList.toggle("btn--flagged-active", alertsFilterFlagged);
  e.currentTarget.textContent = alertsFilterFlagged ? "⭐ Favoris" : "☆ Favoris";
  renderAlertsTable();
});
document.getElementById("btn-alerts-filter-archived").addEventListener("click", (e) => {
  alertsPage = 0;
  alertsFilterArchived = !alertsFilterArchived;
  e.currentTarget.classList.toggle("btn--archived-active", alertsFilterArchived);
  e.currentTarget.textContent = alertsFilterArchived ? "📂 Archivés" : "🗄 Archivés";
  renderAlertsTable();
});
document.getElementById("alerts-search").addEventListener("input", (e) => {
  alertsPage = 0;
  alertsSearch = e.target.value.toLowerCase();
  renderAlertsTable();
});

// CSV export (comma — universal)
document.getElementById("btn-export-alerts-csv2").addEventListener("click", () => {
  exportAlertsCsv(",", "lbc-alertes.csv");
});
// Excel export (semicolon — French Excel native)
document.getElementById("btn-export-alerts-excel").addEventListener("click", () => {
  exportAlertsCsv(";", "lbc-alertes-excel.csv");
});

// Re-apply the Alerts-tab filter stack so the exported CSV matches what the
// user sees on screen. The earlier implementation exported every row in
// `alertsAllRows`, silently ignoring active filters (period, tier, status,
// type, flagged, archived, search) — the user could filter to "red tier this
// week" and get an export with green/orange rows from months ago, poisoning
// any downstream analysis or share.
function _getFilteredAlertsForExport() {
  return _getFilteredAlertsRows();
}

function exportAlertsCsv(sep, filename) {
  const headers = ["Date", "Titre", "Prix", "% vs marché", "Tier", "Watchlist", "Ville", "Messagé", "Acheté", "URL"];
  const wlMap = Object.fromEntries(_watchlistsCache.map((w) => [w.id, w.name]));
  const rows = _getFilteredAlertsForExport().map((ad) => {
    const price = Array.isArray(ad.price) ? ad.price[0] : (ad.price ?? 0);
    return [
      ad.seen_at ? new Date(ad.seen_at).toLocaleString("fr-FR") : "",
      ad.title || "",
      price,
      ad.pct_below_market ?? "",
      ad.alert_tier || "",
      wlMap[ad.list_id] || "",
      ad.location?.city || "",
      ad.is_messaged ? "oui" : "non",
      ad.is_purchased ? "oui" : "non",
      ad.url || `https://www.leboncoin.fr/annonce/${ad.id}`,
    ]
      .map(csvCell)
      .join(sep);
  });
  const csv = [headers.map(csvCell).join(sep), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Charts ─────────────────────────────────────

const chartConfig = {
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  plugins: { legend: { labels: { color: "#e6edf3", font: { size: 11 } } } },
};

function renderCharts(purchases) {
  renderMonthlyChart(purchases);
  renderTopProductsChart(purchases);
  renderMarginsChart(purchases);
  renderPlatformsChart(purchases);
}

function renderMonthlyChart(purchases) {
  const monthly = {};
  for (const p of purchases.filter((x) => x.status === "sold" && x.sell_date)) {
    const key = new Date(p.sell_date).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
    monthly[key] = (monthly[key] || 0) + (calcProfit(p) ?? 0);
  }
  const labels = Object.keys(monthly).slice(-12);
  const data = labels.map((k) => monthly[k]);

  if (charts.monthly) charts.monthly.destroy();
  charts.monthly = new Chart(document.getElementById("chart-monthly"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Profit net (€)",
          data,
          backgroundColor: data.map((v) => (v >= 0 ? "rgba(42,157,78,.7)" : "rgba(230,57,70,.7)")),
          borderRadius: 4,
        },
      ],
    },
    options: {
      ...chartConfig,
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e", callback: (v) => formatPrice(v) }, grid: { color: "#21262d" } },
      },
    },
  });
}

function renderTopProductsChart(purchases) {
  const sold = purchases.filter((p) => p.status === "sold" && p.sell_price);
  sold.sort((a, b) => (calcProfit(b) ?? 0) - (calcProfit(a) ?? 0));
  const top = sold.slice(0, 10);
  const labels = top.map((p) => p.title.slice(0, 30));
  const data = top.map((p) => calcProfit(p) ?? 0);

  if (charts.topProducts) charts.topProducts.destroy();
  charts.topProducts = new Chart(document.getElementById("chart-top-products"), {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: "Profit (€)", data, backgroundColor: "rgba(255,107,53,.7)", borderRadius: 4 }],
    },
    options: {
      ...chartConfig,
      indexAxis: "y",
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e", font: { size: 10 } } },
      },
    },
  });
}

function renderMarginsChart(purchases) {
  const sold = purchases.filter((p) => p.status === "sold" && p.sell_price);
  const margins = sold.map((p) => ((calcProfit(p) ?? 0) / p.buy_price) * 100);

  const buckets = ["<0%", "0-10%", "10-25%", "25-50%", ">50%"];
  const counts = [0, 0, 0, 0, 0];
  for (const m of margins) {
    if (m < 0) counts[0]++;
    else if (m < 10) counts[1]++;
    else if (m < 25) counts[2]++;
    else if (m < 50) counts[3]++;
    else counts[4]++;
  }

  if (charts.margins) charts.margins.destroy();
  charts.margins = new Chart(document.getElementById("chart-margins"), {
    type: "doughnut",
    data: {
      labels: buckets,
      datasets: [
        {
          data: counts,
          backgroundColor: ["#E63946", "#FFC300", "#2a9d4e", "#FF6B35", "#1a6cbc"],
          borderWidth: 1,
          borderColor: "#0D1117",
        },
      ],
    },
    options: { ...chartConfig },
  });
}

function renderPlatformsChart(purchases) {
  const sold = purchases.filter((p) => p.status === "sold" && p.sell_price);
  const pp = {};
  for (const p of sold) pp[p.sell_platform || "other"] = (pp[p.sell_platform || "other"] || 0) + 1;
  const labels = Object.keys(pp);

  if (charts.platforms) charts.platforms.destroy();
  charts.platforms = new Chart(document.getElementById("chart-platforms"), {
    type: "pie",
    data: {
      labels,
      datasets: [
        {
          data: labels.map((k) => pp[k]),
          backgroundColor: ["#FF6B35", "#FFC300", "#2a9d4e", "#1a6cbc", "#8b949e"],
          borderWidth: 1,
          borderColor: "#0D1117",
        },
      ],
    },
    options: { ...chartConfig },
  });
}

// ── Purchase Modal ─────────────────────────────

function openPurchaseModal(p = null) {
  document.getElementById("purchase-modal-title").textContent = p ? "Modifier l'achat" : "Ajouter un achat";
  document.getElementById("p-id").value = p?.id ?? "";
  document.getElementById("p-title").value = p?.title ?? "";
  document.getElementById("p-buy-price").value = p?.buy_price ?? "";
  document.getElementById("p-buy-date").value = p?.buy_date
    ? new Date(p.buy_date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  document.getElementById("p-sell-price").value = p?.sell_price ?? "";
  document.getElementById("p-sell-date").value = p?.sell_date ? new Date(p.sell_date).toISOString().slice(0, 10) : "";
  document.getElementById("p-platform").value = p?.sell_platform ?? "";
  document.getElementById("p-fees").value = p?.sell_fees_pct ?? 0;
  document.getElementById("p-status").value = p?.status ?? "bought";
  document.getElementById("p-notes").value = p?.notes ?? "";
  document.getElementById("purchase-modal").classList.remove("hidden");
}

// ── Demo mode toggle ──────────────────────────

async function refreshAll() {
  // Reset state that depends on DB data
  marketWatchlists = [];
  marketData = [];
  allPurchases = await getPurchases();
  _watchlistsCache = await getWatchlists();

  // Re-render current tab
  const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab ?? "alerts";
  renderAll();
  if (activeTab === "alerts") await renderAlertsTab();
  else if (activeTab === "market") {
    // Rebuild the watchlist selector by clearing it first
    const sel = document.getElementById("market-watchlist");
    sel.innerHTML = "";
    await loadMarketTab();
  }
}

document.getElementById("btn-demo-toggle").addEventListener("click", async () => {
  const active = !isDemoMode();
  setDemoMode(active);
  document.getElementById("btn-demo-toggle").classList.toggle("btn--demo-active", active);
  document.body.classList.toggle("demo-mode", active);
  document.getElementById("demo-footer")?.classList.toggle("demo-footer--active", active);
  await refreshAll();
});

document.getElementById("btn-demo-off")?.addEventListener("click", () => {
  document.getElementById("btn-demo-toggle").click();
});

document.getElementById("btn-add-purchase").addEventListener("click", () => openPurchaseModal());
document.getElementById("btn-cancel-purchase").addEventListener("click", () => {
  document.getElementById("purchase-modal").classList.add("hidden");
});

document.getElementById("purchase-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sellDateVal = document.getElementById("p-sell-date").value;
  const buyDateVal = document.getElementById("p-buy-date").value;
  const editId = document.getElementById("p-id").value || null;
  // MERGE GUARD: when editing an automator-written purchase (pending /
  // auto_pending / rejected), the form only exposes the 10 manual fields.
  // A naive `savePurchase({id, title, buy_price, ... })` dbPut wipes the
  // automator's sidecar metadata — `ad_id` (index key driving the
  // `getPurchasesByAdId` double-Buy idempotency guard), `watchlist_id`
  // (budget cap source), `purchased_at`, `purchase_mode`, `reject_reason`.
  // Lost `ad_id` means a later Buy click on the same ad would BYPASS the
  // 5-min pending-dedup check and create a duplicate purchase + double-
  // debit `daily_spend`. Spread the existing row first so untouched
  // fields survive the edit.
  //
  // Pass 50-A: read the LIVE IDB row, not the `allPurchases` snapshot.
  // The snapshot was captured the last time `renderAll()` ran and can be
  // tens of seconds stale. If the automator updates this exact purchase
  // while the modal is open (e.g. a tab-load timeout writes
  // `status:'rejected', reject_reason:'tab_timeout'` via dbPut), the
  // stale snapshot lacks those fields and the submit silently reverts
  // the automator's truth. Same stale-spread bug class as the
  // `openWlForm` fix in options.js — every long-lived UI form that
  // edits an IDB row must re-read before merging.
  const existing = editId
    ? ((await dbGet(STORES.PURCHASES, editId).catch(() => null)) ?? allPurchases.find((x) => x.id === editId))
    : null;
  const purchase = {
    ...(existing ?? {}),
    id: editId || undefined,
    title: document.getElementById("p-title").value.trim(),
    buy_price: Number(document.getElementById("p-buy-price").value),
    buy_date: buyDateVal ? new Date(buyDateVal).getTime() : Date.now(),
    sell_price: Number(document.getElementById("p-sell-price").value) || null,
    sell_date: sellDateVal ? new Date(sellDateVal).getTime() : null,
    sell_platform: document.getElementById("p-platform").value,
    sell_fees_pct: Number(document.getElementById("p-fees").value),
    status: document.getElementById("p-status").value,
    notes: document.getElementById("p-notes").value,
  };
  await savePurchase(purchase);
  allPurchases = await getPurchases();
  renderAll();
  document.getElementById("purchase-modal").classList.add("hidden");
  showToast("Achat enregistré ✓");
});

// ── Filters & Sorting ─────────────────────────

document.getElementById("period-select").addEventListener("change", (e) => {
  period = e.target.value;
  renderAll();
});
document.getElementById("filter-status").addEventListener("change", (e) => {
  filterStatus = e.target.value;
  renderAll();
});
document.getElementById("filter-platform").addEventListener("change", (e) => {
  filterPlatform = e.target.value;
  renderAll();
});

document.querySelectorAll("[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.sort;
    if (sortCol === col) sortDir = sortDir === "asc" ? "desc" : "asc";
    else {
      sortCol = col;
      sortDir = "desc";
    }
    renderTable(getFilteredPurchases());
  });
});

// ── CSV Export ─────────────────────────────────

document.getElementById("btn-export-csv").addEventListener("click", () => {
  const purchases = getFilteredPurchases();
  const headers = [
    "Titre",
    "Date achat",
    "Prix achat",
    "Date vente",
    "Prix vente",
    "Plateforme",
    "Frais %",
    "Profit net",
    "Statut",
  ];
  const rows = purchases.map((p) => {
    const profit = calcProfit(p);
    return [
      p.title,
      p.buy_date ? new Date(p.buy_date).toLocaleDateString("fr-FR") : "",
      p.buy_price,
      p.sell_date ? new Date(p.sell_date).toLocaleDateString("fr-FR") : "",
      p.sell_price ?? "",
      p.sell_platform ?? "",
      p.sell_fees_pct ?? "",
      profit ?? "",
      p.status,
    ]
      .map(csvCell)
      .join(",");
  });
  const csv = [headers.map(csvCell).join(","), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `lbc-hunter-stats-${Date.now()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Utilities ─────────────────────────────────

function confirm(text) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-modal");
    document.getElementById("confirm-text").textContent = text;
    overlay.classList.remove("hidden");
    const ok = document.getElementById("confirm-ok"),
      cancel = document.getElementById("confirm-cancel");
    ok.onclick = () => {
      overlay.classList.add("hidden");
      resolve(true);
    };
    cancel.onclick = () => {
      overlay.classList.add("hidden");
      resolve(false);
    };
  });
}

function showToast(msg, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = `toast toast--${type}`;
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

function esc(str) {
  return escapeHtml(str);
}

// ── Market tab ────────────────────────────────

async function loadMarketTab() {
  const sel = document.getElementById("market-watchlist");

  // Populate selector on first load
  if (marketWatchlists.length === 0) {
    marketWatchlists = _watchlistsCache.length ? _watchlistsCache : await getWatchlists();
    marketWatchlists.forEach((wl) => {
      const opt = document.createElement("option");
      opt.value = wl.id;
      opt.textContent = wl.name;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", fetchAndRenderMarket);
    document.getElementById("market-period").addEventListener("change", renderMarketChart);
    document.getElementById("btn-export-market-csv").addEventListener("click", exportMarketCsv);
  }

  await fetchAndRenderMarket();
}

async function fetchAndRenderMarket() {
  const sel = document.getElementById("market-watchlist");
  const wlId = sel.value;
  const wl = marketWatchlists.find((w) => w.id === wlId);

  if (!wl) {
    document.getElementById("market-empty").classList.remove("hidden");
    document.getElementById("market-chart-wrap").classList.add("hidden");
    return;
  }

  marketData = await getPriceHistory(wl.keywords, wl.category_id, 365);
  renderMarketChart();
}

function renderMarketChart() {
  const periodDays = Number(document.getElementById("market-period").value);
  const cutoff = periodDays > 0 ? Date.now() - periodDays * 86_400_000 : 0;
  const data = [...marketData]
    .filter((d) => !cutoff || d.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);

  const emptyEl = document.getElementById("market-empty");
  const wrapEl = document.getElementById("market-chart-wrap");

  if (!data.length) {
    emptyEl.classList.remove("hidden");
    wrapEl.classList.add("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  wrapEl.classList.remove("hidden");

  // Stats strip
  const latest = data[data.length - 1];
  const oldest = data[0];
  const trend =
    latest.median_price && oldest.median_price && data.length > 1
      ? (((latest.median_price - oldest.median_price) / oldest.median_price) * 100).toFixed(1)
      : null;
  document.getElementById("market-stat-median").textContent = formatPrice(latest.median_price);
  document.getElementById("market-stat-avg").textContent = formatPrice(latest.avg_price);
  const trendEl = document.getElementById("market-stat-trend");
  trendEl.textContent = trend != null ? `${Number(trend) >= 0 ? "+" : ""}${trend}%` : "—";
  trendEl.className = "market-stat__value " + (trend != null ? (Number(trend) >= 0 ? "pct-neg" : "pct-pos") : "");
  document.getElementById("market-stat-samples").textContent = data.reduce((s, d) => s + (d.sample_count ?? 0), 0);

  const labels = data.map((d) => new Date(d.timestamp).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }));

  if (charts.market) charts.market.destroy();
  charts.market = new Chart(document.getElementById("chart-market"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Médiane",
          data: data.map((d) => d.median_price),
          borderColor: "#FF6B35",
          backgroundColor: "rgba(255,107,53,.12)",
          fill: true,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 6,
        },
        {
          label: "Moyenne",
          data: data.map((d) => d.avg_price),
          borderColor: "#FFC300",
          fill: false,
          tension: 0.35,
          pointRadius: 2,
          pointHoverRadius: 5,
        },
        {
          label: "Min",
          data: data.map((d) => d.min_price),
          borderColor: "#2a9d4e",
          borderDash: [5, 5],
          fill: false,
          tension: 0.35,
          pointRadius: 2,
        },
        {
          label: "Max",
          data: data.map((d) => d.max_price),
          borderColor: "#E63946",
          borderDash: [5, 5],
          fill: false,
          tension: 0.35,
          pointRadius: 2,
        },
      ],
    },
    options: {
      ...chartConfig,
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 12 }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e", callback: (v) => v + " €" }, grid: { color: "#21262d" } },
      },
      plugins: {
        ...chartConfig.plugins,
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatPrice(ctx.parsed.y)}` },
        },
      },
    },
  });
}

function exportMarketCsv() {
  const headers = ["Date", "Médiane", "Moyenne", "Min", "Max", "Échantillons"];
  const rows = [...marketData]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((d) =>
      [
        new Date(d.timestamp).toLocaleString("fr-FR"),
        d.median_price ?? "",
        d.avg_price ?? "",
        d.min_price ?? "",
        d.max_price ?? "",
        d.sample_count ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  const csv = [headers.map(csvCell).join(","), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `lbc-marche-${Date.now()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Tab switching ─────────────────────────────

const ALL_TABS = ["alerts", "stats", "feed", "market"];

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
    });
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    ALL_TABS.forEach((t) => {
      document.getElementById(`tab-${t}`)?.classList.toggle("hidden", t !== tab);
    });
    if (tab === "feed") loadFeedTab();
    if (tab === "market") loadMarketTab();
    if (tab === "alerts") renderAlertsTab();
    if (tab === "stats") renderAll();
  });
});

// ── Feed tab ──────────────────────────────────

const FEED_PAGE_SIZE = 50;
let feedPage = 0;
let feedWatchlists = [];
let feedAllRows = [];

async function loadFeedTab() {
  // Side-effect: keep ads store lean (prune > 30-day-old ads)
  purgeOldAds().catch(() => {});

  if (!feedWatchlists.length) {
    feedWatchlists = await getWatchlists();
    const sel = document.getElementById("feed-watchlist");
    feedWatchlists.forEach((wl) => {
      const opt = document.createElement("option");
      opt.value = wl.id;
      opt.textContent = wl.name;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", async () => {
      feedPage = 0;
      await fetchFeedRows();
      renderFeed();
    });
  }
  feedPage = 0;
  await fetchFeedRows();
  renderFeed();
}

async function fetchFeedRows() {
  const periodDays = Number(document.getElementById("feed-period").value);
  const cutoff = periodDays > 0 ? Date.now() - periodDays * 86400_000 : 0;
  const wlId = document.getElementById("feed-watchlist").value || null;
  feedAllRows = await getAdsFeed(cutoff, wlId, 2000, 0);
}

function renderFeed() {
  const query = document.getElementById("feed-search").value.toLowerCase();
  const wlMap = Object.fromEntries(feedWatchlists.map((w) => [w.id, w.name]));

  let rows = feedAllRows;
  if (query) rows = rows.filter((a) => (a.subject || a.title || "").toLowerCase().includes(query));

  const total = rows.length;
  const start = feedPage * FEED_PAGE_SIZE;
  const pageRows = rows.slice(start, start + FEED_PAGE_SIZE);

  const tbody = document.getElementById("feed-tbody");
  tbody.innerHTML = "";

  if (!pageRows.length) {
    document.getElementById("feed-empty").classList.remove("hidden");
    document.getElementById("feed-table").classList.add("hidden");
  } else {
    document.getElementById("feed-empty").classList.add("hidden");
    document.getElementById("feed-table").classList.remove("hidden");
    pageRows.forEach((a) => {
      const price = Array.isArray(a.price) ? a.price[0] : (a.price ?? 0);
      const pct =
        a.pct_below_market != null && Math.abs(a.pct_below_market) <= 150 ? `${Math.round(a.pct_below_market)}%` : "—";
      const tier = a.alert_tier === "red" ? "🔴" : a.alert_tier === "orange" ? "🟠" : "—";
      // Same self-heal as the Alerts table — use the shared resolver so
      // legacy ads without `is_shipping_enabled: true` stored show their
      // true delivery status derived from `attributes[]`/`options`.
      const shipInfo = resolveShipping(a);
      const ship = shipInfo.enabled ? (shipInfo.cost != null ? `🚚 ${shipInfo.cost}€` : "🚚 Oui") : "🤝 Main propre";
      const wlName = wlMap[a.list_id] || ""; // a.list_id = watchlist uuid (schema convention)
      const adLink = safeUrl(a.url || `https://www.leboncoin.fr/annonce/${a.id}`, "#");
      const date = a.seen_at
        ? new Date(a.seen_at).toLocaleString("fr-FR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—";
      const typeBadge = a.is_backfill
        ? '<span class="backfill-badge">📋</span>'
        : '<span class="delivery-badge delivery-badge--ship" style="font-size:10px">🔔</span>';
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${date}</td>
        <td><a href="${esc(adLink)}" target="_blank" rel="noopener" class="ad-link">${esc((a.subject || a.title || "").substring(0, 60))}</a></td>
        <td class="price-mono">${price}€</td>
        <td>${ship}</td>
        <td>${pct}</td>
        <td>${tier}</td>
        <td>${typeBadge}</td>
        <td>${esc(wlName)}</td>
        <td>${esc(a.location?.city || "")}</td>
        <td><button class="discard-btn feed-discard-btn" data-id="${esc(String(a.id))}" data-alerted="${a.is_alerted ? "1" : "0"}" title="Écarter partout">🗑</button></td>
      `;
      tbody.appendChild(tr);
    });
  }

  renderFeedPagination(total);
}

function renderFeedPagination(total) {
  const pages = Math.ceil(total / FEED_PAGE_SIZE);
  const container = document.getElementById("feed-pagination");
  container.innerHTML = "";
  if (pages <= 1) return;
  for (let i = 0; i < pages; i++) {
    const btn = document.createElement("button");
    btn.className = `btn btn--ghost btn--sm${i === feedPage ? " active" : ""}`;
    btn.textContent = String(i + 1);
    btn.addEventListener("click", () => {
      feedPage = i;
      renderFeed();
    });
    container.appendChild(btn);
  }
}

document.getElementById("feed-period").addEventListener("change", async () => {
  feedPage = 0;
  await fetchFeedRows();
  renderFeed();
});

document.getElementById("feed-search").addEventListener("input", () => {
  feedPage = 0;
  renderFeed();
});

document.getElementById("feed-tbody").addEventListener("click", async (e) => {
  const btn = e.target.closest(".feed-discard-btn");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();

  const id = String(btn.dataset.id || "");
  if (!id) return;

  if (!(await confirm("Écarter définitivement cette annonce (elle sera exclue des alertes, vues et stats) ?"))) return;

  btn.disabled = true;
  try {
    if (!isDemoMode()) await discardDbAd(id);
    if (btn.dataset.alerted === "1") {
      await chrome.runtime.sendMessage({ type: "DECREMENT_BADGE" }).catch(() => null);
    }
    feedAllRows = feedAllRows.filter((a) => String(a.id) !== id);
    renderFeed();
    showToast(UI_FEEDBACK.discardSuccess);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-export-feed-csv").addEventListener("click", () => {
  const headers = ["Date", "Titre", "Prix", "Livraison", "% vs marché", "Tier", "Watchlist", "Ville"];
  const wlMap = Object.fromEntries(feedWatchlists.map((w) => [w.id, w.name]));
  // Respect the user's search filter — the table the user sees is `feedAllRows`
  // minus the search query; exporting the raw `feedAllRows` deceives downstream
  // analysis (user expects a CSV matching what they see on screen).
  const query = (document.getElementById("feed-search").value || "").toLowerCase();
  const visible = query
    ? feedAllRows.filter((a) => (a.subject || a.title || "").toLowerCase().includes(query))
    : feedAllRows;
  const rows = visible.map((a) => {
    const price = Array.isArray(a.price) ? a.price[0] : (a.price ?? 0);
    // Use the shared `csvCell` helper — it quotes consistently AND neutralises
    // CSV formula-injection (CWE-1236). Ad titles originate from LBC listings
    // (attacker-controllable); a title starting with `=`, `+`, `-`, `@`, `\t`,
    // or `\r` would execute as a spreadsheet formula on import (e.g.
    // `=HYPERLINK("http://evil.com", "click me")` or `=IMPORTDATA(...)` to
    // exfiltrate the sheet). Raw `"${String(v)}"` escaping leaves the leading
    // trigger character intact — csvCell prefixes a `'` that forces text mode.
    return [
      a.seen_at ? new Date(a.seen_at).toLocaleString("fr-FR") : "",
      a.subject || a.title || "",
      price,
      (() => {
        const s = resolveShipping(a);
        return s.enabled ? (s.cost != null ? s.cost + "€" : "oui") : "non";
      })(),
      a.pct_below_market ?? "",
      a.alert_tier || "",
      wlMap[a.list_id] || "", // a.list_id = watchlist uuid
      a.location?.city || "",
    ]
      .map(csvCell)
      .join(",");
  });
  const csv = [headers.map(csvCell).join(","), ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `lbc-feed-${Date.now()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Apply demo footer state on load ─────────────────────────
document.getElementById("demo-footer")?.classList.toggle("demo-footer--active", isDemoMode());
document.body.classList.toggle("demo-mode", isDemoMode());

init();
