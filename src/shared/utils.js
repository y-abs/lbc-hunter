// ─────────────────────────────────────────────
//  LbC Hunter — shared utilities
// ─────────────────────────────────────────────

/**
 * Recursively searches an object tree for the first matching key.
 * @param {*} obj
 * @param {string} targetKey
 * @param {number} depth  guard against circular / deeply nested structures
 * @returns {*|null}
 */
export function deepSearch(obj, targetKey, depth = 0) {
  if (depth > 10 || obj === null || typeof obj !== "object") return null;
  if (Object.hasOwn(obj, targetKey)) return obj[targetKey];
  for (const val of Object.values(obj)) {
    const found = deepSearch(val, targetKey, depth + 1);
    if (found !== null && found !== undefined) return found;
  }
  return null;
}

/**
 * Haversine distance between two lat/lng points, in km.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Statistical helpers
 */
export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Format a price number as a French locale string.
 */
export function formatPrice(n) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

/**
 * Return a human-readable relative time string (French).
 */
export function relativeTime(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `il y a ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h}h`;
  const d = Math.floor(h / 24);
  return `il y a ${d}j`;
}

/**
 * Interpolate message template variables.
 */
export function interpolateTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

/**
 * Simple UUID v4 (uses crypto.randomUUID when available)
 */
export function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Sleep helper. NOTE: do NOT use in service-worker hot paths — see swKeepAlive().
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SW-safe delay for use inside MV3 service workers.
 *
 * Chrome kills MV3 service workers after ~30 seconds with no active Chrome
 * Extension API call in flight. A bare `setTimeout` (i.e. `sleep()`) does
 * NOT count as an active call — so any `await sleep(N)` in the SW is a
 * potential kill site that resets all module-level state and aborts any
 * in-progress operation (backfill loop, stagger, etc.).
 *
 * This helper keeps the SW alive by chaining noop `chrome.storage.session.set`
 * calls every 100 ms throughout the delay. Each set() is an active Chrome
 * Extension API call that resets the idle timer. The noop key `__ka` is
 * deliberately kept small — it's just a heartbeat timestamp.
 *
 * For delays ≤ 10 ms, a single set() suffices (essentially instant).
 * For longer delays, we pulse every 100 ms to stay well under the 30s limit.
 *
 * IMPORTANT: only call this from service worker context (not content scripts
 * or extension pages) — `chrome.storage.session` is a SW-only API.
 */
export async function swKeepAlive(ms) {
  if (ms <= 0) return;
  const PULSE = 100; // ms between heartbeat pings
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await chrome.storage.session.set({ __ka: Date.now() });
    const remaining = end - Date.now();
    if (remaining <= 0) break;
    // Wait up to PULSE ms using a real setTimeout — but the NEXT iteration's
    // chrome.storage.session.set will anchor us before the SW can be killed.
    await new Promise((r) => setTimeout(r, Math.min(PULSE, remaining)));
  }
}

/**
 * Clamp a value within [min, max].
 */
export function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/**
 * Build a lbc ad URL from a list_id.
 */
export function adUrl(listId) {
  return `https://www.lbc.fr/ad/collection/${listId}`;
}

/**
 * Return `candidate` if it is a well-formed lbc.fr https URL,
 * otherwise fall back to an API-built URL for `listId`.
 *
 * Defense-in-depth: `ad.url` is emitted by the LBC API, i.e. flows
 * through attacker-controllable ad records. Anywhere we feed that value
 * into `chrome.tabs.create({url})` or `window.location.href = url` a
 * malformed scheme (`javascript:`, `data:`, `blob:`) would hijack the
 * lbc.fr origin — stealing session cookies, auto-sending
 * messages, exfiltrating the logged-in user's profile data. This gate
 * must run at every such sink, not only at render time.
 */
export function lbcAdUrl(candidate, listId) {
  if (typeof candidate === "string") {
    try {
      const u = new URL(candidate, "https://www.lbc.fr/");
      if (u.protocol === "https:" && /(^|\.)lbc\.fr$/i.test(u.hostname)) {
        return u.href;
      }
    } catch (_) {
      /* fall through to canonical url */
    }
  }
  return adUrl(listId);
}

/**
 * Sanitize a user-controllable URL before rendering it into an href/src attribute.
 * Defeats XSS from imported JSON carrying `javascript:`, `data:`, `vbscript:`,
 * `blob:`, etc. Returns the fallback when the input is not plain http(s) or a
 * relative path.
 */
export function safeUrl(url, fallback = "#") {
  if (typeof url !== "string") return fallback;
  const trimmed = url.trim();
  if (!trimmed) return fallback;
  // Allow protocol-relative and absolute http(s) only. Reject anything with an
  // explicit scheme that isn't http(s) — this catches `javascript:`, `data:`,
  // `vbscript:`, `file:`, `blob:` and future exotic schemes.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) return "https:" + trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return fallback; // any other scheme
  return fallback; // relative paths aren't expected for LBC ad URLs
}

/**
 * Escape a string for safe insertion into HTML text/attribute contexts.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Log helper (prefixed, only in non-production)
 */
export function log(...args) {
  console.log("[LBC-Hunter]", ...args);
}
export function warn(...args) {
  console.warn("[LBC-Hunter]", ...args);
}
export function error(...args) {
  console.error("[LBC-Hunter]", ...args);
}

