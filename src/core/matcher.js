// ─────────────────────────────────────────────
//  LbC Hunter — Deal Matcher
// ─────────────────────────────────────────────

import { haversineKm, resolveShipping } from "@/shared/utils.js";
import { isBlacklisted } from "@/db/indexeddb.js";

/**
 * Evaluate a single ad against a watchlist and current market stats.
 * @returns {{ is_match, alert_tier, pct_below_market, reasons }}
 */
export async function evaluateDeal(ad, watchlist, marketStats) {
  const result = {
    is_match: false,
    alert_tier: null, // 'red' | 'orange' | 'green'
    pct_below_market: null,
    estimated_total: null, // price + shipping_cost (if applicable)
    is_shipping: false,
    shipping_cost: null,
    reasons: [],
  };

  const adPrice = Array.isArray(ad.price) ? ad.price[0] : ad.price;

  // 0. Price sanity — reject ads with no/invalid price (e.g. LBC "à débattre",
  // donations, malformed listings). Without this, an ad whose `price` is `[]`
  // (→ `undefined`) or `0` slips past the min/max short-circuit filter
  // (`undefined < min` is `false`) and fires a spurious orange alert.
  if (typeof adPrice !== "number" || !Number.isFinite(adPrice) || adPrice <= 0) {
    result.reasons.push(`invalid price (${adPrice})`);
    return result;
  }

  // Extract shipping info through the shared resolver — unified detection
  // across all 6 known LBC API shapes (pre-processed field, legacy/modern
  // attributes, options.shippable, shipping.enabled, cost inference).
  const shipping = resolveShipping(ad);
  result.is_shipping = shipping.enabled;
  result.shipping_cost = shipping.cost;
  result.estimated_total = adPrice + (result.shipping_cost ?? 0);

  // 1. Price filter
  if (watchlist.price_min && adPrice < watchlist.price_min) {
    result.reasons.push(`price ${adPrice} < min ${watchlist.price_min}`);
    return result;
  }
  if (watchlist.price_max && adPrice > watchlist.price_max) {
    result.reasons.push(`price ${adPrice} > max ${watchlist.price_max}`);
    return result;
  }

  // 2. Seller type
  const sellerType = ad.owner?.type === "private" ? "private" : "pro";
  if (watchlist.seller_type !== "all" && sellerType !== watchlist.seller_type) {
    result.reasons.push(`seller type mismatch`);
    return result;
  }

  // 3. Blacklist check
  const sellerId = String(ad.owner?.store_id || ad.owner?.user_id || "");
  if (sellerId && (await isBlacklisted(sellerId))) {
    result.reasons.push("seller blacklisted");
    return result;
  }

  // 4. Location radius filter
  // `location_lat`/`location_lng` use `!= null` rather than truthy checks —
  // longitude 0 (Greenwich meridian, which passes through western France
  // near Bordeaux/Le Havre) and latitude 0 (Equator) would otherwise silently
  // disable the radius filter for watchlists legitimately configured near 0.
  // The ad-side `&&` truthy check is kept intentionally: LBC API occasionally
  // returns `0` as a "missing coord" sentinel for incomplete listings; we
  // prefer to let such ads through rather than false-reject on a bad haversine.
  if (watchlist.location_zip && watchlist.location_lat != null && watchlist.location_lng != null) {
    if (ad.location?.lat && ad.location?.lng) {
      const dist = haversineKm(watchlist.location_lat, watchlist.location_lng, ad.location.lat, ad.location.lng);
      if (watchlist.location_radius_km > 0 && dist > watchlist.location_radius_km) {
        result.reasons.push(`distance ${Math.round(dist)}km > ${watchlist.location_radius_km}km`);
        return result;
      }
    }
  }

  // 5. Compute market delta
  // Require median > 0, minimum 5-sample baseline, and adPrice > 0.
  const wantsMarket = watchlist.require_market_data !== false;
  const hasUsableMarket = marketStats?.median_price > 0 && adPrice > 0 && (marketStats.sample_count ?? 0) >= 5;

  if (hasUsableMarket) {
    const raw = ((marketStats.median_price - adPrice) / marketStats.median_price) * 100;
    // Discard implausible values: anything beyond ±150% is noise, not a deal
    result.pct_below_market = raw >= -150 && raw <= 150 ? raw : null;
  }

  // When the watchlist requires market data (default) and none is usable yet,
  // suppress the alert entirely — this matches the UI promise
  // "Alerter seulement si données marché disponibles".
  if (wantsMarket && !hasUsableMarket) {
    result.reasons.push("market data unavailable (require_market_data=true)");
    return result;
  }

  // 6. Assign tier
  result.is_match = true;
  const threshold = watchlist.undermarket_threshold_pct ?? 15;

  if (result.pct_below_market !== null && result.pct_below_market >= threshold) {
    result.alert_tier = "red"; // genuine deal: well below market
    result.reasons.push(`${Math.round(result.pct_below_market)}% below market (threshold ${threshold}%)`);
  } else {
    result.alert_tier = "orange"; // new listing at or near market price
    result.reasons.push("new listing within price range");
  }

  return result;
}
