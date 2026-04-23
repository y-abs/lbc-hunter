// ─────────────────────────────────────────────
//  LbC Hunter — Options Page Script
// ─────────────────────────────────────────────

import { CATEGORIES } from "@/shared/constants.js";
import { MSG } from "@/shared/messages.js";
import {
  getWatchlists,
  saveWatchlist,
  deleteWatchlist,
  getTemplates,
  saveTemplate,
  deleteTemplate,
  getBlacklist,
  removeFromBlacklist,
  getStorageEstimate,
  exportAllData,
  importAllData,
  dbClear,
  dbGet,
  getPriceHistory,
} from "@/db/indexeddb.js";
import { STORES } from "@/db/schema.js";
import { formatPrice, adUrl, warn, escapeHtml } from "@/shared/utils.js";
import { buildReport, openMailto, sendViaEmailJS } from "@/core/reporter.js";

// ── Helpers ───────────────────────────────────

/** Format poll_interval_seconds as a human-readable string (e.g. "30s", "15 min") */
function fmtInterval(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${s / 60} min`;
  return `${s / 3600}h`;
}

// ── Tab navigation ────────────────────────────

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.add("hidden");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    const panel = document.getElementById("tab-" + btn.dataset.tab);
    if (panel) panel.classList.remove("hidden");
    if (btn.dataset.tab === "watchlists") renderWatchlists();
    if (btn.dataset.tab === "templates") renderTemplates();
    if (btn.dataset.tab === "stats") initStats();
    if (btn.dataset.tab === "blacklist") renderBlacklist();
    if (btn.dataset.tab === "settings") initSettings();
    if (btn.dataset.tab === "fullauto") initFullAuto();
  });
});

// ── Toast ─────────────────────────────────────

function showToast(msg, type = "success", durationMs = 3000) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = `toast toast--${type}`;
  setTimeout(() => toast.classList.add("hidden"), durationMs);
}

// ── Confirm modal ─────────────────────────────

function confirm(text) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("confirm-modal");
    document.getElementById("confirm-text").textContent = text;
    overlay.classList.remove("hidden");
    const ok = document.getElementById("confirm-ok");
    const cancel = document.getElementById("confirm-cancel");
    const cleanup = (val) => {
      overlay.classList.add("hidden");
      ok.onclick = null;
      cancel.onclick = null;
      resolve(val);
    };
    ok.onclick = () => cleanup(true);
    cancel.onclick = () => cleanup(false);
  });
}

// ─────────────────────────────────────────────
// WATCHLISTS TAB
// ─────────────────────────────────────────────

let _editingWlId = null;
let editingWl = null; // full original record — preserves runtime fields on save

async function renderWatchlists() {
  const watchlists = await getWatchlists();
  const container = document.getElementById("watchlist-cards");
  container.innerHTML = "";

  if (!watchlists.length) {
    container.innerHTML =
      '<div class="empty-state">Aucune recherche configurée. Cliquez sur "+ Nouvelle recherche" pour commencer.</div>';
    return;
  }

  for (const wl of watchlists) {
    const card = document.createElement("div");
    card.className = "wl-card";

    // Backfill status line — mirrors the popup-card indicator so users see
    // the same seed telemetry on both surfaces.
    let backfillLine = "";
    if (wl.pending_backfill_days > 0) {
      backfillLine = `<div class="wl-card__backfill wl-card__backfill--pending">📋 Chargement historique ${wl.pending_backfill_days} derniers jours… (en cours)</div>`;
    } else if (wl.last_backfill_at && wl.last_backfill_count != null) {
      const rel = new Date(wl.last_backfill_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
      const dur = wl.last_backfill_duration ? ` en ${Math.round(wl.last_backfill_duration / 100) / 10}s` : "";
      backfillLine = `<div class="wl-card__backfill">📋 Dernier seed: ${wl.last_backfill_count} annonces sur ${wl.last_backfill_days ?? "?"}j${dur} · ${rel}</div>`;
    }

    // Poll error line — shown when consecutive failures indicate a persistent blockage
    let pollErrorLine = "";
    const failures = wl.consecutive_poll_failures ?? 0;
    if (wl.enabled && failures >= 5) {
      const since = wl.last_successful_poll_at
        ? new Date(wl.last_successful_poll_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
        : "jamais";
      const errMsg = wl.last_poll_error?.message || "erreur inconnue";
      const plural = failures > 1 ? "s" : "";
      pollErrorLine = `<div class="wl-card__backfill wl-card__backfill--pending">⚠ ${failures} échec${plural} consécutif${plural} · dernier succès: ${since} · ${esc(errMsg)}</div>`;
    }

    card.innerHTML = `
      <label class="toggle-label">
        <input type="checkbox" ${wl.enabled ? "checked" : ""} data-id="${wl.id}">
        <span class="toggle-slider"></span>
      </label>
      <div class="wl-card__info">
        <div class="wl-card__name">${esc(wl.name)}</div>
        <div class="wl-card__meta">
          ${esc(wl.keywords)}
          ${wl.category_id ? " · " + (CATEGORIES[wl.category_id] || wl.category_id) : ""}
          ${wl.price_min || wl.price_max ? ` · ${wl.price_min || 0}–${wl.price_max || "∞"}€` : ""}
          · toutes les ${fmtInterval(wl.poll_interval_seconds || 60)}
        </div>
        ${backfillLine}
        ${pollErrorLine}
      </div>
      <span class="enabled-badge ${wl.enabled ? "" : "enabled-badge--off"}">${wl.enabled ? "Actif" : "Inactif"}</span>
      <div class="wl-card__actions">
        <button class="btn btn--ghost" data-edit="${wl.id}">Modifier</button>
        <button class="btn btn--ghost" data-poll="${wl.id}" title="Forcer le polling">▶ Tester</button>
        <button class="btn btn--danger" data-delete="${wl.id}">Supprimer</button>
      </div>
    `;

    card.querySelector('input[type="checkbox"]').addEventListener("change", async (e) => {
      // Stale-stomp guard: `wl` is captured in closure at render time. Between
      // render and this click, the poller may have landed a new
      // `last_polled_at` / `last_seen_ad_id` / cleared `pending_backfill_days`.
      // Spreading the old snapshot would revert those fields and either
      // re-trigger a full backfill OR fire a 35-ad alert storm (stale
      // last_seen_ad_id). Re-read the record before merging.
      const latest = await dbGet(STORES.WATCHLISTS, wl.id).catch(() => null);
      if (!latest) {
        renderWatchlists();
        return;
      } // deleted in another tab
      await saveWatchlist({ ...latest, enabled: e.target.checked });
      renderWatchlists();
    });
    card.querySelector("[data-edit]").addEventListener("click", () => openWlForm(wl));
    card.querySelector("[data-poll]").addEventListener("click", () => forcePoll(wl.id));
    card.querySelector("[data-delete]").addEventListener("click", async () => {
      if (await confirm(`Supprimer la recherche "${wl.name}" ?`)) {
        await deleteWatchlist(wl.id);
        renderWatchlists();
        showToast("Recherche supprimée");
      }
    });

    container.appendChild(card);
  }
}

async function openWlForm(wl = null) {
  _editingWlId = wl?.id ?? null;
  editingWl = wl ?? null;
  document.getElementById("watchlist-form-title").textContent = wl ? "Modifier la recherche" : "Nouvelle recherche";
  document.getElementById("watchlist-form-panel").classList.remove("hidden");

  // Populate category dropdown
  const catSel = document.getElementById("wl-category");
  catSel.innerHTML = '<option value="">Toutes catégories</option>';
  for (const [id, name] of Object.entries(CATEGORIES)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    catSel.appendChild(opt);
  }

  // Prefill template dropdown
  await populateTemplateDropdown(wl?.auto_message_template_id ?? null);

  // Populate form
  document.getElementById("wl-id").value = wl?.id ?? "";
  document.getElementById("wl-name").value = wl?.name ?? "";
  document.getElementById("wl-keywords").value = wl?.keywords ?? "";
  document.getElementById("wl-category").value = wl?.category_id ?? "";
  document.getElementById("wl-seller-type").value = wl?.seller_type ?? "all";
  document.getElementById("wl-price-min").value = wl?.price_min ?? "";
  document.getElementById("wl-price-max").value = wl?.price_max ?? "";
  document.getElementById("wl-zip").value = wl?.location_zip ?? "";
  document.getElementById("wl-lat").value = wl?.location_lat ?? "";
  document.getElementById("wl-lng").value = wl?.location_lng ?? "";
  document.getElementById("wl-geo-hint").textContent = wl?.location_lat ? `📍 ${wl.location_zip} géocodé` : "";
  document.getElementById("wl-radius").value = wl?.location_radius_km ?? 0;
  document.getElementById("wl-interval").value = wl?.poll_interval_seconds ?? 60;
  document.getElementById("wl-threshold").value = wl?.undermarket_threshold_pct ?? 15;
  document.getElementById("wl-threshold-num").value = wl?.undermarket_threshold_pct ?? 15;
  document.getElementById("wl-auto-tab").checked = wl?.auto_open_tab ?? false;
  document.getElementById("wl-auto-msg").checked = wl?.auto_message_enabled ?? false;
  // Shipping filter
  const shippingVal = wl?.shipping_filter ?? "any";
  document.querySelector(`[name="wl-shipping"][value="${shippingVal}"]`).checked = true;
  // Purchase mode
  // Normalize `full` → `off` on load. Full-auto is advertised in the enum but
  // NOT wired into the poll cycle (poller.js handles `auto_open_tab` and
  // `auto_message_enabled` but never invokes `attemptCheckout(..., 'full', ...)`).
  // A user who previously saved `full` expected automated purchasing; leaving
  // the value in place silently misleads them into thinking it still fires.
  // We reset to `off` so the dropdown reflects reality; the `<option value="full">`
  // is also `disabled` in the HTML so it can't be re-selected accidentally.
  const storedPurchaseMode = wl?.purchase_mode ?? "off";
  document.getElementById("wl-purchase-mode").value = storedPurchaseMode === "full" ? "off" : storedPurchaseMode;
  document.getElementById("wl-budget-max").value = wl?.purchase_budget_max ?? 500;
  document.getElementById("wl-backfill").value = wl?.backfill_days ?? 0;
  // Backfill fieldset stays visible on edits so users can (re)seed history
  // for existing watchlists. The form uses `pending_backfill_days` to
  // schedule a seed on the next poll without nuking `last_seen_ad_id`.
  // Relabel the hint depending on the context.
  const backfillHint = document.getElementById("wl-backfill-hint");
  if (backfillHint) {
    backfillHint.textContent = wl?.id ? "(applique un nouveau seed au prochain poll)" : "(uniquement à la création)";
  }
  document.getElementById("wl-require-market").checked = wl?.require_market_data !== false;
  toggleBudgetField();
  updateRangeLabels();
  toggleMsgSelect();
  document.getElementById("watchlist-form-panel").scrollIntoView({ behavior: "smooth" });
}

function updateRangeLabels() {
  const radius = document.getElementById("wl-radius").value;
  const threshold = document.getElementById("wl-threshold").value;
  document.getElementById("wl-radius-val").textContent = radius === 0 ? "0 = national" : `${radius} km`;
  document.getElementById("wl-threshold-val").textContent = threshold;
  document.getElementById("wl-threshold-num").value = threshold;
}

// Keep range slider and number input in sync
document.getElementById("wl-threshold-num").addEventListener("input", () => {
  const v = Math.max(0, Math.min(50, Number(document.getElementById("wl-threshold-num").value) || 0));
  document.getElementById("wl-threshold").value = v;
  document.getElementById("wl-threshold-val").textContent = v;
});

function toggleMsgSelect() {
  const checked = document.getElementById("wl-auto-msg").checked;
  document.getElementById("wl-template-select-wrap").classList.toggle("hidden", !checked);
}

function toggleBudgetField() {
  const mode = document.getElementById("wl-purchase-mode").value;
  document.getElementById("wl-budget-wrap").classList.toggle("hidden", mode === "off");
}

async function populateTemplateDropdown(selectedId = null) {
  const templates = await getTemplates();
  const sel = document.getElementById("wl-template-select");
  sel.innerHTML = "";
  for (const tpl of templates) {
    const opt = document.createElement("option");
    opt.value = tpl.id;
    opt.textContent = tpl.name;
    sel.appendChild(opt);
  }
  if (selectedId) sel.value = selectedId;
}

// Auto-geocode ZIP → lat/lng using French government open geo API (no key needed)
document.getElementById("wl-zip").addEventListener("blur", async () => {
  const zip = document.getElementById("wl-zip").value.trim();
  document.getElementById("wl-geo-hint").textContent = "";
  if (!zip || zip.length < 5) return;
  try {
    const r = await fetch(
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(zip)}&type=municipality&limit=1`,
    );
    const data = await r.json();
    const feat = data.features?.[0];
    if (feat) {
      const [lng, lat] = feat.geometry.coordinates;
      document.getElementById("wl-lat").value = lat;
      document.getElementById("wl-lng").value = lng;
      const city = feat.properties.city || feat.properties.label || zip;
      document.getElementById("wl-geo-hint").textContent = `📍 ${city} (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
    } else {
      document.getElementById("wl-geo-hint").textContent = "⚠️ Code postal non reconnu";
    }
  } catch {
    document.getElementById("wl-geo-hint").textContent = "⚠️ Géocodage impossible (réseau?)";
  }
});

document.getElementById("wl-radius").addEventListener("input", updateRangeLabels);
document.getElementById("wl-threshold").addEventListener("input", updateRangeLabels);
document.getElementById("wl-auto-msg").addEventListener("change", toggleMsgSelect);
document.getElementById("wl-purchase-mode").addEventListener("change", toggleBudgetField);

document.getElementById("btn-new-watchlist").addEventListener("click", () => openWlForm());
document.getElementById("btn-cancel-watchlist").addEventListener("click", () => {
  document.getElementById("watchlist-form-panel").classList.add("hidden");
});

document.getElementById("watchlist-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  // Detect a fundamental search change on edit. When the user mutates
  // `keywords` or `category_id`, the old `last_seen_ad_id` references an ad
  // that does NOT exist in the new result set; the poller's dedup slice
  // (`findIndex(... === last_seen_ad_id)`) returns -1, so `candidates =
  // sortedAds` (every result) and every ad that's missing from IDB fires a
  // fresh alert. Net effect: up to 35 alerts erupt in one poll cycle the
  // first time a user refines a watchlist. We reset the dedup anchor AND
  // stamp `last_polled_at=0` so the poller re-runs the first-poll-skip
  // baseline seeding (no alert storm, rich backfill if configured).
  const newKeywords = document.getElementById("wl-keywords").value.trim();
  const newCategoryId = document.getElementById("wl-category").value || null;
  const searchChanged =
    !!editingWl && ((editingWl.keywords ?? "") !== newKeywords || (editingWl.category_id ?? null) !== newCategoryId);

  // Stale-stomp guard: `editingWl` was snapshotted at openWlForm() time. A
  // poll cycle (especially a backfill running ~28s) may complete between
  // opening the form and submitting it, writing new `last_polled_at` /
  // `last_seen_ad_id` / clearing `pending_backfill_days`. Re-read before
  // merging so the form edit doesn't revert those runtime fields. For
  // `searchChanged` we intentionally NULL last_seen_ad_id below, so the
  // post-write difference is OK — we want the dedup anchor reset.
  const latestEditing = editingWl?.id
    ? ((await dbGet(STORES.WATCHLISTS, editingWl.id).catch(() => null)) ?? editingWl)
    : null;

  const wl = {
    // Preserve runtime fields from the LATEST IDB record (not the stale
    // openWlForm() snapshot) so IDB put() doesn't erase them. See
    // `latestEditing` above — falls back to `editingWl` if the read fails.
    ...(latestEditing ?? editingWl ?? {}),
    id: document.getElementById("wl-id").value || undefined,
    name: document.getElementById("wl-name").value.trim(),
    keywords: newKeywords,
    category_id: newCategoryId,
    seller_type: document.getElementById("wl-seller-type").value,
    price_min: Number(document.getElementById("wl-price-min").value) || null,
    price_max: Number(document.getElementById("wl-price-max").value) || null,
    location_zip: document.getElementById("wl-zip").value || null,
    location_lat: Number(document.getElementById("wl-lat").value) || null,
    location_lng: Number(document.getElementById("wl-lng").value) || null,
    location_radius_km: Number(document.getElementById("wl-radius").value),
    poll_interval_seconds: Number(document.getElementById("wl-interval").value),
    undermarket_threshold_pct: Number(document.getElementById("wl-threshold").value),
    auto_open_tab: document.getElementById("wl-auto-tab").checked,
    auto_message_enabled: document.getElementById("wl-auto-msg").checked,
    auto_message_template_id: document.getElementById("wl-template-select").value || null,
    shipping_filter: document.querySelector('[name="wl-shipping"]:checked')?.value ?? "any",
    purchase_mode: document.getElementById("wl-purchase-mode").value,
    purchase_budget_max: Number(document.getElementById("wl-budget-max").value) || 500,
    backfill_days: Number(document.getElementById("wl-backfill").value) || 0,
    require_market_data: document.getElementById("wl-require-market").checked,
    // PRESERVE enabled state across edits. An earlier `enabled: true` hardcode
    // here silently re-enabled any paused watchlist whenever the user opened
    // the form to tweak a filter: spreading `editingWl` carried
    // `enabled:false` into `wl`, then the hardcode overwrote it back to true
    // and `saveWatchlist` persisted the flipped value.
    //
    // Second-order bug (46-A): reading `editingWl.enabled` instead of
    // `latestEditing.enabled` reintroduced the regression through a different
    // path. `editingWl` is snapshotted at `openWlForm()` time; if the user
    // paused the watchlist from the popup toggle or options card toggle WHILE
    // the edit form was open, `editingWl.enabled === true` is stale. The
    // override below then re-enabled the watchlist on submit, silently
    // resuming polling against the user's explicit pause.
    //
    // Fix: consult `latestEditing` (the live IDB re-read) first, fall through
    // to `editingWl` only if the re-read failed, and default to `true` for new
    // watchlists. Also — since the spread above already places the live
    // `enabled` value at the start of `wl`, this explicit key exists only to
    // guard the new-watchlist path; the spread already preserves state on
    // edit, but keeping the explicit key documents intent.
    enabled: latestEditing ? latestEditing.enabled !== false : editingWl ? editingWl.enabled !== false : true,
  };

  // Apply the search-changed reset AFTER the spread so it overrides the
  // preserved runtime fields. Null (not undefined) because dbPut persists
  // the field and the poller reads `!watchlist.last_seen_ad_id` for the
  // first-poll check — null is falsy; undefined would be stripped and
  // semantically noisy.
  if (searchChanged) {
    wl.last_seen_ad_id = null;
    wl.last_polled_at = 0;
  }

  // Re-backfill for existing watchlists. On CREATION, `backfill_days` is
  // consumed once by the first-poll branch in poller.js. On EDIT, re-setting
  // `backfill_days` alone wouldn't re-trigger the seed (the poller's gate is
  // `isFirstPoll`, which only flips back to true via `searchChanged`). We
  // schedule a one-shot re-seed by writing `pending_backfill_days` — the
  // poller picks it up on the next poll, runs the multi-page branch, and
  // clears the flag. This preserves existing `last_seen_ad_id` so live
  // incremental dedup keeps working after the seed completes.
  const requestedBackfill = Number(document.getElementById("wl-backfill").value) || 0;
  // Set pending_backfill_days for BOTH new and existing watchlists when backfill is
  // requested AND the search wasn't changed (searchChanged resets last_seen_ad_id and
  // lets the first-poll branch handle it). This ensures the badge shows immediately
  // on first save (previously it only appeared after saving a second time, because
  // the condition excluded new watchlists where editingWl?.id is falsy).
  if (requestedBackfill > 0 && !searchChanged) {
    wl.pending_backfill_days = requestedBackfill;
  }

  await saveWatchlist(wl); // mutates wl.id in-place if new watchlist

  // Immediately trigger a poll instead of waiting for the next alarm (up to 30s).
  // This covers three cases:
  //   1. New watchlist — runs the first-poll baseline + backfill right away.
  //   2. Search changed — re-seeds with the new query immediately.
  //   3. Re-backfill requested — pending_backfill_days fires without the delay.
  // wl.id is guaranteed to be set at this point (saveWatchlist generates it).
  const shouldPollNow = !editingWl?.id || searchChanged || (wl.pending_backfill_days ?? 0) > 0 || requestedBackfill > 0;
  if (shouldPollNow) {
    chrome.runtime.sendMessage({ type: MSG.FORCE_POLL, watchlistId: wl.id }).catch(() => {});
  }

  document.getElementById("watchlist-form-panel").classList.add("hidden");
  showToast(
    (wl.pending_backfill_days ?? 0) > 0
      ? `Chargement de l'historique (${wl.pending_backfill_days} jours) lancé ✓`
      : "Recherche enregistrée ✓",
  );
  renderWatchlists();
});

