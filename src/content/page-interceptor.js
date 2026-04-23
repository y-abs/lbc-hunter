// ─────────────────────────────────────────────
//  LbC Hunter — Page-World Fetch + XHR Interceptor
//
//  Runs in world: "MAIN" (same execution context as the page itself).
//  Chrome injects this file natively at document_start — bypasses CSP.
//  No Chrome extension APIs here; communicates via window.postMessage.
// ─────────────────────────────────────────────

(function () {
  if (window.__LBCH_INTERCEPTED__) return;
  window.__LBCH_INTERCEPTED__ = true;

  // Serialize a Headers instance or plain object into a plain JS object
  function headersToObject(headers) {
    if (!headers) return {};
    const out = {};
    if (typeof headers.forEach === "function") {
      // Headers instance
      headers.forEach(function (val, name) {
        out[name] = val;
      });
    } else if (typeof headers === "object") {
      // Clone plain object
      Object.keys(headers).forEach(function (k) {
        out[k] = headers[k];
      });
    }
    return out;
  }

  // SECURITY: reject anything that isn't an actual https://api.lbc.fr/*
  // request. Substring-matching `url.indexOf('api.lbc.fr')` is exploitable
  // because any MAIN-world script on lbc.fr (ads, analytics, third-party
  // widgets, other browser extensions injecting into MAIN) can call
  //   fetch('https://evil.example/?hint=api.lbc.fr', { headers: { api_key: 'X'.repeat(40) } })
  // and poison the api_key we later read from localStorage / postMessage.
  function isRealLbcApi(url) {
    try {
      const parsed = new URL(String(url || ""), location.origin);
      return parsed.protocol === "https:" && parsed.hostname === "api.lbc.fr";
    } catch (_) {
      return false;
    }
  }

  function postCapture(url, allHeaders, bodyPreview) {
    if (!isRealLbcApi(url)) return;
    try {
      localStorage.setItem("__lbch_capture__", JSON.stringify({ url: url, headers: allHeaders, ts: Date.now() }));
    } catch (_) {}
    window.postMessage(
      { type: "__LBCH_CAPTURED__", url: url, headers: allHeaders, bodyPreview: bodyPreview || null },
      location.origin,
    );
  }

  // ── Intercept window.fetch ──────────────────

  var _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = "";
    var allHeaders = {};

    if (input instanceof Request) {
      url = input.url;
      allHeaders = headersToObject(input.headers);
      if (init && init.headers) {
        const extra = headersToObject(init.headers);
        Object.keys(extra).forEach(function (k) {
          allHeaders[k] = extra[k];
        });
      }
    } else {
      url = typeof input === "string" ? input : "";
      if (init && init.headers) allHeaders = headersToObject(init.headers);
    }

    if (isRealLbcApi(url)) {
      // Try to get body preview (only if string, don't consume stream)
      let bodyPreview = null;
      if (init && typeof init.body === "string") {
        try {
          bodyPreview = init.body.slice(0, 200);
        } catch (_) {}
      }
      postCapture(url, allHeaders, bodyPreview);
    }

    return _origFetch(input, init);
  };

  // ── Intercept XMLHttpRequest ────────────────

  var _origXHROpen = XMLHttpRequest.prototype.open;
  var _origXHRSetRH = XMLHttpRequest.prototype.setRequestHeader;
  var _origXHRSend = XMLHttpRequest.prototype.send;
  var _xhrData = new WeakMap();

  XMLHttpRequest.prototype.open = function (_method, url) {
    _xhrData.set(this, { url: String(url || ""), headers: {} });
    return _origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    var d = _xhrData.get(this);
    if (d) d.headers[name] = value;
    return _origXHRSetRH.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var d = _xhrData.get(this);
    if (d && isRealLbcApi(d.url)) {
      const bp = typeof body === "string" ? body.slice(0, 200) : null;
      postCapture(d.url, d.headers, bp);
    }
    return _origXHRSend.apply(this, arguments);
  };
})();
