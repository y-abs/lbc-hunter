// ─────────────────────────────────────────────
//  LbC Hunter — Report Builder (G)
//  Generates HTML / plain-text reports and
//  dispatches them via mailto: or EmailJS.
// ─────────────────────────────────────────────

import { getAdsInPeriod, getPurchasesInPeriod, getWatchlists } from "@/db/indexeddb.js";
import { formatPrice } from "@/shared/utils.js";

// ── Build structured report data ─────────────

export async function buildReport({ from, to, watchlistIds = [] }) {
  const [purchases, alerts, watchlists] = await Promise.all([
    getPurchasesInPeriod(from, to),
    getAdsInPeriod(from, to, watchlistIds),
    getWatchlists(),
  ]);

  const wlMap = Object.fromEntries(watchlists.map((w) => [w.id, w.name]));

  const redAlerts = alerts.filter((a) => a.alert_tier === "red");
  const orangeAlerts = alerts.filter((a) => a.alert_tier === "orange");
  const bought = purchases.filter((p) => p.status !== "rejected");

  const totalSpend = bought.reduce((s, p) => s + (p.buy_price || 0), 0);
  const totalRevenu = bought.reduce((s, p) => s + (p.sell_price || 0), 0);
  const profit = totalRevenu - totalSpend;

  // Best deal: highest pct below market
  const bestDeal = redAlerts.sort((a, b) => (b.pct_below_market || 0) - (a.pct_below_market || 0))[0] || null;

  return {
    from,
    to,
    period: formatDateRange(from, to),
    alerts: { total: alerts.length, red: redAlerts.length, orange: orangeAlerts.length },
    purchases: { count: bought.length, total_spend: totalSpend, total_revenue: totalRevenu, profit },
    bestDeal,
    watchlistNames: watchlistIds.map((id) => wlMap[id] || id),
    topAlerts: redAlerts.slice(0, 5).map((a) => ({
      title: a.subject || a.title,
      price: a.price,
      pct: a.pct_below_market,
      watchlist: wlMap[a.list_id] || "", // a.list_id stores watchlist UUID (see persistAd)
    })),
    topPurchases: bought.slice(0, 5).map((p) => ({
      title: p.title,
      buy: p.buy_price,
      sell: p.sell_price,
      profit: (p.sell_price || 0) - (p.buy_price || 0),
    })),
  };
}

// ── Render as HTML ────────────────────────────