async function forcePoll(watchlistId) {
  const btn = document.querySelector(`[data-poll="${watchlistId}"]`);
  if (btn) btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: MSG.FORCE_POLL, watchlistId });
    showToast("Polling lancé ✓");
  } catch {
    showToast("Erreur lors du polling", "error");
  }
  if (btn) btn.disabled = false;
}

// ─────────────────────────────────────────────
// TEMPLATES TAB
// ─────────────────────────────────────────────

async function renderTemplates() {
  const list = document.getElementById("template-list");
  list.innerHTML = "";
  const templates = await getTemplates();

  if (!templates.length) {
    list.innerHTML = '<div class="empty-state">Aucun template.</div>';
    return;
  }

  for (const tpl of templates) {
    const card = document.createElement("div");
    card.className = "tpl-card";
    card.innerHTML = `
      <div class="tpl-card__info">
        <div class="tpl-card__name">${esc(tpl.name)}</div>
        <div class="wl-card__meta tpl-card__preview">${esc((tpl.body || "").replace(/\n/g, " ").slice(0, 80))}${(tpl.body || "").length > 80 ? "…" : ""}</div>
      </div>
      <div class="tpl-card__actions">
        <button class="btn btn--ghost" data-edit-tpl="${tpl.id}">Modifier</button>
        <button class="btn btn--danger" data-delete-tpl="${tpl.id}">Supprimer</button>
      </div>
    `;
    card.querySelector("[data-edit-tpl]").addEventListener("click", () => openTplForm(tpl));
    card.querySelector("[data-delete-tpl]").addEventListener("click", async () => {
      if (await confirm(`Supprimer le template "${tpl.name}" ?`)) {
        await deleteTemplate(tpl.id);
        renderTemplates();
        showToast("Template supprimé");
      }
    });
    list.appendChild(card);
  }
}

