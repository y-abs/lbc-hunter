// ─────────────────────────────────────────────
//  Factory functions for test fixtures.
//  Defaults match real LBC API / watchlist schemas.
// ─────────────────────────────────────────────

let _idCounter = 1;
const nextId = () => String(1_000_000 + _idCounter++);

export function makeAd(overrides = {}) {
  const id = overrides.id ?? nextId();
  return {
    id,
    list_id: overrides.list_id ?? "wl-default",
    subject: "Nintendo Switch OLED",
    title: "Nintendo Switch OLED",
    body: "Très bon état, comme neuve",
    price: [250],
    category_id: "30",
    first_publication_date: new Date("2026-04-20T10:00:00Z").toISOString(),
    seen_at: Date.now(),
    indexed_at: Date.now(),
    owner: { type: "private", user_id: "user-42", store_id: null, name: "Alice" },
    location: { lat: 48.8566, lng: 2.3522, city: "Paris", zipcode: "75001" },
    images: ["https://example.test/img.jpg"],
    attributes: [],
    url: `https://www.leboncoin.fr/ad/collection/${id}`,
    ...overrides,
  };
}

export function makeWatchlist(overrides = {}) {
  return {
    id: overrides.id ?? "wl-" + _idCounter++,
    name: "Switch OLED",
    keywords: "nintendo switch oled",
    category_id: "30",
    price_min: 0,
    price_max: 500,
    poll_interval_sec: 60,
    seller_type: "all",
    location_zip: "",
    location_lat: null,
    location_lng: null,
    location_radius_km: 0,
    undermarket_threshold_pct: 15,
    require_market_data: true,
    shipping_filter: "any",
    purchase_mode: "off",
    purchase_budget_max: 500,
    enabled: true,
    last_seen_ad_id: null,
    last_polled_at: 0,
    created_at: Date.now(),
    ...overrides,
  };
}

export function makeMarketStats(overrides = {}) {
  return {
    id: "stats-" + _idCounter++,
    keyword: "nintendo switch oled",
    category_id: "30",
    timestamp: Date.now(),
    avg_price: 300,
    median_price: 300,
    min_price: 250,
    max_price: 350,
    sample_count: 10,
    ...overrides,
  };
}

export function makePurchase(overrides = {}) {
  return {
    id: "purchase-" + _idCounter++,
    ad_id: nextId(),
    title: "Nintendo Switch OLED",
    buy_price: 250,
    sell_price: null,
    buy_date: Date.now(),
    purchased_at: Date.now(),
    created_at: Date.now(),
    status: "pending",
    platform: "lbc",
    ...overrides,
  };
}

export function resetFactoryCounter() {
  _idCounter = 1;
}