/**
 * Escape a single CSV cell value.
 *
 * Defeats CSV formula-injection (CWE-1236 / aka "CSV Injection" /
 * "Formula Injection"): when Excel, LibreOffice Calc, or Google Sheets
 * opens a CSV, any cell whose first character is `=`, `+`, `-`, `@`,
 * `\t` (tab) or `\r` is interpreted as a formula and executed — this
 * includes `=HYPERLINK(...)`, `=cmd|...`, and `=IMPORTDATA(...)` which
 * can exfiltrate the spreadsheet to a remote URL. Ad titles and seller
 * names flow end-to-end from lbc.fr (attacker-controllable) into
 * our CSV, so every cell must be neutralised.
 *
 * Strategy: prefix a leading `'` to dangerous values so the spreadsheet
 * treats the cell as text, then RFC-4180-quote and escape embedded
 * double quotes. Always returns the cell wrapped in double quotes for
 * consistency and to survive cells containing the delimiter.
 */
export function csvCell(value) {
  const str = String(value ?? "");
  // Trigger characters per OWASP CSV Injection cheat sheet.
  const needsNeutralize = /^[=+\-@\t\r]/.test(str);
  const body = (needsNeutralize ? "'" + str : str).replace(/"/g, '""');
  return `"${body}"`;
}

/**
 * Resolve whether an ad supports shipping/delivery, and at what cost.
 *
 * LBC exposes shipping information in MULTIPLE places depending on the
 * category, the API version, and whether the ad is a raw search-result
 * payload or a persisted DB record. Checking a single path (the legacy
 * `attributes[].key === 'is_shipping_enabled'`) misses most real ads —
 * visible symptom: every ad in the dashboard flagged "🤝 Main propre"
 * and the Feed "Livraison" column showing "—" even on listings where
 * LBC itself displays a delivery option.
 *
 * Authoritative paths (checked in order of reliability):
 *   1. Pre-processed DB fields (`is_shipping_enabled` / `shipping_cost`)
 *   2. `attributes[]` array with key `is_shipping_enabled` (legacy API)
 *   3. `attributes[]` with key `shipping_type` (modern API — non-empty means shippable)
 *   4. `options.shippable` / `has_options.shippable` (feature-flag object)
 *   5. `shipping.enabled` (older nested object)
 *   6. Presence of any shipping_cost-ish attribute or field (implies shippable)
 *
 * Cost resolution covers `shipping_cost`, `shipping_fees`, `shipping_fee`,
 * `options.shipping_cost`, and `shipping.cost`. Numeric parsing is guarded
 * against NaN (non-finite results coerce to null) so downstream UI never
 * renders "NaN€".
 *
 * @returns {{ enabled: boolean, cost: number|null }}
 */
export function resolveShipping(ad) {
  if (!ad || typeof ad !== "object") return { enabled: false, cost: null };

  // ── Cost first (some shippable ads don't carry an explicit enabled flag
  //    but always have a cost field; detecting cost lets us infer enabled)
  let cost = null;
  const costCandidates = [
    ad.shipping_cost,
    ad.options?.shipping_cost,
    ad.options?.shipping_fee,
    ad.options?.shipping_fees,
    ad.shipping?.cost,
    ad.shipping?.fee,
  ];
  for (const c of costCandidates) {
    if (c == null) continue;
    const n = typeof c === "number" ? c : Number(c);
    if (Number.isFinite(n)) {
      cost = n;
      break;
    }
  }
  const attrs = Array.isArray(ad.attributes) ? ad.attributes : [];
  if (cost == null) {
    for (const a of attrs) {
      if (!a || typeof a !== "object") continue;
      if (a.key === "shipping_cost" || a.key === "shipping_fee" || a.key === "shipping_fees") {
        const n = Number(a.value);
        if (Number.isFinite(n)) {
          cost = n;
          break;
        }
      }
    }
  }

  // ── Enabled flag
  let enabled = false;

  // (1) Pre-processed DB field — only TRUE overrides; false is inconclusive
  // because legacy records written before the detection was widened may
  // carry `is_shipping_enabled: false` despite the ad actually supporting
  // delivery. Let the fallback paths override a stored `false`.
  if (ad.is_shipping_enabled === true) enabled = true;

  // (2) Legacy attribute
  if (!enabled) {
    const shAttr = attrs.find((a) => a?.key === "is_shipping_enabled");
    if (shAttr && (shAttr.value === "1" || shAttr.value === "true" || shAttr.value === true)) {
      enabled = true;
    }
  }

  // (3) Modern shipping_type attribute — non-empty value means a delivery
  // method is available (e.g. 'courier', 'custom', 'click_collect').
  if (!enabled) {
    const typeAttr = attrs.find((a) => a?.key === "shipping_type" || a?.key === "item_shipping_status");
    if (
      typeAttr &&
      typeof typeAttr.value === "string" &&
      typeAttr.value.trim() &&
      typeAttr.value !== "none" &&
      typeAttr.value !== "not_shippable"
    ) {
      enabled = true;
    }
  }

  // (4) Feature-flag object
  if (!enabled) {
    if (ad.options?.shippable === true) enabled = true;
    else if (ad.has_options?.shippable === true) enabled = true;
    else if (typeof ad.shipping_type === "string" && ad.shipping_type.trim() && ad.shipping_type !== "none")
      enabled = true;
  }

  // (5) Older nested shape
  if (!enabled && ad.shipping?.enabled === true) enabled = true;

  // (6) Cost presence implies shippable. Guard against 0: ad listings
  // occasionally carry a `shipping_cost: 0` attribute meaning "free
  // delivery included", which is VALID shippable. Only positive OR zero
  // numeric costs count — a missing cost stays inconclusive here.
  if (!enabled && cost != null) enabled = true;

  // Final guard: if not shippable, cost makes no sense.
  if (!enabled) cost = null;

  return { enabled, cost };
}