function openTplForm(tpl = null) {
  document.getElementById("template-form-title").textContent = tpl ? "Modifier le template" : "Nouveau template";
  document.getElementById("template-form-panel").classList.remove("hidden");
  document.getElementById("tpl-id").value = tpl?.id ?? "";
  document.getElementById("tpl-name").value = tpl?.name ?? "";
  document.getElementById("tpl-body").value = tpl?.body ?? "";
  document.getElementById("template-form-panel").scrollIntoView({ behavior: "smooth" });
}

document.getElementById("btn-new-template").addEventListener("click", () => openTplForm());
document.getElementById("btn-cancel-template").addEventListener("click", () => {
  document.getElementById("template-form-panel").classList.add("hidden");
});

document.getElementById("template-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveTemplate({
    id: document.getElementById("tpl-id").value || undefined,
    name: document.getElementById("tpl-name").value.trim(),
    body: document.getElementById("tpl-body").value.trim(),
  });
  document.getElementById("template-form-panel").classList.add("hidden");
  showToast("Template enregistré ✓");
  renderTemplates();
});

// ─────────────────────────────────────────────
// STATS TAB
// ─────────────────────────────────────────────

let statsChartInstance = null;

async function initStats() {
  const watchlists = await getWatchlists();
  const sel = document.getElementById("stats-keyword-select");
  sel.innerHTML = '<option value="">— Sélectionner une recherche —</option>';
  for (const wl of watchlists) {
    const opt = document.createElement("option");
    opt.value = `${wl.keywords}|||${wl.category_id || ""}`;
    opt.textContent = wl.name;
    sel.appendChild(opt);
  }
}

