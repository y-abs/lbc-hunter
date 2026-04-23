// ─────────────────────────────────────────────
//  LbC Hunter — Market Price Computation
// ─────────────────────────────────────────────

import { mean, median, uuid } from "@/shared/utils.js";
import { savePriceHistory, getLatestMarketStats, getPriceHistory } from "@/db/indexeddb.js";

/**
 * After each poll, compute and persist market stats for the searched keyword.
 * @param {string} keyword
 * @param {string|null} category_id
 * @param {Array} ads  - raw ads from API response
 */
export async function updateMarketStats(keyword, category_id, ads) {
  const prices = ads
    .map((a) => (Array.isArray(a.price) ? a.price[0] : a.price))
    .filter((p) => typeof p === "number" && p > 0)
    .sort((a, b) => a - b);

  if (prices.length < 5) return null; // not enough data

  // Remove outliers: discard bottom 5% and top 5%
  const trimmed = prices.slice(Math.floor(prices.length * 0.05), Math.ceil(prices.length * 0.95));

  if (!trimmed.length) return null;

  const stats = {
    id: uuid(),
    keyword,
    category_id: category_id || null,
    timestamp: Date.now(),
    avg_price: mean(trimmed),
    median_price: median(trimmed),
    min_price: trimmed[0],
    max_price: trimmed[trimmed.length - 1],
    sample_count: trimmed.length,
  };

  await savePriceHistory(stats);
  return stats;
}

/**
 * Get the most recent market stats snapshot for a keyword.
 */
export async function getMarketStats(keyword, category_id) {
  return getLatestMarketStats(keyword, category_id);
}

/**
 * Get historical price data for charting (last `limit` snapshots).
 */
export async function getMarketChart(keyword, category_id, limit = 90) {
  return getPriceHistory(keyword, category_id, limit);
}
