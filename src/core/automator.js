// ─────────────────────────────────────────────
//  LbC Hunter — Automation Engine
// ─────────────────────────────────────────────

import { MAX_MESSAGES_PER_HOUR, MAX_MESSAGES_PER_DAY } from "@/shared/constants.js";
import { getAd, getTemplates, markAdMessaged, savePurchase, getPurchasesByAdId, dbPut } from "@/db/indexeddb.js";
import { STORES } from "@/db/schema.js";
import { interpolateTemplate, log, warn, lbcAdUrl } from "@/shared/utils.js";

// ── Rate limiting via chrome.storage.local ──
// Persistent across browser restarts: session storage wipes on browser close,
// which would let users bypass message spam caps by restarting Chrome.

async function getMessageCounters() {
  const data = await chrome.storage.local.get(["msg_hour_count", "msg_hour_reset", "msg_day_count", "msg_day_reset"]);
  const now = Date.now();
  let hourCount = data.msg_hour_count ?? 0;
  let hourReset = data.msg_hour_reset ?? now + 3_600_000;
  let dayCount = data.msg_day_count ?? 0;
  let dayReset = data.msg_day_reset ?? now + 86_400_000;

  if (now > hourReset) {
    hourCount = 0;
    hourReset = now + 3_600_000;
  }
  if (now > dayReset) {
    dayCount = 0;
    dayReset = now + 86_400_000;
  }
  return { hourCount, hourReset, dayCount, dayReset };
}

async function incrementMessageCounter() {
  const c = await getMessageCounters();
  await chrome.storage.local.set({
    msg_hour_count: c.hourCount + 1,
    msg_hour_reset: c.hourReset,
    msg_day_count: c.dayCount + 1,
    msg_day_reset: c.dayReset,
  });
}

async function canSendMessage() {
  const c = await getMessageCounters();
  // Read user-configured limits from options (fall back to compile-time constants)
  const limits = await chrome.storage.local.get(["max_msgs_hour", "max_msgs_day"]);
  const maxHour = limits.max_msgs_hour ?? MAX_MESSAGES_PER_HOUR;
  const maxDay = limits.max_msgs_day ?? MAX_MESSAGES_PER_DAY;
  if (c.hourCount >= maxHour) {
    warn("Hourly message cap reached");
    return false;
  }
  if (c.dayCount >= maxDay) {
    warn("Daily message cap reached");
    return false;
  }
  return true;
}

// ── Auto-message ──────────────────────────────

export async function sendAutoMessage(ad, templateId) {
  if (!(await canSendMessage())) return false;

  // IDB records: ad.id = String(LBC list_id), ad.list_id = watchlist UUID
  // Raw API ads:  ad.id = undefined,           ad.list_id = LBC list_id (number)
  const adId = String(ad.id || ad.list_id);
  const existingAd = await getAd(adId);
  if (existingAd?.is_messaged) {
    log("Already messaged:", adId);
    return false;
  }

  const templates = await getTemplates();
  let tpl = templateId ? templates.find((t) => t.id === templateId) : templates[0];
  if (!tpl) {
    warn("No message template found");
    return false;
  }

  const price = Array.isArray(ad.price) ? ad.price[0] : ad.price;
  const body = interpolateTemplate(tpl.body, {
    titre: ad.subject || ad.title || "",
    prix: String(price),
    ville: ad.location?.city || "",
    vendeur: ad.owner?.name || "",
  });

  const targetUrl = lbcAdUrl(ad.url, adId);

  // Inject content script into active tab to fill & send the message.
  // Require status:'complete' — a still-loading tab lacks the ad DOM so the
  // textarea selector would miss and the message would be silently dropped.
  const tabs = await chrome.tabs.query({ url: "*://www.lbc.fr/*", status: "complete" });
  if (!tabs.length) {
    warn("No LBC tab open — cannot auto-message");
    return false;
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: injectMessageInTab,
      args: [targetUrl, body],
    });
    // The injected func returns `{ navigated: true }` when the active LBC tab
    // was on a different page and had to be redirected to the ad URL. In that
    // case the executeScript resolves BEFORE the new page loads, so no
    // textarea was filled and no Send was clicked. Marking the ad messaged
    // and burning a rate-limit slot here would silently skip the retry on
    // the next poll and mislead the user into thinking the message went out.
    if (injection?.result?.navigated) {
      warn("Auto-message: tab navigated to ad page; message will not be retried this cycle");
      return false;
    }
    await incrementMessageCounter();
    await markAdMessaged(adId);
    log(`Auto-message sent for ad ${adId}`);
    return true;
  } catch (e) {
    warn("Auto-message injection failed:", e.message);
    return false;
  }
}