document.getElementById("stats-keyword-select").addEventListener("change", loadStats);
document.getElementById("stats-range-select").addEventListener("change", loadStats);

async function loadStats() {
  const val = document.getElementById("stats-keyword-select").value;
  const limit = Number(document.getElementById("stats-range-select").value);
  if (!val) return;
  const [keyword, categoryId] = val.split("|||");

  const data = await getPriceHistory(keyword, categoryId || null, limit);
  if (!data.length) {
    document.getElementById("stats-kpis").classList.add("hidden");
    return;
  }

  // getPriceHistory returns newest-first — data[0] is the most recent snapshot.
  const latest = data[0];
  document.getElementById("stats-kpis").classList.remove("hidden");
  document.getElementById("kpi-min").textContent = formatPrice(latest.min_price);
  document.getElementById("kpi-avg").textContent = formatPrice(latest.avg_price);
  document.getElementById("kpi-med").textContent = formatPrice(latest.median_price);
  document.getElementById("kpi-max").textContent = formatPrice(latest.max_price);
  document.getElementById("kpi-count").textContent = latest.sample_count;

  // Chart expects oldest-first so the x-axis reads left=old → right=new.
  drawStatsChart([...data].sort((a, b) => a.timestamp - b.timestamp));
}

async function drawStatsChart(data) {
  const { Chart } = await import("chart.js/auto");
  const canvas = document.getElementById("stats-chart");
  if (statsChartInstance) statsChartInstance.destroy();

  const labels = data.map((d) => new Date(d.timestamp).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }));

  statsChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Médiane",
          data: data.map((d) => d.median_price),
          borderColor: "#FF6B35",
          fill: false,
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: "Moyenne",
          data: data.map((d) => d.avg_price),
          borderColor: "#FFC300",
          fill: false,
          tension: 0.3,
          pointRadius: 2,
          borderDash: [4, 2],
        },
        {
          label: "Min",
          data: data.map((d) => d.min_price),
          borderColor: "#2a9d4e",
          fill: false,
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: "Max",
          data: data.map((d) => d.max_price),
          borderColor: "#E63946",
          fill: false,
          tension: 0.3,
          pointRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { ticks: { color: "#8b949e", maxTicksLimit: 12 }, grid: { color: "#21262d" } },
        y: { ticks: { color: "#8b949e", callback: (v) => formatPrice(v) }, grid: { color: "#21262d" } },
      },
      plugins: { legend: { labels: { color: "#e6edf3", font: { size: 11 } } } },
    },
  });
}

