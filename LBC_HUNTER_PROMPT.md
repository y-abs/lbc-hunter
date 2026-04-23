# LBC HUNTER — CHROME EXTENSION

## Master Implementation Prompt

---

> **CONTEXT FOR THE IMPLEMENTER**
> You are building a production-grade Chrome Extension (Manifest V3) from an **empty folder**.
> The target user is a professional buy/resell operator spending 6–10 hours/day on lbc.fr.
> Their livelihood depends on being **first** on underpriced deals.
> Every architectural decision must prioritize: speed of detection, reliability, and zero false negatives.
> This document is the single source of truth. Follow it exactly.

---

## 1. PROJECT STRUCTURE — CREATE EXACTLY THIS

```
lbc-hunter/
├── manifest.json
├── package.json
├── vite.config.js
│
├── src/
│   ├── background/
│   │   └── service-worker.js
│   │
│   ├── content/
│   │   ├── session-capture.js       ← runs on lbc.fr pages, grabs api_key
│   │   ├── inject-badges.js         ← injects price badges on listing cards
│   │   └── inject-adpage.js         ← injects chart on individual ad pages
│   │
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.js
│   │   └── popup.css
│   │
│   ├── options/
│   │   ├── options.html
│   │   ├── options.js
│   │   └── options.css
│   │
│   ├── dashboard/
│   │   ├── dashboard.html           ← full-page P&L + stats (opened as tab)
│   │   ├── dashboard.js
│   │   └── dashboard.css
│   │
│   ├── db/
│   │   ├── indexeddb.js             ← ALL database logic lives here
│   │   └── schema.js                ← DB schema constants
│   │
│   ├── core/
│   │   ├── poller.js                ← polling engine
│   │   ├── matcher.js               ← deal matching logic
│   │   ├── pricer.js                ← market price computation
│   │   ├── automator.js             ← purchase automation logic
│   │   └── notifier.js              ← notification dispatch
│   │
│   └── shared/
│       ├── constants.js
│       ├── utils.js
│       └── messages.js              ← all chrome.runtime message types
│
├── assets/
│   ├── icons/
│   │   ├── icon16.png
│   │   ├── icon32.png
│   │   ├── icon48.png
│   │   └── icon128.png
│   └── sounds/
│       ├── alert-red.mp3            ← urgent, distinct
│       └── alert-orange.mp3        ← softer
│
└── dist/                            ← vite build output, load THIS in Chrome
```

---

## 2. MANIFEST.JSON — EXACT CONTENT

```json
{
  "manifest_version": 3,
  "name": "LbC Hunter",
  "version": "1.0.0",
  "description": "Deal sniping, price intelligence, and purchase automation for LbC resellers.",
  "icons": {
    "16": "assets/icons/icon16.png",
    "32": "assets/icons/icon32.png",
    "48": "assets/icons/icon48.png",
    "128": "assets/icons/icon128.png"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": "assets/icons/icon48.png",
    "default_title": "LbC Hunter"
  },
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["*://www.lbc.fr/*"],
      "js": ["content/session-capture.js"],
      "run_at": "document_idle"
    },
    {
      "matches": ["*://www.lbc.fr/recherche*"],
      "js": ["content/inject-badges.js"],
      "run_at": "document_idle",
      "css": []
    },
    {
      "matches": ["*://www.lbc.fr/ad/*"],
      "js": ["content/inject-adpage.js"],
      "run_at": "document_idle"
    }
  ],
  "permissions": ["alarms", "notifications", "storage", "tabs", "scripting", "activeTab", "offscreen", "background"],
  "host_permissions": ["*://www.lbc.fr/*", "*://api.lbc.fr/*"],
  "options_ui": {
    "page": "options/options.html",
    "open_in_tab": true
  },
  "web_accessible_resources": [
    {
      "resources": ["assets/sounds/*.mp3", "dashboard/dashboard.html"],
      "matches": ["*://www.lbc.fr/*", "chrome-extension://*/*"]
    }
  ]
}
```

---

## 3. DATABASE SCHEMA — IndexedDB via `idb` library

**Database name:** `lbc-hunter-db`
**Version:** 1

### Object Stores:

**`ads`** — every ad ever seen by the poller

