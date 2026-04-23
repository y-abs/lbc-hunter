// ─────────────────────────────────────────────
//  LbC Hunter — IndexedDB Schema constants
// ─────────────────────────────────────────────

export const STORES = {
  ADS: "ads",
  PRICE_HISTORY: "price_history",
  WATCHLISTS: "watchlists",
  TEMPLATES: "templates",
  PURCHASES: "purchases",
  SESSION: "session",
  BLACKLIST: "blacklist",
};

export const SCHEMA = {
  [STORES.ADS]: {
    keyPath: "id",
    indexes: [
      { name: "list_id", keyPath: "list_id", unique: false },
      { name: "price", keyPath: "price", unique: false },
      { name: "seen_at", keyPath: "seen_at", unique: false },
      { name: "seller_id", keyPath: "seller_id", unique: false },
      { name: "category_id", keyPath: "category_id", unique: false },
    ],
  },
  [STORES.PRICE_HISTORY]: {
    keyPath: "id",
    autoIncrement: false,
    indexes: [
      { name: "keyword", keyPath: "keyword", unique: false },
      { name: "timestamp", keyPath: "timestamp", unique: false },
    ],
  },
  [STORES.WATCHLISTS]: {
    keyPath: "id",
    indexes: [],
  },
  [STORES.TEMPLATES]: {
    keyPath: "id",
    indexes: [],
  },
  [STORES.PURCHASES]: {
    keyPath: "id",
    indexes: [
      { name: "ad_id", keyPath: "ad_id", unique: false },
      { name: "status", keyPath: "status", unique: false },
    ],
  },
  [STORES.SESSION]: {
    keyPath: "id",
    indexes: [],
  },
  [STORES.BLACKLIST]: {
    keyPath: "seller_id",
    indexes: [],
  },
};