// ─────────────────────────────────────────────
// BLACKLIST TAB
// ─────────────────────────────────────────────

async function renderBlacklist() {
  const list = await getBlacklist();
  const tbody = document.getElementById("blacklist-tbody");
  const empty = document.getElementById("blacklist-empty");
  tbody.innerHTML = "";

  if (!list.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const entry of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${esc(entry.seller_id)}</code></td>
      <td>${esc(entry.reason || "—")}</td>
      <td>${new Date(entry.added_at).toLocaleDateString("fr-FR")}</td>
      <td><button class="btn btn--ghost" data-unblock="${esc(entry.seller_id)}">Débloquer</button></td>
    `;
    tr.querySelector("[data-unblock]").addEventListener("click", async (e) => {
      await removeFromBlacklist(e.target.dataset.unblock);
      renderBlacklist();
      showToast("Vendeur débloqué");
    });
    tbody.appendChild(tr);
  }
}

// ─────────────────────────────────────────────
// SETTINGS TAB
// ─────────────────────────────────────────────

async function initSettings() {
  const stored = await chrome.storage.local.get([
    "sound_pref",
    "max_msgs_hour",
    "max_msgs_day",
    "ntfy_topic",
    "ntfy_server",
    "ntfy_threshold",
    "email_report_addr",
    "email_report_hour",
    "email_report_mode",
    "email_report_enabled",
    "emailjs_service",
    "emailjs_template",
    "emailjs_user",
  ]);

  document.getElementById("setting-sound").value = stored.sound_pref ?? "both";
  document.getElementById("setting-msg-hour").value = stored.max_msgs_hour ?? 15;
  document.getElementById("setting-msg-day").value = stored.max_msgs_day ?? 50;

  document.getElementById("ntfy-topic").value = stored.ntfy_topic ?? "";
  document.getElementById("ntfy-server").value = stored.ntfy_server ?? "";
  document.getElementById("ntfy-threshold").value = stored.ntfy_threshold ?? "red";

  document.getElementById("email-report-addr").value = stored.email_report_addr ?? "";
  document.getElementById("email-report-hour").value = stored.email_report_hour ?? 8;
  document.getElementById("email-report-mode").value = stored.email_report_mode ?? "mailto";
  document.getElementById("email-report-enabled").checked = stored.email_report_enabled ?? false;
  document.getElementById("emailjs-service").value = stored.emailjs_service ?? "";
  document.getElementById("emailjs-template").value = stored.emailjs_template ?? "";
  document.getElementById("emailjs-user").value = stored.emailjs_user ?? "";

  toggleEmailJsConfig();

  const estimate = await getStorageEstimate();
  if (estimate) {
    const usedMb = (estimate.usage / 1024 / 1024).toFixed(1);
    const quotaMb = (estimate.quota / 1024 / 1024).toFixed(0);
    document.getElementById("storage-info").textContent = `Stockage utilisé: ${usedMb} Mo / ${quotaMb} Mo`;
  }
}

function toggleEmailJsConfig() {
  const mode = document.getElementById("email-report-mode").value;
  document.getElementById("emailjs-config").classList.toggle("hidden", mode !== "emailjs");
}
document.getElementById("email-report-mode").addEventListener("change", toggleEmailJsConfig);

// ─────────────────────────────────────────────
// FULL AUTO TAB
// ─────────────────────────────────────────────

async function initFullAuto() {
  const stored = await chrome.storage.local.get([
    "contact_name",
    "contact_phone",
    "contact_address",
    "contact_city",
    "contact_zip",
  ]);
  document.getElementById("contact-name-fa").value = stored.contact_name ?? "";
  document.getElementById("contact-phone-fa").value = stored.contact_phone ?? "";
  document.getElementById("contact-address-fa").value = stored.contact_address ?? "";
  document.getElementById("contact-city-fa").value = stored.contact_city ?? "";
  document.getElementById("contact-zip-fa").value = stored.contact_zip ?? "";

  // Sync full-auto toggle — mirror the module-load init (line ~789) AND the
  // SW default (`fullAutoPaused = true`, service-worker.js line 18). When
  // session storage has no entry (fresh install, browser restart that wipes
  // session storage, or reset-all-data), treat the flag as paused so the
  // checkbox shows OFF. The previous `!== true` test defaulted undefined to
  // checked=true (ACTIVE), contradicting both the SW in-memory default and
  // the other tab-opening init — the user saw Full-Auto shown as ON in the
  // options tab while the SW kill-switch was actually asserted, so any red-
  // tier auto-buy silently no-op'd with no UI feedback.
  const { full_auto_paused } = await chrome.storage.session.get("full_auto_paused");
  document.getElementById("toggle-full-auto").checked = full_auto_paused === false;
}

document.getElementById("btn-save-settings").addEventListener("click", async () => {
  await chrome.storage.local.set({
    sound_pref: document.getElementById("setting-sound").value,
    max_msgs_hour: Number(document.getElementById("setting-msg-hour").value),
    max_msgs_day: Number(document.getElementById("setting-msg-day").value),
    ntfy_topic: document.getElementById("ntfy-topic").value.trim(),
    ntfy_server: document.getElementById("ntfy-server").value.trim(),
    ntfy_threshold: document.getElementById("ntfy-threshold").value,
    email_report_addr: document.getElementById("email-report-addr").value.trim(),
    email_report_hour: Number(document.getElementById("email-report-hour").value),
    email_report_mode: document.getElementById("email-report-mode").value,
    email_report_enabled: document.getElementById("email-report-enabled").checked,
    emailjs_service: document.getElementById("emailjs-service").value.trim(),
    emailjs_template: document.getElementById("emailjs-template").value.trim(),
    emailjs_user: document.getElementById("emailjs-user").value.trim(),
  });
  showToast("Paramètres enregistrés ✓");
});

// ── ntfy save button ──
document.getElementById("btn-save-ntfy").addEventListener("click", async () => {
  await chrome.storage.local.set({
    ntfy_topic: document.getElementById("ntfy-topic").value.trim(),
    ntfy_server: document.getElementById("ntfy-server").value.trim(),
    ntfy_threshold: document.getElementById("ntfy-threshold").value,
  });
  showToast("Paramètres ntfy enregistrés ✓");
});

// ── ntfy test button ──
document.getElementById("btn-test-ntfy").addEventListener("click", async () => {
  // Auto-save before test so what the user typed is what gets used
  await chrome.storage.local.set({
    ntfy_topic: document.getElementById("ntfy-topic").value.trim(),
    ntfy_server: document.getElementById("ntfy-server").value.trim(),
    ntfy_threshold: document.getElementById("ntfy-threshold").value,
  });
  const stored = await chrome.storage.local.get(["ntfy_topic", "ntfy_server"]);
  const topic = document.getElementById("ntfy-topic").value.trim() || stored.ntfy_topic;
  if (!topic) {
    showToast("Entrez un topic ntfy.sh", "error");
    return;
  }
  const server = (
    document.getElementById("ntfy-server").value.trim() ||
    stored.ntfy_server ||
    "https://ntfy.sh"
  ).replace(/\/$/, "");
  const fakeAdId = "3050656422";
  try {
    // Mirror the exact payload used by sendNtfyNotification() for a real red-tier alert.
    // Pass 49-A: POST to the server ROOT (`${server}/`), NOT `${server}/${topic}`.
    // ntfy's JSON-publish endpoint is the root — posting JSON to the topic path
    // makes ntfy treat the whole JSON blob as the plain-text message body, so
    // the user's phone receives raw `{"topic":"...","title":"..."}` instead of
    // the formatted push. This is the same fix already applied in notifier.js;
    // the test button diverged and silently reproduced the bug in isolation.
    const r = await fetch(`${server}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title: "🔴 World of Warcraft Vanilla Collector Edition — 180€ (−35%)",
        message:
          "WoW Classic Vanilla Collector (boîte + manuel + CDs, FR) · Lyon (69003) · Recherche « WoW Vanilla Collector »",
        priority: 5,
        tags: ["warning", "moneybag"],
        click: adUrl(fakeAdId),
        actions: [{ action: "view", label: "Voir annonce", url: adUrl(fakeAdId), clear: true }],
      }),
    });
    if (r.ok) showToast("Notification test envoyée ✓");
    else showToast(`Erreur ntfy: ${r.status}`, "error");
  } catch (e) {
    showToast("Erreur réseau: " + e.message, "error");
  }
});