```js
{
  id: String,             // lbc ad id (primary key)
  list_id: String,        // which watchlist detected this
  title: String,
  price: Number,
  category_id: String,
  location: { city: String, zipcode: String, lat: Number, lng: Number },
  seller_type: String,    // "private" | "pro"
  seller_id: String,
  url: String,
  images: [String],       // first image URL
  created_at: Number,     // unix timestamp from lbc
  seen_at: Number,        // unix timestamp when WE saw it
  is_alerted: Boolean,    // was a notification fired?
  is_messaged: Boolean,   // was auto-message sent?
  is_purchased: Boolean,
  attributes: Object      // raw lbc attributes
}
```

Indexes: `list_id`, `price`, `seen_at`, `seller_id`, `category_id`

**`price_history`** — one record per (keyword+category) per polling cycle, for charting

```js
{
  id: String,             // auto-generated (primary key)
  keyword: String,
  category_id: String,
  timestamp: Number,      // unix
  avg_price: Number,
  median_price: Number,
  min_price: Number,
  max_price: Number,
  sample_count: Number
}
```

Indexes: `keyword`, `timestamp`

**`watchlists`** — user-configured search watches

```js
{
  id: String,             // uuid (primary key)
  name: String,           // user-facing label e.g. "iPhone 14 Pro"
  enabled: Boolean,
  keywords: String,
  category_id: String,    // null = all categories
  price_min: Number,
  price_max: Number,
  location_zip: String,   // null = France-wide
  location_radius_km: Number,
  seller_type: String,    // "all" | "private" | "pro"
  poll_interval_seconds: Number,  // min 30
  undermarket_threshold_pct: Number, // e.g. 20 = alert only if 20% below avg
  auto_message_enabled: Boolean,
  auto_message_template_id: String,
  auto_open_tab: Boolean,
  created_at: Number,
  last_polled_at: Number,
  last_seen_ad_id: String  // for deduplication: only alert on NEW ads
}
```

**`templates`** — message templates

```js
{
  id: String,             // uuid (primary key)
  name: String,           // e.g. "Offre rapide particulier"
  body: String,           // supports {titre}, {prix}, {ville}, {vendeur}
  created_at: Number
}
```

**`purchases`** — P&L tracking

```js
{
  id: String,             // uuid (primary key)
  ad_id: String,          // ref to ads store
  title: String,
  buy_price: Number,
  buy_date: Number,
  sell_price: Number,
  sell_date: Number,
  sell_platform: String,  // "lbc" | "vinted" | "ebay" | "facebook" | "other"
  sell_fees_pct: Number,  // platform fee %
  notes: String,
  status: String          // "bought" | "listed" | "sold"
}
```

**`session`** — stores the captured api_key

```js
{
  id: "current",          // single record
  api_key: String,
  captured_at: Number,
  user_agent: String
}
```

**`blacklist`** — blocked sellers

```js
{
  seller_id: String,      // primary key
  reason: String,
  added_at: Number
}
```

---

## 4. SESSION CAPTURE — `src/content/session-capture.js`

**Goal:** Intercept LbC's internal `api_key` without external scraping.

**Method:** LbC is a Next.js app. The `api_key` is stored in `__NEXT_DATA__` injected into the page HTML as a JSON blob inside `<script id="__NEXT_DATA__">`. Parse it on page load.

**Fallback method:** If not in `__NEXT_DATA__`, intercept XHR/fetch calls made by the page to `api.lbc.fr` and read the `api_key` header from outgoing requests using a page-world script injection.

```js
// STRATEGY 1: Parse __NEXT_DATA__
const nextData = document.getElementById("__NEXT_DATA__");
if (nextData) {
  const parsed = JSON.parse(nextData.textContent);
  const apiKey =
    parsed?.props?.pageProps?.apiKey || parsed?.props?.pageProps?.initialProps?.apiKey || deepSearch(parsed, "api_key"); // recursive search
  if (apiKey) sendToBackground(apiKey);
}

// STRATEGY 2: Intercept outgoing fetch to api.lbc.fr
// Inject a script into page world (not extension world) to hook window.fetch
// Then relay via window.postMessage → content script → background
```

**deepSearch(obj, key):** Recursively traverses an object tree to find any key matching `api_key` or `apiKey`. Return first match.

