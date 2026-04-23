// Alerts filtering extracted from dashboard.js to keep rendering logic focused.

export function filterAlertsRows(rows, filters = {}) {
  const {
    now = Date.now(),
    periodDays = 0,
    tier = "",
    status = "",
    type = "",
    watchlistId = "",
    flaggedOnly = false,
    includeArchived = false,
    search = "",
  } = filters;

  const cutoff = periodDays > 0 ? now - periodDays * 86_400_000 : 0;
  let filtered = rows;

  if (cutoff) filtered = filtered.filter((a) => (a.seen_at ?? 0) >= cutoff);
  if (tier) filtered = filtered.filter((a) => (a.alert_tier || "orange") === tier);
  if (status) filtered = filtered.filter((a) => (a.ad_status || "available") === status);
  if (type === "real") filtered = filtered.filter((a) => !a.is_backfill);
  if (type === "backfill") filtered = filtered.filter((a) => !!a.is_backfill);
  if (watchlistId) filtered = filtered.filter((a) => String(a.list_id) === watchlistId);
  if (flaggedOnly) filtered = filtered.filter((a) => !!a.is_flagged);
  if (!includeArchived) filtered = filtered.filter((a) => !a.is_archived);
  if (search) filtered = filtered.filter((a) => (a.title || "").toLowerCase().includes(search));

  return filtered;
}
