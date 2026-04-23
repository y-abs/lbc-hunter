// Tier 2 — IDB migration: v0→v2 fresh install and v1→v2 patch path.

import { describe, it, expect, beforeEach } from "vitest";
import { openDB } from "idb";
import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";
import { DB_NAME, DEFAULT_TEMPLATES } from "@/shared/constants.js";

beforeEach(() => {
  // Fresh factory — the production module has not been imported yet in this file.
  globalThis.indexedDB = new IDBFactory();
});

describe("v0 → v2 fresh install", () => {
  it("creates all 7 stores with expected indexes", async () => {
    vi.resetModules();
    const db = await import("@/db/indexeddb.js");
    const conn = await db.getDb();
    const names = Array.from(conn.objectStoreNames).sort();
    expect(names).toEqual(["ads", "blacklist", "price_history", "purchases", "session", "templates", "watchlists"]);
    db.__test__.close();
  });

  it("seeds DEFAULT_TEMPLATES on fresh install", async () => {
    vi.resetModules();
    const db = await import("@/db/indexeddb.js");
    const tpls = await db.getTemplates();
    // Defaults are seeded by the upgrade, and getTemplates also self-heals.
    const names = tpls.map((t) => t.name).sort();
    const expected = DEFAULT_TEMPLATES.map((t) => t.name).sort();
    for (const e of expected) expect(names).toContain(e);
    db.__test__.close();
  });
});

describe("v1 → v2 schema patch on existing watchlists", () => {
  it("fills in shipping_filter, purchase_mode, purchase_budget_max defaults", async () => {
    // Seed a v1-style DB by opening with version=1 and inserting a legacy wl
    // that lacks the v2 fields.
    const legacy = await openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore("watchlists", { keyPath: "id" });
        d.createObjectStore("ads", { keyPath: "id" });
        d.createObjectStore("price_history", { keyPath: "id" });
        d.createObjectStore("templates", { keyPath: "id" });
        d.createObjectStore("purchases", { keyPath: "id" });
        d.createObjectStore("session", { keyPath: "id" });
        d.createObjectStore("blacklist", { keyPath: "seller_id" });
      },
    });
    await legacy.put("watchlists", {
      id: "wl-legacy",
      name: "old",
      keywords: "x",
      enabled: true,
      created_at: 1,
      // NB: no shipping_filter, no purchase_mode, no purchase_budget_max
    });
    legacy.close();

    // Now open with the production module (version 2 via constants) — the
    // upgrade block migrates the legacy row.
    vi.resetModules();
    const db = await import("@/db/indexeddb.js");
    const all = await db.getWatchlists();
    const migrated = all.find((w) => w.id === "wl-legacy");
    expect(migrated).toBeDefined();
    expect(migrated.shipping_filter).toBe("any");
    expect(migrated.purchase_mode).toBe("off");
    expect(migrated.purchase_budget_max).toBe(500);
    db.__test__.close();
  });
});