**On capture:** Send via `chrome.runtime.sendMessage({ type: 'SESSION_CAPTURED', apiKey, userAgent })` to service worker, which stores it in IndexedDB `session` store with `captured_at` timestamp.

**TTL:** If `captured_at` is older than 6 hours, mark session as stale. Show warning badge on extension icon. Re-capture on next lbc.fr page visit automatically.

**Cookies:** The service worker uses `fetch()` with `credentials: 'include'` BUT because service workers can't access cookies cross-origin directly, all API calls to `api.lbc.fr` must be made via a content script injected into an active lbc.fr tab (which has the session cookies). The content script acts as a proxy: receives poll commands from service worker via `chrome.runtime.onMessage`, executes the fetch, and returns results. This is the **correct MV3 pattern**.

---

## 5. POLLING ENGINE — `src/core/poller.js` + `src/background/service-worker.js`

### Alarm Strategy (MV3 compliant)

```js
// service-worker.js
chrome.alarms.create("master-poll", { periodInMinutes: 0.5 }); // 30s minimum
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "master-poll") await runPollCycle();
});
```

**`runPollCycle()`:**

1. Load all `watchlists` from DB where `enabled = true`
2. For each watchlist, check if `(now - last_polled_at) >= poll_interval_seconds`
3. If yes: execute poll for that watchlist
4. Stagger execution: add `index * 2000ms` delay between watchlists to avoid simultaneous requests

### API Call Construction

**Endpoint:** `POST https://api.lbc.fr/finder/2.0/classifieds/search`

**Headers required:**

```
Content-Type: application/json
api_key: {captured api_key}
User-Agent: {captured user_agent from session}
```

**Request body structure:**

```json
{
  "filters": {
    "category": { "id": "{category_id}" },
    "keywords": { "text": "{keywords}", "type": "all" },
    "location": {
      "zipcode": ["{zip}"],
      "area": { "lat": 0.0, "lng": 0.0, "radius": 0 }
    },
    "ranges": {
      "price": { "min": 0, "max": 99999 }
    },
    "enums": {
      "ad_type": ["offer"],
      "owner_type": ["private"]
    }
  },
  "limit": 35,
  "limit_alu": 3,
  "sort_by": "time",
  "sort_order": "desc",
  "owner_type": "private",
  "offset": 0
}
```

**Omit optional fields if null** (no category = omit category block, etc.)

**Response shape:**

```json
{
  "total": 1240,
  "ads": [
    {
      "list_id": 12345678,
      "ad_type": "offer",
      "subject": "iPhone 14 Pro 256Go",
      "price": [650],
      "images": { "urls_large": [...], "thumb_url": "..." },
      "location": { "city": "Paris", "zipcode": "75011", "lat": 48.85, "lng": 2.35 },
      "owner": { "type": "private", "store_id": "...", "name": "..." },
      "first_publication_date": "2024-01-15T14:23:00+01:00",
      "attributes": [...]
    }
  ]
}
```

### Deduplication Logic

For each watchlist, store `last_seen_ad_id` = the `list_id` of the most recent ad from the last poll.

On new poll:

1. Sort returned ads by `first_publication_date` descending
2. Find index of `last_seen_ad_id` in results
3. Everything **above** that index = new ads
4. If `last_seen_ad_id` not found (ad was deleted or pushed off page) = treat ALL returned ads as potentially new, but filter by `seen_at` in local DB

**First poll ever:** Mark all returned ads as seen, set `is_alerted = false`, do NOT fire alerts (avoid spam on install).

---

## 6. DEAL MATCHING — `src/core/matcher.js`

For each new ad, compute match score:

```js
function evaluateDeal(ad, watchlist, marketStats) {
  const result = {
    is_match: false,
    alert_tier: null, // 'red' | 'orange' | 'green'
    pct_below_market: null,
    reasons: [],
  };

  // 1. Price filter
  if (ad.price < watchlist.price_min || ad.price > watchlist.price_max) return result;

  // 2. Location filter (if configured)
  if (watchlist.location_zip && !isWithinRadius(ad, watchlist)) return result;

  // 3. Seller type
  if (watchlist.seller_type !== "all" && ad.seller_type !== watchlist.seller_type) return result;

  // 4. Compute market delta
  if (marketStats && marketStats.median_price) {
    result.pct_below_market = ((marketStats.median_price - ad.price) / marketStats.median_price) * 100;
  }

  // 5. Assign tier
  result.is_match = true;
  if (result.pct_below_market >= watchlist.undermarket_threshold_pct) {
    result.alert_tier = "red"; // genuine deal
  } else if (result.pct_below_market >= 0) {
    result.alert_tier = "orange"; // at or below market
  } else {
    result.alert_tier = "orange"; // overpriced but new listing
  }

  return result;
}
```