export function toHTML(report) {
  const pColor = report.purchases.profit >= 0 ? "#2a9d4e" : "#E63946";
  const rowStyle = "padding:6px 10px;border-bottom:1px solid #30363d;font-size:13px;";
  const thStyle = "padding:6px 10px;background:#1a1f27;font-size:12px;color:#8b949e;text-align:left;";

  const topAlertsRows = report.topAlerts
    .map(
      (a) => `
    <tr>
      <td style="${rowStyle}">${esc(a.title)}</td>
      <td style="${rowStyle}">${a.price}€</td>
      <td style="${rowStyle};color:#2a9d4e;">−${Math.round(Math.abs(a.pct || 0))}%</td>
      <td style="${rowStyle}">${esc(a.watchlist)}</td>
    </tr>`,
    )
    .join("");

  const topBoughtRows = report.topPurchases
    .map(
      (p) => `
    <tr>
      <td style="${rowStyle}">${esc(p.title)}</td>
      <td style="${rowStyle}">${p.buy}€</td>
      <td style="${rowStyle}">${p.sell != null ? p.sell + "€" : "—"}</td>
      <td style="${rowStyle};color:${p.profit >= 0 ? "#2a9d4e" : "#E63946"};">${p.profit >= 0 ? "+" : ""}${p.profit}€</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<style>body{font-family:DM Sans,system-ui,sans-serif;background:#0D1117;color:#e6edf3;padding:24px;max-width:700px;margin:auto;}
h1{color:#FF6B35;font-size:18px;} h2{color:#e6edf3;font-size:14px;margin:20px 0 8px;}
.kpi-row{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0;}
.kpi{padding:12px 16px;background:#161b22;border-radius:8px;flex:1;min-width:120px;text-align:center;}
.kpi-label{font-size:11px;color:#8b949e;display:block;}
.kpi-value{font-size:22px;font-weight:700;font-family:'Roboto Mono',monospace;}
table{width:100%;border-collapse:collapse;border:1px solid #30363d;border-radius:6px;overflow:hidden;}
</style></head><body>
<h1>📊 LbC Hunter — Rapport ${esc(report.period)}</h1>
<div class="kpi-row">
  <div class="kpi"><span class="kpi-label">Alertes 🔴</span><span class="kpi-value">${report.alerts.red}</span></div>
  <div class="kpi"><span class="kpi-label">Alertes 🟠</span><span class="kpi-value">${report.alerts.orange}</span></div>
  <div class="kpi"><span class="kpi-label">Achats</span><span class="kpi-value">${report.purchases.count}</span></div>
  <div class="kpi"><span class="kpi-label">Dépenses</span><span class="kpi-value">${formatPrice(report.purchases.total_spend)}</span></div>
  <div class="kpi"><span class="kpi-label">Profit</span><span class="kpi-value" style="color:${pColor}">${report.purchases.profit >= 0 ? "+" : ""}${formatPrice(report.purchases.profit)}</span></div>
</div>
${
  topAlertsRows
    ? `<h2>Top alertes 🔴</h2>
<table><thead><tr>
  <th style="${thStyle}">Titre</th><th style="${thStyle}">Prix</th><th style="${thStyle}">Réduction</th><th style="${thStyle}">Watchlist</th>
</tr></thead><tbody>${topAlertsRows}</tbody></table>`
    : ""
}
${
  topBoughtRows
    ? `<h2>Achats du période</h2>
<table><thead><tr>
  <th style="${thStyle}">Titre</th><th style="${thStyle}">Achat</th><th style="${thStyle}">Revente</th><th style="${thStyle}">Profit</th>
</tr></thead><tbody>${topBoughtRows}</tbody></table>`
    : ""
}
<p style="font-size:11px;color:#8b949e;margin-top:24px;">Généré le ${new Date().toLocaleString("fr-FR")} — LbC Hunter</p>
</body></html>`;
}

// ── Render as plain text (≤1800 chars) ───────

export function toText(report) {
  const lines = [
    `📊 LbC Hunter — ${report.period}`,
    `Alertes: ${report.alerts.red} 🔴  ${report.alerts.orange} 🟠`,
    `Achats: ${report.purchases.count} | Dépenses: ${report.purchases.total_spend}€ | Profit: ${report.purchases.profit >= 0 ? "+" : ""}${report.purchases.profit}€`,
    "",
  ];
  if (report.topAlerts.length) {
    lines.push("Top alertes:");
    report.topAlerts.forEach((a) => {
      lines.push(`  • ${(a.title || "").substring(0, 40)} — ${a.price}€ (−${Math.round(Math.abs(a.pct || 0))}%)`);
    });
    lines.push("");
  }
  if (report.topPurchases.length) {
    lines.push("Achats:");
    report.topPurchases.forEach((p) => {
      const profitStr = p.profit != null ? ` profit: ${p.profit >= 0 ? "+" : ""}${p.profit}€` : "";
      lines.push(`  • ${(p.title || "").substring(0, 40)} — ${p.buy}€${profitStr}`);
    });
  }
  return lines.join("\n").substring(0, 1800);
}

// ── Open mailto: ──────────────────────────────

export function openMailto(email, report) {
  const subject = encodeURIComponent(`LBCHunter Rapport — ${report.period}`);
  const body = encodeURIComponent(toText(report));
  // Encode the email recipient so stray `?`, `&`, `#`, spaces or CRLF can't
  // hijack mailto: query params or inject additional headers. The `@`
  // separator is `%40`-encoded by encodeURIComponent; mail clients accept
  // that just fine (RFC 6068 §2), but some older clients prefer the literal
  // `@` so we restore it.
  const safeEmail = encodeURIComponent(String(email ?? "").trim()).replace(/%40/g, "@");
  const url = `mailto:${safeEmail}?subject=${subject}&body=${body}`;
  chrome.tabs.create({ url });
}

// ── Send via EmailJS REST API ─────────────────

export async function sendViaEmailJS(config, report) {
  const { service_id, template_id, user_id, email } = config;
  if (!service_id || !template_id || !user_id || !email) throw new Error("EmailJS config incomplete");

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id,
      template_id,
      user_id,
      template_params: {
        to_email: email,
        subject: `LBCHunter Rapport — ${report.period}`,
        report_text: toText(report),
        red_alerts: String(report.alerts.red),
        total_profit: `${report.purchases.profit >= 0 ? "+" : ""}${report.purchases.profit}€`,
        period: report.period,
      },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS error: ${res.status}`);
  return true;
}

// ── Helpers ───────────────────────────────────

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDateRange(from, to) {
  const opts = { day: "2-digit", month: "short" };
  return `${new Date(from).toLocaleDateString("fr-FR", opts)} – ${new Date(to).toLocaleDateString("fr-FR", opts)}`;
}
