import { formatPrice, safeUrl, resolveShipping, escapeHtml } from "@/shared/utils.js";

export function buildAlertsRow(ad, wlName) {
  const price = Array.isArray(ad.price) ? ad.price[0] : (ad.price ?? 0);
  const tier = ad.alert_tier || "orange";
  const tierHtml =
    tier === "red"
      ? '<span class="tier-badge tier-badge--red">🔴 Rouge</span>'
      : tier === "orange"
        ? '<span class="tier-badge tier-badge--orange">🟠 Orange</span>'
        : '<span class="tier-badge tier-badge--green">✅ Deal</span>';

  const pctRaw = ad.pct_below_market;
  const pctHtml =
    pctRaw != null && Math.abs(pctRaw) <= 150
      ? `<span class="${pctRaw >= 10 ? "pct-pos" : "pct-neg"}">${pctRaw >= 0 ? "−" : "+"}${Math.round(Math.abs(pctRaw))}%</span>`
      : "—";

  const thumb = ad.images?.[0] || "";
  const thumbHtml = thumb
    ? `<img src="${escapeHtml(safeUrl(thumb, ""))}" class="alert-thumb-sm" data-lbch-hide-on-err="1">`
    : '<div class="alert-thumb-sm"></div>';

  const adUrl = safeUrl(ad.url || `https://www.leboncoin.fr/annonce/${ad.id}`, "#");
  const date = ad.seen_at
    ? new Date(ad.seen_at).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

  const flagged = !!ad.is_flagged;
  const archived = !!ad.is_archived;
  const status = ad.ad_status || "available";
  const statusHtml =
    status === "sold"
      ? '<span class="status-badge status-badge--sold">Vendu</span>'
      : '<span class="status-badge status-badge--available">Dispo</span>';

  const ship = resolveShipping(ad);
  const shipBadge = ship.enabled
    ? ship.cost != null
      ? `<span class="delivery-badge delivery-badge--ship">🚚 Livraison ${ship.cost}€</span>`
      : '<span class="delivery-badge delivery-badge--ship">🚚 Livraison</span>'
    : '<span class="delivery-badge delivery-badge--pickup">🤝 Main propre</span>';
  const backfillBadge = ad.is_backfill ? '<span class="backfill-badge">📋 Seed</span>' : "";

  return {
    id: String(ad.id),
    flagged,
    archived,
    html: `
      <td><button class="flag-btn${flagged ? " flag-btn--active" : ""}" data-id="${escapeHtml(String(ad.id))}" title="Favori">${flagged ? "⭐" : "☆"}</button></td>
      <td>${thumbHtml}</td>
      <td>${tierHtml}</td>
      <td><a href="${escapeHtml(adUrl)}" target="_blank" rel="noopener" class="ad-link">${escapeHtml(ad.title || "")}</a> ${shipBadge}${backfillBadge}</td>
      <td class="price-cell">${formatPrice(price)}</td>
      <td>${pctHtml}</td>
      <td>${escapeHtml(wlName || "—")}</td>
      <td>${escapeHtml(ad.location?.city || "—")}</td>
      <td title="${ad.seen_at ? new Date(ad.seen_at).toLocaleString("fr-FR") : ""}">${date}</td>
      <td><button class="status-toggle" data-id="${escapeHtml(String(ad.id))}" data-status="${status}" title="Changer le statut">${statusHtml}</button></td>
      <td>
        <button class="discard-btn" data-id="${escapeHtml(String(ad.id))}" title="Écarter partout">🗑</button>
        <button class="archive-btn" data-id="${escapeHtml(String(ad.id))}" title="${archived ? "Désarchiver" : "Archiver"}">${archived ? "📂" : "🗄"}</button>
      </td>
    `,
  };
}
