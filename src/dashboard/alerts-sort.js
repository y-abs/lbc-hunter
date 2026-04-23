const TIER_ORDER = { red: 0, orange: 1, green: 2 };

export function sortAlertsRows(rows, sortCol, sortDir) {
  return [...rows].sort((a, b) => {
    let av;
    let bv;

    switch (sortCol) {
      case "is_flagged":
        av = a.is_flagged ? 1 : 0;
        bv = b.is_flagged ? 1 : 0;
        break;
      case "alert_tier":
        av = TIER_ORDER[a.alert_tier] ?? 1;
        bv = TIER_ORDER[b.alert_tier] ?? 1;
        break;
      case "price":
        av = Array.isArray(a.price) ? a.price[0] : (a.price ?? 0);
        bv = Array.isArray(b.price) ? b.price[0] : (b.price ?? 0);
        break;
      case "pct_below_market":
        av = a.pct_below_market ?? -999;
        bv = b.pct_below_market ?? -999;
        break;
      case "ad_status":
        av = a.ad_status || "available";
        bv = b.ad_status || "available";
        break;
      default:
        av = a.seen_at ?? 0;
        bv = b.seen_at ?? 0;
    }

    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });
}