// ── Send report now button ──
document.getElementById("btn-send-report-now").addEventListener("click", async () => {
  const addr = document.getElementById("email-report-addr").value.trim();
  if (!addr) {
    showToast("Entrez une adresse email", "error");
    return;
  }
  const to = Date.now();
  const from = to - 7 * 86400_000;
  try {
    const report = await buildReport({ from, to, watchlistIds: [] });
    const mode = document.getElementById("email-report-mode").value;
    if (mode === "emailjs") {
      const config = {
        service_id: document.getElementById("emailjs-service").value.trim(),
        template_id: document.getElementById("emailjs-template").value.trim(),
        user_id: document.getElementById("emailjs-user").value.trim(),
        email: addr,
      };
      await sendViaEmailJS(config, report);
      showToast("Rapport envoyé via EmailJS ✓");
    } else {
      openMailto(addr, report);
      showToast("Client email ouvert ✓");
    }
  } catch (e) {
    showToast("Erreur: " + e.message, "error");
  }
});

// ── Save contact info (Full Auto tab) ──
document.getElementById("btn-save-contact-fa").addEventListener("click", async () => {
  await chrome.storage.local.set({
    contact_name: document.getElementById("contact-name-fa").value.trim(),
    contact_phone: document.getElementById("contact-phone-fa").value.trim(),
    contact_address: document.getElementById("contact-address-fa").value.trim(),
    contact_city: document.getElementById("contact-city-fa").value.trim(),
    contact_zip: document.getElementById("contact-zip-fa").value.trim(),
  });
  showToast("Infos contact enregistrées ✓");
});