/** Injected into the page tab — NOT an extension context. */
function injectMessageInTab(adUrl, messageBody) {
  // Decide whether we're already on the target ad page. The earlier
  // `href.includes('/ad/collection/123')` substring check was unsafe: LBC ad
  // list_ids vary in length (9–11 digits are common), so a shorter id is a
  // strict prefix of any longer id that begins with it. E.g. target id 123
  // would be judged "same page" while on /ad/collection/1234567890, the
  // injector would then fill the CURRENT ad's textarea with our message and
  // click Send — auto-messaging the WRONG seller. Parse both URLs and
  // compare pathname segments exactly.
  function samePage() {
    try {
      const target = new URL(adUrl);
      const idMatch = target.pathname.match(/\/(?:ad\/collection|annonce)\/(\d+)/);
      if (!idMatch) return false;
      const want = idMatch[1];
      const cur = window.location.pathname.match(/\/(?:ad\/collection|annonce)\/(\d+)/);
      return !!cur && cur[1] === want;
    } catch (_) {
      return false;
    }
  }

  if (!samePage()) {
    window.location.href = adUrl;
    return { navigated: true };
  }

  const tryFill = () => {
    const textarea = document.querySelector(
      '[data-qa-id="adview_contact_container"] textarea, ' +
        '[data-test-id="message-input"] textarea, ' +
        'textarea[name="message"]',
    );
    if (!textarea) return false;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    nativeInputValueSetter?.call(textarea, messageBody);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));

    setTimeout(() => {
      const sendBtn = document.querySelector(
        '[data-qa-id="adview_contact_container"] button[type="submit"], ' + 'button[data-test-id="send-message"]',
      );
      if (sendBtn) sendBtn.click();
    }, 500);
    return true;
  };

  if (!tryFill()) {
    const observer = new MutationObserver(() => {
      if (tryFill()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10000);
  }
}

// ── Auto-open tab ─────────────────────────────

export async function autoOpenAdTab(ad) {
  // Prefer ad.id (IDB primary key = LBC list_id); fall back to ad.list_id (raw API ad)
  const adId = String(ad.id || ad.list_id);
  const url = lbcAdUrl(ad.url, adId);
  return chrome.tabs.create({ url, active: true });
}

// ── Checkout automation ───────────────────────

/**
 * Attempt automated purchase checkout.
 * mode: 'lite' = opens tab, injects UI clicks (shows to user)
 *       'full' = validates 3 safety gates, fills contact info, clicks buy
 */
export async function attemptCheckout(ad, mode, watchlist) {
  const adId = String(ad.id || ad.list_id); // IDB: ad.id=LBC id; raw API: ad.list_id=LBC id
  const price = Array.isArray(ad.price) ? ad.price[0] : ad.price;
  const url = lbcAdUrl(ad.url, adId);

  // ── Idempotency guard ──
  // Defeat double-click / double-dispatch from the notification Buy button and
  // the CONFIRM_PURCHASE message path. Without this guard two purchase rows
  // land in IDB and daily_spend is double-incremented, which would lock the
  // user out of the budget cap for the rest of the day.
  let existingPurchases = [];
  try {
    existingPurchases = await getPurchasesByAdId(adId);
  } catch (_) {
    existingPurchases = [];
  }
  const recentPending = existingPurchases.find(
    (p) => (p.status === "pending" || p.status === "auto_pending") && Date.now() - (p.purchased_at || 0) < 5 * 60_000, // 5-min window
  );
  if (recentPending) {
    warn(`Checkout skipped: recent pending purchase for ad ${adId} (id ${recentPending.id})`);
    return false;
  }

  // ── Full-auto safety gates ──
  if (mode === "full") {
    // Gate 1: global kill-switch
    const { full_auto_paused } = await chrome.storage.session.get("full_auto_paused");
    if (full_auto_paused) {
      warn("Full auto paused (kill-switch)");
      return false;
    }

    // Gate 2: per-watchlist budget cap
    const budget = watchlist.purchase_budget_max ?? 500;
    if (price > budget) {
      warn(`Full auto blocked: €${price} > budget €${budget}`);
      return false;
    }

    // Gate 3: daily spend accumulator (persistent in chrome.storage.local —
    // session storage would reset on browser restart, letting users bypass the cap).
    const stored = await chrome.storage.local.get(["daily_spend", "daily_spend_date"]);
    const today = new Date().toDateString();
    const dailySpend = stored.daily_spend_date === today ? (stored.daily_spend ?? 0) : 0;
    if (dailySpend + price > budget * 3) {
      warn(`Full auto blocked: daily spend €${dailySpend} + €${price} exceeds daily cap`);
      return false;
    }
  }

  // Open tab (active for lite, background checkout for full)
  const tab = await chrome.tabs.create({ url, active: mode === "lite" });

  // ── Idempotency lock ──
  // Persist the purchase row *now* (pending) — before the 30 s tab-load window.
  // The earlier getPurchasesByAdId guard only catches duplicates that already
  // committed a row. A second Buy click (or CONFIRM_PURCHASE race) landing in
  // the gap between guard and savePurchase would escape deduplication
  // entirely. Saving here closes that window: the next caller's guard hits
  // this pending row and short-circuits.
  //
  // Cross-layer note: the dashboard stats UI reads `buy_date` (millis), not
  // `purchased_at`. We write BOTH so auto-initiated purchases appear in the
  // table, pass the period filter, sort chronologically, and export to CSV
  // with a real date. Keeping `purchased_at` preserves the idempotency guard
  // contract used above and in `getPurchasesByAdId`.
  const now = Date.now();
  const purchase = {
    ad_id: adId,
    watchlist_id: watchlist.id,
    title: ad.subject || ad.title || "",
    buy_price: price,
    buy_date: now,
    status: mode === "lite" ? "pending" : "auto_pending",
    purchase_mode: mode,
    purchased_at: now,
  };
  await savePurchase(purchase); // assigns purchase.id

  // Wait for tab load then inject checkout script.
  // Safety: store {tabId, mode} so the alarm handler (service-worker) knows
  // whether to force-close on timeout. Lite mode = foreground user tab, never
  // auto-close. Full mode = hidden background tab, safe to close.
  await chrome.storage.session.set({ checkout_pending_tab: { tabId: tab.id, mode } });
  chrome.alarms.create("checkout-tab-ready", { delayInMinutes: 0.5 }); // 30s deadline

  // Wait for tab to reach status:'complete' OR be closed OR hit the 30s backstop.
  // Without the onRemoved + timeout fallbacks this promise hangs forever when
  // the user closes a lite-mode tab mid-load (or the page fails to finish),
  // blocking the caller (notifier button handler) and leaking the closure.
  const outcome = await new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      try {
        const clearMaybe = chrome.alarms.clear("checkout-tab-ready");
        if (clearMaybe && typeof clearMaybe.catch === "function") clearMaybe.catch(() => {});
      } catch (_) {}
      try {
        const removeMaybe = chrome.storage.session.remove("checkout_pending_tab");
        if (removeMaybe && typeof removeMaybe.catch === "function") removeMaybe.catch(() => {});
      } catch (_) {}
      resolve(reason);
    };
    function onUpdated(tabId, info) {
      if (tabId === tab.id && info.status === "complete") finish("complete");
    }
    function onRemoved(tabId) {
      if (tabId === tab.id) finish("closed");
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 30s wall-clock backstop — matches the alarm deadline. setTimeout is safe
    // here: the SW remains alive while this awaited promise is pending.
    setTimeout(() => finish("timeout"), 30_000);
  });

  if (outcome !== "complete") {
    warn(`Checkout aborted before load (${outcome}) for ad ${adId}`);
    // Mark the pre-saved pending purchase as rejected so future guards don't
    // misread a dead row as active, and so the dashboard shows truth.
    try {
      await dbPut(STORES.PURCHASES, { ...purchase, status: "rejected", reject_reason: `tab_${outcome}` });
    } catch (_) {
      // keep checkout flow resilient in tests/runtime fallbacks
    }
    // Orphan-tab guard: on 'timeout' we clear the SW alarm ourselves, so the
    // service-worker's force-close path never runs. For full-mode (hidden
    // background tab) this strands the tab forever, consuming memory until
    // browser restart. Close it here. Skip for 'closed' (already gone) and
    // for lite mode (user's foreground tab — never yank).
    if (outcome === "timeout" && mode === "full") {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_) {
        // ignore if already closed
      }
    }
    return false;
  }

  let contactInfo = {};
  if (mode === "full") {
    const keys = ["contact_name", "contact_phone", "contact_address", "contact_city", "contact_zip"];
    contactInfo = await chrome.storage.local.get(keys);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectCheckoutInTab,
      args: [mode, contactInfo],
    });
  } catch (e) {
    warn("Checkout injection failed:", e.message);
    try {
      await dbPut(STORES.PURCHASES, { ...purchase, status: "rejected", reject_reason: "inject_failed" });
    } catch (_) {
      // non-blocking persistence failure
    }
    // Same orphan-tab guard as above: the tab DID load ('complete'), so the
    // alarm was cleared, but injection failed — nothing will ever close this
    // hidden background tab. Lite mode stays open for the user.
    if (mode === "full") {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (_) {
        // ignore if already closed
      }
    }
    return false;
  }

  // Update daily spend for full auto (persistent — must survive browser restart)
  if (mode === "full") {
    const stored = await chrome.storage.local.get(["daily_spend", "daily_spend_date"]);
    const today = new Date().toDateString();
    const prev = stored.daily_spend_date === today ? (stored.daily_spend ?? 0) : 0;
    await chrome.storage.local.set({ daily_spend: prev + price, daily_spend_date: today });
  }

  log(`Checkout initiated [${mode}] for ad ${adId} @ €${price}`);
  return true;
}

