// ─────────────────────────────────────────────
//  LbC Hunter — Session Capture
//  Runs on every lbc.fr page.
//  Goals: capture api_key, proxy API fetches for SW.
// ─────────────────────────────────────────────

import { MSG } from "@/shared/messages.js";
import { SESSION_CAPTURE_CACHE_MAX_AGE_MS } from "@/shared/constants.js";
import { deepSearch, log, warn } from "@/shared/utils.js";

// Known header names LBC could use for the API key
const API_KEY_HEADERS = [
  "api_key",
  "Api_key",
  "API_KEY",
  "api-key",
  "x-api-key",
  "authorization",
  "Authorization",
  "x-auth-token",
  "token",
];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidMessageEnvelope(msg) {
  return isPlainObject(msg) && typeof msg.type === "string" && msg.type.length <= 64;
}

function emitSecurityEvent(event, source, reason) {
  chrome.runtime
    .sendMessage({
      type: MSG.SECURITY_EVENT,
      event,
      source,
      reason,
    })
    .catch(() => {});
}

function readCapture(maxAgeMs = SESSION_CAPTURE_CACHE_MAX_AGE_MS) {
  try {
    const raw = localStorage.getItem("__lbch_capture__");
    if (!raw) return null;
    const data = JSON.parse(raw);
    const age = Date.now() - (data?.ts || 0);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      localStorage.removeItem("__lbch_capture__");
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function isAllowedProxyRequest(url, options) {
  let parsed;
  try {
    parsed = new URL(String(url || ""), location.origin);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.lbc.fr") return false;
  if (parsed.pathname !== "/finder/search") return false;

  const opts = isPlainObject(options) ? options : {};
  const method = String(opts.method || "POST").toUpperCase();
  if (method !== "POST") return false;
  if (opts.body != null && typeof opts.body !== "string") return false;
  if (typeof opts.body === "string" && opts.body.length > 20_000) return false;
  if (opts.headers != null && !isPlainObject(opts.headers) && !(opts.headers instanceof Headers)) return false;

  return true;
}

// ── Strategy 1: parse __NEXT_DATA__ ──────────

function tryNextData() {
  try {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;
    const parsed = JSON.parse(el.textContent);
    return (
      parsed?.props?.pageProps?.apiKey ||
      parsed?.props?.pageProps?.initialProps?.apiKey ||
      deepSearch(parsed, "api_key") ||
      deepSearch(parsed, "apiKey")
    );
  } catch {
    return null;
  }
}

// ── Strategy 2: read from localStorage (written by page-interceptor.js) ──

function tryLocalStorage() {
  const data = readCapture();
  if (!data) return null;
  return extractApiKeyFromHeaders(data.headers);
}

// Fresh-only variant: rejects captures older than maxAgeMs.
// Used during REFRESH_SESSION to avoid re-anchoring with a provably stale key.
function tryLocalStorageFresh(maxAgeMs = SESSION_CAPTURE_CACHE_MAX_AGE_MS) {
  const data = readCapture(maxAgeMs);
  if (!data) return null;
  return extractApiKeyFromHeaders(data.headers);
}

// ── Extract api_key from a plain-object headers map ──────────────────────────

function extractApiKeyFromHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;

  // Try known header names first
  for (const name of API_KEY_HEADERS) {
    const val = headers[name];
    if (val && typeof val === "string" && val.length >= 16) {
      // Authorization often looks like "Bearer <token>", extract the token
      const clean = val.startsWith("Bearer ") ? val.slice(7) : val;
      if (clean.length >= 16) return clean;
    }
  }

  // Fallback: look for any header value that looks like an opaque API token
  // (32+ hex chars, no spaces, not a content-type or accept value)
  const skip = new Set([
    "content-type",
    "accept",
    "accept-language",
    "accept-encoding",
    "cache-control",
    "user-agent",
    "content-length",
    "origin",
    "referer",
    "host",
    "connection",
    "pragma",
  ]);
  for (const [name, val] of Object.entries(headers)) {
    if (skip.has(name.toLowerCase())) continue;
    if (typeof val === "string" && val.length >= 32 && !/\s/.test(val)) {
      return val;
    }
  }
  return null;
}

// ── Strategy 3: listen for postMessage from page-world (page-interceptor.js) ─

function listenForPageMessage() {
  function onCapture(e) {
    if (e.source !== window) return;
    if (e.data?.type !== "__LBCH_CAPTURED__") return;

    // SECURITY: validate the claimed fetch URL is actually api.lbc.fr.
    // Any same-window script (LBC's own code, third-party ads/analytics, a
    // browser extension injecting into MAIN world) can postMessage this shape
    // and otherwise overwrite the stored api_key with attacker-controlled
    // headers. We only trust postMessages whose `url` is LBC's API host.
    let claimedUrl = "";
    try {
      claimedUrl = String(e.data.url || "");
    } catch (_) {
      return;
    }
    let isLbcApi = false;
    try {
      const u = new URL(claimedUrl, location.origin);
      isLbcApi = u.protocol === "https:" && u.hostname === "api.lbc.fr";
    } catch (_) {
      isLbcApi = false;
    }
    if (!isLbcApi) return;

    const headers = e.data.headers || {};
    const apiKey = extractApiKeyFromHeaders(headers);

    window.removeEventListener("message", onCapture);

    if (apiKey) {
      sendApiKey(apiKey);
    } else {
      // We know the page is making API calls — session is alive via cookies.
      // Use a synthetic sentinel so SW marks session as valid.
      log("LBC API call detected — no distinct api_key header, using cookie-auth sentinel");
      sendApiKey("__cookie_auth__");
    }
  }
  window.addEventListener("message", onCapture);
}

// ── Strategy 4: active probe ──────────────────────────────────────────────────
// Makes a real authenticated fetch to api.lbc.fr using browser cookies.
// Works on a completely idle tab (no page API call needed).
// Reliable on long-overnight sessions where localStorage capture is stale.

function probeAndRenewSession() {
  // Only use a key if it's demonstrably fresh — a stale key would be re-anchored
  // on probe success (cookies do the real auth) and later rejected by LBC when
  // the poller sends it in the api_key header.
  const freshKey = tryLocalStorageFresh();
  const headers = { "Content-Type": "application/json" };
  if (freshKey) headers["api_key"] = freshKey;

  fetch("https://api.lbc.fr/finder/search", {
    method: "POST",
    credentials: "include", // browser cookies carry the real auth — works even without api_key
    headers,
    body: JSON.stringify({
      filters: { keywords: { text: "a", type: "all" }, enums: { ad_type: ["offer"] } },
      limit: 1,
    }),
  })
    .then((r) => {
      if (r.ok) {
        log("Session probe OK — re-anchoring captured_at");
        // Re-anchor with the fresh key if we have one; otherwise the cookie-auth
        // sentinel so the SW drops the api_key header on future polls.
        sendApiKey(freshKey || "__cookie_auth__");
      } else {
        warn("Session probe returned HTTP", r.status, "— session may be truly expired");
      }
    })
    .catch((e) => {
      warn("Session probe network error:", e.message);
    });
}

// ── Send captured api_key to background ──────

function sendApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return;
  log("Session captured, dispatching to SW");
  chrome.runtime
    .sendMessage({
      type: MSG.SESSION_CAPTURED,
      apiKey,
      userAgent: navigator.userAgent,
    })
    .catch(() => {});
  // Reduce local token exposure once the SW persisted the active session.
  try {
    localStorage.removeItem("__lbch_capture__");
  } catch (_) {}
}

// ── Proxy: handle EXECUTE_FETCH and REFRESH_SESSION from service-worker ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!isValidMessageEnvelope(msg)) {
    emitSecurityEvent("blocked_message_envelope", "content.session-capture", "invalid_message");
    sendResponse({ ok: false, error: "invalid_message" });
    return false;
  }

  // Liveness check — synchronous reply. Used by the SW to detect frozen/Memory-Saver tabs
  // before committing to a 20-second FETCH_TIMEOUT. Must return false (no async needed).
  if (msg.type === MSG.PING) {
    sendResponse({ pong: true });
    return false;
  }

  if (msg.type === MSG.EXECUTE_FETCH) {
    // SECURITY (defense-in-depth): only proxy fetches to api.lbc.fr.
    // The SW should never target anything else — enforcing this here blocks
    // an entire class of attacks where a future SW bug (or compromised
    // chrome.storage import) could abuse the content-script's cookie-bearing
    // fetch proxy to exfiltrate data or take actions as the logged-in user.
    if (!isAllowedProxyRequest(msg.url, msg.options)) {
      emitSecurityEvent("blocked_proxy_request", "content.session-capture", "blocked_non_lbc_url");
      sendResponse({ ok: false, error: "blocked_non_lbc_url" });
      return false;
    }
    const opts = isPlainObject(msg.options) ? msg.options : {};
    fetch(msg.url, {
      ...opts,
      method: "POST",
      credentials: "include",
      headers: opts.headers || { "Content-Type": "application/json" },
    })
      .then((r) => {
        if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data, status: 200 }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open for async
  }

  if (msg.type === MSG.REFRESH_SESSION) {
    // A: DOM parse — most reliable if page was recently loaded
    const fromNextData = tryNextData();
    if (fromNextData) {
      sendApiKey(fromNextData);
      sendResponse({ ok: true, method: "next_data" });
      return false;
    }

    // B: localStorage — only accept if capture is < 4h old (avoids re-sending expired key)
    const fromStorage = tryLocalStorageFresh();
    if (fromStorage) {
      sendApiKey(fromStorage);
      sendResponse({ ok: true, method: "storage_fresh" });
      return false;
    }

    // C: active probe — makes a real API fetch using browser cookies.
    // This is the primary path for long-idle tabs where static sources are stale.
    probeAndRenewSession();

    // D: passive fallback — fires if the page happens to make an API call first
    listenForPageMessage();

    sendResponse({ ok: true, method: "probe" });
    return false;
  }
});

// ── Init ──────────────────────────────────────

function init() {
  // Strategy 1: parse __NEXT_DATA__
  const fromNextData = tryNextData();
  if (fromNextData) {
    sendApiKey(fromNextData);
    return;
  }

  // Strategy 2: read from localStorage (page-interceptor may have already fired)
  const fromStorage = tryLocalStorage();
  if (fromStorage) {
    sendApiKey(fromStorage);
    return;
  }

  // Strategy 3: wait for the next API call (fired by page-interceptor.js via postMessage)
  listenForPageMessage();

  // Strategy 4: retry after 3 s (SPA may not have fetched yet at document_idle)
  setTimeout(() => {
    const delayed = tryNextData() || tryLocalStorage();
    if (delayed) sendApiKey(delayed);
  }, 3000);

  // Strategy 5: active probe — only if no fresh session already captured (< 4h).
  // Avoids a real API fetch on every LBC page load when the session is perfectly fine.
  if (!tryLocalStorageFresh()) {
    probeAndRenewSession();
  }
}

init();