// ── GENERATE_REPORT message from service worker ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // POLL_STATUS live refresh — the watchlists card shows per-row backfill
  // telemetry (`last_backfill_*`) read from IDB on each `renderWatchlists()`
  // call. A running backfill writes those fields only at the end of the
  // poll; without listening for the SW broadcast, the user has to manually
  // switch tabs to see the "last seed" line appear. Refresh the watchlists
  // panel on both start and done so the pending/running → done transition
  // is reflected without a page reload. `renderWatchlists()` is a blind
  // IDB re-read — cheap and idempotent. No response is required; return
  // `false` so Chrome closes the message port immediately.
  if (msg?.type === MSG.POLL_STATUS) {
    const panel = document.getElementById("tab-watchlists");
    if (panel && !panel.classList.contains("hidden")) {
      renderWatchlists().catch(() => {});
    }
    if (msg.phase === "backfill_error") {
      const label =
        msg.reason === "no_tab"
          ? `⚠ Historique en attente: aucun onglet LBC ouvert (réessai auto)`
          : msg.reason === "page_failed"
            ? `⚠ Chargement partiel: ${msg.count ?? 0} annonces · erreur réseau · réessai auto`
            : `⚠ Erreur historique: ${msg.message || msg.reason || "erreur inconnue"} — réessai auto`;
      showToast(label, "error", 6000);
    }
    return false;
  }
  if (msg.type !== MSG.GENERATE_REPORT) return false;
  const { from, to, watchlistIds, email } = msg;
  buildReport({ from, to, watchlistIds: watchlistIds || [] })
    .then(async (report) => {
      const stored = await chrome.storage.local.get([
        "email_report_mode",
        "emailjs_service",
        "emailjs_template",
        "emailjs_user",
      ]);
      if (stored.email_report_mode === "emailjs" && stored.emailjs_service) {
        await sendViaEmailJS(
          {
            service_id: stored.emailjs_service,
            template_id: stored.emailjs_template,
            user_id: stored.emailjs_user,
            email,
          },
          report,
        ).catch(() => openMailto(email, report));
      } else {
        openMailto(email, report);
      }
      sendResponse({ ok: true });
    })
    .catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // async response
});