/** Injected into the ad page — NOT extension context. */
function injectCheckoutInTab(mode, contact) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function tryClick(selectors, maxWait = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          el.click();
          return true;
        }
      }
      await delay(300);
    }
    return false;
  }

  async function fillInput(selectors, value) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  (async () => {
    // Click "Acheter" / "Je confirme la commande" button
    const buySelectors = [
      '[data-qa-id="adview_buy_button"]',
      'button[data-test-id="buy-button"]',
      'button[aria-label*="Acheter"]',
      'button[aria-label*="Commander"]',
    ];
    const clicked = await tryClick(buySelectors);
    if (!clicked) return;

    await delay(1000);

    // For full auto: fill contact form if visible
    if (mode === "full" && contact?.contact_name) {
      await fillInput(
        ['input[name="firstName"]', 'input[placeholder*="Prénom"]'],
        contact.contact_name?.split(" ")[0] || "",
      );
      await fillInput(
        ['input[name="lastName"]', 'input[placeholder*="Nom"]'],
        contact.contact_name?.split(" ").slice(1).join(" ") || "",
      );
      await fillInput(['input[name="phone"]', 'input[type="tel"]'], contact.contact_phone || "");
      await fillInput(['input[name="address"]', 'input[placeholder*="Adresse"]'], contact.contact_address || "");
      await fillInput(['input[name="city"]', 'input[placeholder*="Ville"]'], contact.contact_city || "");
      await fillInput(['input[name="zip"]', 'input[name="postalCode"]'], contact.contact_zip || "");
      await delay(800);

      // Confirm order
      await tryClick([
        'button[type="submit"]',
        'button[data-test-id="confirm-order"]',
        '[data-qa-id="confirm_order_button"]',
      ]);
    }
  })();
}