**`isWithinRadius(ad, watchlist)`:** Use Haversine formula with `ad.location.lat/lng` and watchlist's zip centroid coordinates. Require: geocode the configured zip once on save, store `lat/lng` in watchlist record.

---

## 7. MARKET PRICE COMPUTATION — `src/core/pricer.js`

**Trigger:** After every successful poll, update market stats for the watchlist keyword.

```js
async function updateMarketStats(keyword, category_id, ads) {
  const prices = ads
    .map((a) => a.price)
    .filter((p) => p > 0)
    .sort((a, b) => a - b);

  // Remove outliers: discard bottom 5% and top 5%
  const trimmed = prices.slice(Math.floor(prices.length * 0.05), Math.ceil(prices.length * 0.95));

  const stats = {
    keyword,
    category_id,
    timestamp: Date.now(),
    avg_price: mean(trimmed),
    median_price: median(trimmed),
    min_price: trimmed[0],
    max_price: trimmed[trimmed.length - 1],
    sample_count: trimmed.length,
  };

  await db.add("price_history", stats);
}
```

**`getMarketStats(keyword, category_id)`:** Query last 50 price_history records for keyword, return the most recent. For charting: return last 90 records.

---

## 8. NOTIFICATION SYSTEM — `src/core/notifier.js`

```js
async function fireAlert(ad, watchlist, matchResult) {
  // Build notification
  const title =
    matchResult.alert_tier === "red" ? `🔴 DEAL ALERT — ${watchlist.name}` : `🟠 Nouvelle annonce — ${watchlist.name}`;

  const pctText = matchResult.pct_below_market ? ` (−${Math.round(matchResult.pct_below_market)}% vs marché)` : "";

  const body = `${ad.title}\n${ad.price}€${pctText} · ${ad.location.city}`;

  chrome.notifications.create(`alert-${ad.id}`, {
    type: "basic",
    iconUrl: ad.images[0] || "assets/icons/icon128.png",
    title,
    message: body,
    buttons: [{ title: "👁 Voir l'annonce" }, { title: "✉ Envoyer message" }],
    priority: matchResult.alert_tier === "red" ? 2 : 1,
    requireInteraction: matchResult.alert_tier === "red",
  });

  // Play sound via offscreen document (MV3 requirement for audio in SW)
  await playAlertSound(matchResult.alert_tier);

  // Update badge
  chrome.action.setBadgeText({ text: String(pendingAlertsCount) });
  chrome.action.setBadgeBackgroundColor({ color: "#E63946" });
}
```

**Notification click handlers:**

```js
chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
  const adId = notifId.replace("alert-", "");
  if (buttonIndex === 0) openAdTab(adId);
  if (buttonIndex === 1) sendAutoMessage(adId);
});
```

**Sound playback (MV3):** Create an offscreen document (`chrome.offscreen.createDocument`) with a hidden `<audio>` element. Send message from SW to offscreen to play the correct sound file.

---

## 9. AUTOMATION ENGINE — `src/core/automator.js`

### Auto-message flow:

1. Retrieve ad from DB
2. Get template from DB (watchlist's `auto_message_template_id`)
3. Interpolate template variables: `{titre}`, `{prix}`, `{ville}`, `{vendeur}`
4. Inject a content script into an active lbc.fr tab
5. Content script navigates to the ad page, finds the message input (`[data-qa-id="adview_contact_container"] textarea` or equivalent), fills it, clicks send
6. Mark `ad.is_messaged = true` in DB

**Rate limiting for auto-message:**

- Never send more than 15 messages/hour across all watchlists
- Store `messages_sent_this_hour` counter in `chrome.storage.session`
- If limit reached: queue messages, log warning, notify user

### Auto-tab-open flow:

When `watchlist.auto_open_tab = true` and `alert_tier = 'red'`:

```js
chrome.tabs.create({ url: ad.url, active: true });
```

### Safety gates (never bypass these):

- Actual payment confirmation: **NEVER automate**. Auto-fill up to the last step only.
- Auto-message: requires explicit `auto_message_enabled = true` on the watchlist
- Daily send cap: hard limit 50 messages/day across all watchlists

---

## 10. BADGE INJECTION — `src/content/inject-badges.js`

**Target:** Every ad card on lbc.fr/recherche pages.

**MutationObserver pattern** (required because LbC is a SPA):

```js
const observer = new MutationObserver(() => injectBadges());
observer.observe(document.body, { childList: true, subtree: true });
injectBadges(); // also run immediately
```

**`injectBadges()`:**

1. Find all ad cards: `document.querySelectorAll('[data-qa-id="aditem_container"]')`
2. For each card, extract ad ID from `href` attribute
3. Query IndexedDB for that ad_id's price vs stored market stats
4. If market stats exist: inject a `<div class="lbch-badge">` absolutely positioned over the card
5. Mark card as processed with `data-lbch-injected="true"` to avoid re-processing

**Badge styles:**

```
🟢 −23% vs marché   → green background, white text
🟡 Prix marché       → yellow background
🔴 +15% vs marché   → red badge (overpriced warning)
🔵 Nouveau           → blue badge for ads < 10 minutes old
```

Inject a `<style>` tag once with `.lbch-badge` styles. Use `z-index: 9999`, `border-radius: 4px`, `font-size: 11px`, `font-weight: 700`, `padding: 2px 6px`, `position: absolute`, `top: 8px`, `right: 8px`.

---

## 11. AD PAGE INJECTION — `src/content/inject-adpage.js`

When on an individual ad page (`/ad/...`):

1. Extract ad ID from URL
2. Query price_history for the ad's keyword + category
3. Inject a Chart.js price history chart after the price element
4. Inject seller stats: how many ads this seller has, their avg price, their rating
5. Show "Fair Value" indicator: `Valeur marché estimée: 650€ · Ce prix: 580€ (−11%)`

**Chart:** Line chart (Chart.js via CDN in the injected script or bundled), 90-day price trend for this keyword, current ad price shown as a horizontal dashed line.

**DOM target for injection:** Insert after `[data-qa-id="adview_price"]`.

---

## 12. POPUP UI — `src/popup/popup.html + popup.js`

**Size:** 380px wide × 520px tall max

**Sections (top to bottom):**

1. **Header bar:** Extension name + settings icon (opens options) + dashboard icon (opens dashboard tab)

2. **Status row:**
   - Green/red dot = polling active/paused
   - "X alertes actives" count
   - Session status: "Session OK" or "⚠ Session expirée — visitez lbc.fr"
   - Toggle: pause all polling

3. **Recent Alerts list (last 10):**
   - Per item: thumbnail | title + price | % badge | city | age | [Open] [Message] [Dismiss]
   - Red items highlighted
   - Click row = open tab
   - "Marquer tout comme vu" button

4. **Active Watchlists summary:**
   - Per watchlist: name | enabled toggle | last poll time | alert count today

5. **Quick add watchlist** button → opens options page at "new watchlist" form

**State management:** Popup reads from IndexedDB directly (not from SW). On open, runs one immediate render, then polls IndexedDB every 2s while open for live updates.

---

## 13. OPTIONS PAGE — `src/options/options.html + options.js`

**Full-page, tab-based layout with these tabs:**

### Tab 1: Watchlists

- List of all watchlists (cards)
- Per card: name, enabled toggle, edit button, delete button, "Tester maintenant" (force poll)
- **Add/Edit Watchlist form fields:**
  - Nom de la recherche (text)
  - Mots-clés (text)
  - Catégorie (dropdown, populated from `constants.js` with all lbc category IDs)
  - Prix min / Prix max (number inputs)
  - Type de vendeur (radio: Tous / Particulier / Pro)
  - Localisation (ZIP code input + rayon en km slider: 0 = national)
  - Intervalle de polling (select: 30s / 1min / 2min / 5min / 15min)
  - Seuil sous-marché (slider 0–50%, default 15%)
  - Auto-ouvrir l'onglet (checkbox)
  - Auto-envoyer message (checkbox + template selector)
  - Save / Cancel

### Tab 2: Templates de messages

- List of templates (name + preview)
- Add/Edit form: name + textarea with variable hints `{titre} {prix} {ville} {vendeur}`
- Built-in default template (can be edited, not deleted)

### Tab 3: Statistiques de marché

- Dropdown: select keyword
- Price history chart (Chart.js, last 30/60/90 days selector)
- Table: min, max, average, median, sample count

### Tab 4: Vendeurs bloqués

- List with seller_id + reason + date
- Unblock button per row

### Tab 5: Paramètres

- Notification sound (select: alert-red, alert-orange, or none)
- Max messages/hour cap (number input, default 15)
- Max messages/day cap (number input, default 50)
- Export data (downloads full IndexedDB as JSON)
- Import data (upload JSON)
- Reset all data (with confirmation modal)

---

## 14. DASHBOARD PAGE — `src/dashboard/dashboard.html + dashboard.js`

Full Chrome tab page for P&L and deep analytics.

### Section 1: KPIs (top row)

- Profit total (ce mois / ce trimestre / tout)
- Nombre d'achats
- ROI moyen
- Meilleure catégorie

### Section 2: P&L Table

- Columns: Titre | Acheté le | Prix achat | Vendu le | Prix vente | Plateforme | Frais | Profit net | Statut
- Sortable columns
- Filters: statut (tous/acheté/listé/vendu), plateforme, date range
- Add purchase button (pre-fills from recent alerted ads list)
- Edit / Delete per row

### Section 3: Charts (2-column grid)

- Profit mensuel (bar chart, 12 months)
- Meilleurs produits (horizontal bar chart, top 10 by profit)
- Temps moyen de revente par catégorie (bar chart)
- Distribution des marges (histogram)

### Section 4: Historique des alertes

- Full table of all alerted ads: date, title, price, % below market, action taken
- Export as CSV button

---

## 15. LBC CATEGORY IDs — `src/shared/constants.js`

```js
export const CATEGORIES = {
  1: "Véhicules",
  2: "Motos",
  3: "Caravaning",
  4: "Utilitaires",
  5: "Equipement Auto",
  6: "Equipement Moto",
  7: "Equipement Caravaning",
  8: "Nautisme",
  9: "Immobilier",
  10: "Locations de vacances",
  11: "Colocations",
  12: "Bureaux & Commerces",
  13: "Terrains & Agricoles",
  14: "Informatique",
  15: "Téléphonie",
  16: "Image & Son",
  17: "Jeux & Jouets",
  18: "Mode",
  19: "Maison",
  20: "Mobilier",
  21: "Electroménager",
  22: "Arts de la Table",
  23: "Décoration",
  24: "Linge de maison",
  25: "Bricolage",
  26: "Jardinage",
  27: "Sports",
  28: "Instruments de musique",
  29: "Collection",
  30: "Livres, BD & Revues",
  31: "Vins & Gastronomie",
  32: "Animaux",
  33: "Matériel agricole",
  34: "Equipement Pro",
  35: "Autres",
  36: "Services",
  37: "Offres d'emploi",
  38: "Demandes d'emploi",
  39: "Cours particuliers",
  40: "Covoiturage",
  41: "Baby-sitting",
  42: "Troc",
};

export const SELLER_TYPES = {
  all: "Tous",
  private: "Particulier",
  pro: "Professionnel",
};

export const POLL_INTERVALS = [30, 60, 120, 300, 900]; // seconds

export const API_ENDPOINT = "https://api.lbc.fr/finder/2.0/classifieds/search";

export const MAX_MESSAGES_PER_HOUR = 15;
export const MAX_MESSAGES_PER_DAY = 50;
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const FIRST_POLL_SKIP_ALERT = true; // don't alert on initial populate
```

---

## 16. MESSAGE PASSING ARCHITECTURE — `src/shared/messages.js`

All `chrome.runtime.sendMessage` types, to be used consistently everywhere:

```js
export const MSG = {
  // content → background
  SESSION_CAPTURED: "SESSION_CAPTURED", // { apiKey, userAgent }
  FETCH_PROXY: "FETCH_PROXY", // { url, options } → response

  // background → content
  EXECUTE_FETCH: "EXECUTE_FETCH", // { url, options, requestId }
  INJECT_MESSAGE_FORM: "INJECT_MESSAGE_FORM", // { adUrl, messageBody }

  // popup/options → background
  FORCE_POLL: "FORCE_POLL", // { watchlistId }
  PAUSE_ALL: "PAUSE_ALL",
  RESUME_ALL: "RESUME_ALL",
  CLEAR_BADGE: "CLEAR_BADGE",

  // background → popup
  ALERT_FIRED: "ALERT_FIRED", // { ad, matchResult, watchlist }
  POLL_STATUS: "POLL_STATUS", // { watchlistId, status, timestamp }

  // offscreen
  PLAY_SOUND: "PLAY_SOUND", // { tier: 'red' | 'orange' }
};
```

---

## 17. PACKAGE.JSON + BUILD SETUP

```json
{
  "name": "lbc-hunter",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "idb": "^8.0.0",
    "chart.js": "^4.4.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "vite": "^5.0.0"
  }
}
```

**`vite.config.js`:**

```js
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        "background/service-worker": resolve(__dirname, "src/background/service-worker.js"),
        "content/session-capture": resolve(__dirname, "src/content/session-capture.js"),
        "content/inject-badges": resolve(__dirname, "src/content/inject-badges.js"),
        "content/inject-adpage": resolve(__dirname, "src/content/inject-adpage.js"),
        "popup/popup": resolve(__dirname, "src/popup/popup.html"),
        "options/options": resolve(__dirname, "src/options/options.html"),
        "dashboard/dashboard": resolve(__dirname, "src/dashboard/dashboard.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
    target: "chrome110",
    minify: false, // keep readable for debugging during dev
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
```

**Copy `manifest.json` and `assets/` to `dist/` post-build** — add a simple copy script or use `vite-plugin-static-copy`.

---

## 18. CRITICAL IMPLEMENTATION NOTES

### MV3 Service Worker limitations:

- Service workers are **terminated** after ~30s of inactivity. `chrome.alarms` is the ONLY reliable way to wake them. Never use `setInterval` in the SW.
- SW cannot access DOM or play audio. All audio must go through an **offscreen document**.
- SW cannot directly use cookies. All credentialed fetches must be proxied through a content script running in an active lbc.fr tab.

### Content script fetch proxy pattern (REQUIRED):

```js
// In service-worker.js — to make an authenticated fetch:
async function fetchViaContentScript(url, options) {
  // Find an active lbc.fr tab
  const tabs = await chrome.tabs.query({ url: "*://www.lbc.fr/*" });
  if (!tabs.length) throw new Error("NO_LBC_TAB");

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabs[0].id,
      {
        type: MSG.EXECUTE_FETCH,
        url,
        options,
        requestId: crypto.randomUUID(),
      },
      (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(response);
      },
    );
  });
}
```

```js
// In session-capture.js (content script) — listen for fetch proxy requests:
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.EXECUTE_FETCH) {
    fetch(msg.url, { ...msg.options, credentials: "include" })
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});
```

### DataDome anti-bot:

- Never set `credentials: 'omit'`. Always use `credentials: 'include'`.
- Always pass the user's real `User-Agent` (captured during session capture).
- Add realistic jitter to polling: `interval + Math.random() * 10000` ms.
- Never poll faster than 30 seconds. Recommended default: 60s.
- If a request returns `403` with `x-dd-b` header (DataDome block): pause that watchlist for 5 minutes, notify user.

### No active lbc.fr tab:

- If no LBC tab is open, the SW cannot make fetch calls.
- Show a warning in popup: "Ouvrez un onglet lbc.fr pour activer le polling".
- When user opens a new LBC tab: content script fires `SESSION_CAPTURED` → SW resumes polling automatically.

### Offscreen document for audio:

```js
// In service-worker.js:
async function playAlertSound(tier) {
  await chrome.offscreen
    .createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play alert sound for deal notification",
    })
    .catch(() => {}); // already exists = ignore error

  chrome.runtime.sendMessage({
    type: MSG.PLAY_SOUND,
    tier,
  });
}
```

```html
<!-- src/offscreen/offscreen.html -->
<audio id="sound-red" src="../assets/sounds/alert-red.mp3"></audio>
<audio id="sound-orange" src="../assets/sounds/alert-orange.mp3"></audio>
<script src="offscreen.js"></script>
```

---

## 19. UI/UX DESIGN REQUIREMENTS

**Visual identity:** Dark theme. Deep navy background (`#0D1117`). Accent: electric orange (`#FF6B35`) for red-tier alerts, amber (`#FFC300`) for orange-tier. White text. Monospaced font for prices (e.g. `JetBrains Mono` or `Roboto Mono`). Clean sans-serif for UI (`DM Sans`).

**Popup:** Compact, information-dense. No unnecessary whitespace. Each alert row must be scannable in < 1 second. Thumbnail on left, data on right, action buttons always visible.

**Options:** Spacious, tabs clearly labeled. Form fields have inline validation. Save confirmation toast (not modal). Destructive actions require confirm modal.

**Dashboard:** Full-page analytics feel. Charts use `Chart.js` with custom dark theme. Tables are sortable and filterable.

**Accessibility:** All interactive elements have `:focus-visible` styles. Keyboard navigable. Color-coding is always accompanied by text/icon (not color alone).

---

## 20. ERROR HANDLING & EDGE CASES

| Scenario                      | Behavior                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `api_key` not found on page   | Retry after 3s, try fetch-intercept fallback, show "Session non trouvée" in popup |
| Poll returns 401              | Clear session, set badge to ⚠, prompt re-capture                                  |
| Poll returns 403 (DataDome)   | Pause watchlist 5min, log event, show warning                                     |
| Poll returns 429 (rate limit) | Exponential backoff: 2min, 4min, 8min, 16min, then notify user                    |
| Poll returns 5xx              | Retry after 30s (max 3 retries), then pause 10min                                 |
| No LBC tab open               | Pause all polling, show warning. Resume automatically when LBC tab detected       |
| IndexedDB storage > 200MB     | Show storage warning in options. Offer to purge ads older than 30 days            |
| Auto-message DOM not found    | Log failure, mark `is_messaged = false`, show manual fallback button in popup     |
| Duplicate notification        | Deduplicate by `ad.id` — never fire two notifications for the same ad_id          |

---

## 21. DEVELOPMENT ORDER (STRICT)

Follow this order. Each phase must be **fully working** before proceeding.

**Phase 1 — Foundation (start here)**

1. `package.json` + `vite.config.js` + `manifest.json`
2. `src/shared/constants.js` + `src/shared/messages.js` + `src/shared/utils.js`
3. `src/db/schema.js` + `src/db/indexeddb.js` (full DB implementation with all stores and indexes)
4. `src/content/session-capture.js` — verify api_key capture works on real lbc.fr

**Phase 2 — Core Loop** 5. `src/background/service-worker.js` — alarm setup, message routing skeleton 6. `src/core/poller.js` — single watchlist poll, log raw results to console 7. `src/core/matcher.js` — deal evaluation 8. `src/core/pricer.js` — market stats computation 9. `src/core/notifier.js` + offscreen audio

**Phase 3 — UI** 10. `src/popup/` — status + recent alerts list (read-only first) 11. `src/options/` — watchlist CRUD + template CRUD 12. Popup actions: pause/resume, open tab, dismiss

**Phase 4 — Content Injection** 13. `src/content/inject-badges.js` 14. `src/content/inject-adpage.js`

**Phase 5 — Automation** 15. `src/core/automator.js` — auto-message send

**Phase 6 — Dashboard** 16. `src/dashboard/` — full P&L + charts

---

## 22. TESTING CHECKLIST

Before calling any phase complete:

- [ ] Load unpacked extension in Chrome at `chrome://extensions/` — no manifest errors
- [ ] Visit lbc.fr — no console errors in content scripts
- [ ] Verify api_key captured: check IndexedDB `session` store in DevTools
- [ ] Create 1 watchlist via options page — verify saved in DB
- [ ] Force poll via "Tester maintenant" — verify ads appear in DB
- [ ] Verify notification fires for a new matching ad
- [ ] Verify badge appears on search results page
- [ ] Verify audio plays on red alert
- [ ] Verify popup shows correct data
- [ ] Verify no errors on polling when no LBC tab is open

---

_This document is complete. Begin implementation at Phase 1, step 1._