// Export
document.getElementById("btn-export").addEventListener("click", async () => {
  const data = await exportAllData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `lbc-hunter-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Export téléchargé ✓");
});

// Import
document.getElementById("btn-import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await importAllData(data);
    showToast("Import réussi ✓");
  } catch (err) {
    showToast("Erreur lors de l'import: " + err.message, "error");
  }
  e.target.value = "";
});

// Reset
document.getElementById("btn-reset").addEventListener("click", async () => {
  if (!(await confirm("Supprimer TOUTES les données ? Cette action est irréversible."))) return;
  for (const store of Object.values(STORES)) {
    try {
      await dbClear(store);
    } catch {}
  }
  // Also wipe chrome.storage — the reset advertises "TOUTES les données"
  // and users expect PII (contact info, email/EmailJS credentials, ntfy topic)
  // to disappear along with ads/watchlists.
  try {
    await chrome.storage.local.clear();
  } catch {}
  try {
    await chrome.storage.session.clear();
  } catch {}
  showToast("Données réinitialisées");
});

// ── Full Auto global killswitch ────────────────
const toggleFullAutoOpts = document.getElementById("toggle-full-auto");
if (toggleFullAutoOpts) {
  chrome.storage.session.get("full_auto_paused").then(({ full_auto_paused }) => {
    toggleFullAutoOpts.checked = full_auto_paused === false;
  });
  toggleFullAutoOpts.addEventListener("change", () => {
    const enabled = toggleFullAutoOpts.checked;
    chrome.storage.session.set({ full_auto_paused: !enabled });
    chrome.runtime.sendMessage({ type: MSG.TOGGLE_FULL_AUTO, enabled }).catch(() => {});
  });
}

// ── Util ──────────────────────────────────────

function esc(str) {
  return escapeHtml(str);
}

// ── Init ──────────────────────────────────────

renderWatchlists();

// POLL_STATUS live-refresh is handled by the combined listener above (line 786).
// The earlier standalone listener here was redundant — it caused renderWatchlists()
// to fire TWICE per POLL_STATUS event (once in the combined handler, once here).
// Removed in the double-listener audit (Pass 51).

// ── Auto-report on startup (triggered by SW when no pages were open) ──
chrome.storage.session
  .get("pending_auto_report")
  .then(async ({ pending_auto_report: p }) => {
    if (!p?.email) return;
    await chrome.storage.session.remove("pending_auto_report");
    try {
      const report = await buildReport({ from: p.from, to: p.to, watchlistIds: [] });
      const stored = await chrome.storage.local.get([
        "email_report_mode",
        "emailjs_service",
        "emailjs_template",
        "emailjs_user",
      ]);
      if (stored.email_report_mode === "emailjs" && stored.emailjs_service) {
        await sendViaEmailJS(
          {
            service_id: stored.emailjs_service,
            template_id: stored.emailjs_template,
            user_id: stored.emailjs_user,
            email: p.email,
          },
          report,
        ).catch(() => openMailto(p.email, report));
      } else {
        openMailto(p.email, report);
      }
    } catch (e) {
      warn("Auto-report generation failed:", e?.message);
    }
  })
  .catch(() => {});
