(() => {
  const BRIDGE_NAME = "DDB → Foundry Roll Bridge";
  const seen = new Set();
  const processedElements = new WeakSet();
  // One entry per roll card still being tracked (pending, or settling after it resolved).
  // Every card has its own state and its own timer; nothing is shared between cards.
  const cards = new Map();
  const dirtyRoots = new Set();
  let flushScheduled = false;
  let sweepInterval = null;
  const MAX_SEEN = 300;
  let extensionContextInvalid = false;
  let statusInterval = null;
  let observer = null;
  // A resolved card must keep the same parsed result for this long before it is sent.
  // This is a per-card stability check (it only protects half-rendered cards), not a
  // global delay. It is skipped while the tab is hidden, where timers get throttled.
  const SETTLE_MS = 60;
  const SWEEP_MS = 250;
  const MAX_PENDING_AGE_MS = 15000;
  const MAX_CARD_TEXT = 1400;
  // D&D Beyond can show one roll in two places at once (for example a popup and the
  // log entry). Each submitted roll grants ONE "twin credit" that absorbs a single
  // matching copy within this window, but only if that copy sits in a different place
  // on the page (a different parent element), is nested with the original, or replaced
  // an original that has since disappeared. Two matching cards side by side in the same
  // list are two real rolls, never twins.
  const TWIN_WINDOW_MS = 500;
  const twinCredits = new Map();
  let DEBUG = false;
  try { DEBUG = localStorage.getItem("ddbBridgeDebug") === "1"; } catch (_) {}

  function log(...args) {
    console.debug(`[${BRIDGE_NAME}]`, ...args);
  }

  // Run localStorage.setItem("ddbBridgeDebug", "1") on the D&D Beyond page and reload to see these.
  function debug(...args) {
    if (DEBUG) console.log(`[${BRIDGE_NAME}] debug:`, ...args);
  }

  function stopBridge() {
    if (extensionContextInvalid) return;
    extensionContextInvalid = true;
    try { observer?.disconnect(); } catch (_) {}
    if (statusInterval !== null) clearInterval(statusInterval);
    if (sweepInterval !== null) clearInterval(sweepInterval);
    for (const card of cards.values()) clearTimeout(card.timer);
    cards.clear();
    dirtyRoots.clear();
  }

  function sendRuntimeMessage(message, callback) {
    if (extensionContextInvalid) return false;
    try {
      if (!chrome?.runtime?.id) {
        stopBridge();
        return false;
      }
      chrome.runtime.sendMessage(message, response => {
        try {
          const error = chrome.runtime.lastError;
          if (error && /extension context invalidated/i.test(error.message || "")) {
            stopBridge();
            return;
          }
        } catch (_) {
          stopBridge();
          return;
        }
        if (!extensionContextInvalid && typeof callback === "function") callback(response);
      });
      return true;
    } catch (_) {
      stopBridge();
      return false;
    }
  }

  function sendStatus(extra = {}) {
    sendRuntimeMessage({
      type: "DDB_ROLL_BRIDGE_DDB_STATUS",
      status: {
        url: location.href,
        title: document.title,
        lastScanAt: Date.now(),
        ...extra
      }
    });
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\u00a0/g, " ")
      .trim();
  }

  function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function looksLikeRoll(el, text) {
    const cleaned = cleanText(text);
    if (cleaned.length < 4) return false;
    if (/\b(d20|d\d+|rolled|rolls|critical|advantage|disadvantage|check|saving throw|attack|damage|initiative)\b/i.test(cleaned)) return true;
    if (el?.querySelector?.("[class*='dice' i], [class*='roll' i], [data-roll-total], [data-roll]") || el?.matches?.("[class*='dice' i], [class*='roll' i], [data-roll-total], [data-roll]")) return true;
    return false;
  }

  function textOf(el) {
    return cleanText(el?.innerText || el?.textContent || "");
  }

  function getElementKey(el) {
    if (!el) return "";
    if (el.dataset?.ddbBridgeKey) return el.dataset.ddbBridgeKey;
    const key = `ddb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try { el.dataset.ddbBridgeKey = key; } catch (_) {}
    return key;
  }

  function scoreRoot(el) {
    if (!(el instanceof HTMLElement)) return -1;
    const text = textOf(el);
    if (!looksLikeRoll(el, text)) return -1;
    if (text.length < 4 || text.length > MAX_CARD_TEXT) return -1;

    const cls = String(el.className || "");
    let score = Math.min(text.length, 900) / 10;
    if (/game.*log.*entry|log.*entry|message|card|roll.*card|dice.*roll/i.test(cls)) score += 120;
    if (/^LI$|^ARTICLE$/i.test(el.tagName)) score += 80;
    if (el.hasAttribute("data-roll-total") || el.querySelector("[data-roll-total]")) score += 40;
    if (/dice$/i.test(cls) || /die$/i.test(cls)) score -= 60;
    return score;
  }

  function findRollRoot(start) {
    if (!(start instanceof HTMLElement)) return null;
    let node = start;
    let best = null;
    let bestScore = -1;

    for (let depth = 0; node && node !== document.body && depth < 10; depth++, node = node.parentElement) {
      const text = textOf(node);
      if (text.length > MAX_CARD_TEXT) break;
      const score = scoreRoot(node);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }

    return best || start;
  }

  function extractLikelyName(el, text) {
    const candidates = [
      "[class*='character' i]",
      "[class*='player' i]",
      "[class*='avatar' i]",
      "[data-character-name]",
      "[aria-label*='character' i]"
    ];
    for (const sel of candidates) {
      const found = el.querySelector(sel);
      const value = found?.getAttribute("data-character-name") || found?.textContent;
      const cleaned = cleanText(value);
      if (cleaned && cleaned.length <= 60 && !/d20|rolled|damage|attack/i.test(cleaned)) return cleaned;
    }

    const cleaned = cleanText(text);
    const byVerb = cleaned.split(/\s+(?:rolled|rolls|made|casts?|uses?)\s+/i)[0];
    if (byVerb && byVerb.length <= 50) return byVerb;

    const beforeColon = cleaned.split(/[:—-]/)[0];
    if (beforeColon && beforeColon.length <= 50 && !/d\d+|roll/i.test(beforeColon)) return beforeColon;

    return "D&D Beyond";
  }

  function extractTotal(el, text) {
    const selectors = [
      "[data-roll-total]",
      "[class*='total' i]",
      "[class*='result' i]",
      "[class*='dice-result' i]"
    ];
    for (const sel of selectors) {
      for (const found of el.querySelectorAll(sel)) {
        const attr = found?.getAttribute("data-roll-total");
        const value = cleanText(attr || found?.textContent);
        // Only accept a result field that contains a number by itself.
        // Pulling the first number from arbitrary text caused fragments like
        // "Strength = 1" or a weapon name to be misidentified as roll totals.
        if (!/^[-+]?\d{1,3}$/.test(value)) continue;
        const num = Number(value);
        if (Number.isFinite(num)) return num;
      }
    }

    // Fallback only when the text explicitly labels the value as a total/result.
    const labelled = cleanText(text).match(/\b(?:total|result)\s*[:=]?\s*([-+]?\d{1,3})\b/i);
    if (labelled) return Number(labelled[1]);
    return null;
  }

  function extractFormula(text) {
    const cleaned = cleanText(text);
    // Capture common formulas such as 1d20+5, 2d6 + 3, 1d8 + 1d6 + 4.
    const match = cleaned.match(/(?:\d*d\d+)(?:\s*[+\-]\s*(?:\d*d\d+|\d+))*/i);
    if (!match) return "";
    return match[0].replace(/\s+/g, "").replace(/^d/i, "1d");
  }

  function extractDiceSummary(formula, text) {
    const source = formula || cleanText(text);
    const dice = [];
    const re = /(\d*)d(\d+)/gi;
    let m;
    while ((m = re.exec(source))) {
      const count = Number(m[1] || 1);
      const faces = Number(m[2]);
      if (Number.isFinite(count) && Number.isFinite(faces)) dice.push({ count, faces, term: `${count}d${faces}` });
    }
    if (!dice.length) return { dice, text: "" };

    const grouped = new Map();
    for (const d of dice) {
      grouped.set(d.faces, (grouped.get(d.faces) || 0) + d.count);
    }
    const parts = Array.from(grouped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([faces, count]) => `${count}d${faces}`);
    return { dice, text: parts.join(" + ") };
  }

  function extractTitle(el, text) {
    const selectors = [
      "[class*='title' i]",
      "[class*='roll-name' i]",
      "[class*='label' i]",
      "[class*='action' i]",
      "h1", "h2", "h3", "h4"
    ];
    for (const sel of selectors) {
      const found = el.querySelector(sel);
      const value = cleanText(found?.textContent);
      if (value && value.length <= 80 && !/^\d+$/.test(value) && !/^d\d+$/i.test(value)) return value;
    }

    const cleaned = cleanText(text);
    const patterns = [
      /(?:rolled|rolls|made)\s+(?:a\s+|an\s+)?(.+?)(?:\s+(?:check|saving throw|save|attack|damage)|\s+\d*d\d+|\s+total|$)/i,
      /(?:casts?|uses?)\s+(.+?)(?:\s+\d*d\d+|\s+total|$)/i,
      /\b([A-Z][A-Za-z' -]{2,40}\s+(?:Check|Save|Saving Throw|Attack|Damage))\b/
    ];
    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match?.[1]) return cleanText(match[1]).slice(0, 80);
    }
    return "D&D Beyond Roll";
  }


  function isPendingRollText(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return true;

    // D&D Beyond briefly renders a placeholder card while dice are still animating.
    // Those cards commonly contain '?' and/or '...' and then get replaced with the
    // final result. Do not forward those interim states to Foundry.
    if (/[?]/.test(cleaned)) return true;
    if (/\.\.\.|…/.test(cleaned)) return true;
    if (/\brolling\b|\bpending\b|\bcalculating\b|\bwaiting\b/i.test(cleaned)) return true;

    // Avoid forwarding tiny fragments such as a single die face before the whole
    // roll card has finished rendering.
    if (/^\d+$/.test(cleaned)) return true;

    return false;
  }

  function getStableRollKey(el, text) {
    const character = extractLikelyName(el, text);
    const title = extractTitle(el, text);
    const formula = extractFormula(text);
    // The stable key deliberately ignores the total so the placeholder and final
    // version of the same roll collapse to one pending card while we wait.
    return hashText(`${character}|${title}|${formula}|${getElementKey(el)}`);
  }

  function parseRollElement(el) {
    const rawText = textOf(el);
    if (!looksLikeRoll(el, rawText)) return null;
    if (isPendingRollText(rawText)) return { pending: true, rawText, stableKey: getStableRollKey(el, rawText) };

    const formula = extractFormula(rawText);
    const total = extractTotal(el, rawText);

    // A formula alone is not proof of a completed roll. Require a credible total.
    if (total === null) return null;

    const character = extractLikelyName(el, rawText);
    const title = extractTitle(el, rawText);
    const diceSummary = extractDiceSummary(formula, rawText);

    // ID uses the stable roll-card key plus the final result, so the interim
    // placeholder and final card do not become two separate Foundry messages.
    const id = hashText(`${getStableRollKey(el, rawText)}|${total}|${formula}`);

    return {
      id,
      character,
      title,
      formula,
      total,
      dice: diceSummary.dice,
      diceSummary: diceSummary.text,
      rawText,
      pageUrl: location.href,
      createdAt: Date.now()
    };
  }

  function rollSignature(roll) {
    // D&D Beyond sometimes renders one result as "Scorching Ray: damage" and elsewhere as
    // "SCORCHING RAY: DAMAGE 4 + 6". Normalize to the action category rather than the
    // rendered title, which can include the dice breakdown.
    const canonicalTitle = cleanText(roll.title).toLowerCase()
      .replace(/\b\d*d\d+\b/gi, "")
      .replace(/[+-]?\s*\d+(?:\.\d+)?/g, "")
      .replace(/[^a-z]+/g, "");
    return hashText([
      canonicalTitle,
      cleanText(roll.formula).toLowerCase().replace(/\s+/g, ""),
      String(roll.total)
    ].join("|"));
  }

  function isTwinLocation(prior, current) {
    return !prior.isConnected ||
      prior.parentElement !== current.parentElement ||
      prior.contains(current) ||
      current.contains(prior);
  }

  function consumeTwinCredit(signature, root, now) {
    const credits = (twinCredits.get(signature) || []).filter(c => now - c.at <= TWIN_WINDOW_MS);
    const i = credits.findIndex(c => c.root !== root && isTwinLocation(c.root, root));
    if (i === -1) {
      if (credits.length) twinCredits.set(signature, credits); else twinCredits.delete(signature);
      return false;
    }
    credits.splice(i, 1);
    if (credits.length) twinCredits.set(signature, credits); else twinCredits.delete(signature);
    return true;
  }

  function grantTwinCredit(signature, root, now) {
    const credits = (twinCredits.get(signature) || []).filter(c => now - c.at <= TWIN_WINDOW_MS);
    credits.push({ at: now, root });
    twinCredits.set(signature, credits);
    if (twinCredits.size > 100) {
      for (const [key, list] of twinCredits) {
        if (!list.some(c => now - c.at <= TWIN_WINDOW_MS)) twinCredits.delete(key);
      }
    }
  }

  function submitRoll(roll, root) {
    if (extensionContextInvalid || !roll?.id || seen.has(roll.id)) return;

    const signature = rollSignature(roll);
    const now = Date.now();
    if (consumeTwinCredit(signature, root, now)) {
      debug("Absorbed twin copy of a roll that was already sent", { title: roll.title, total: roll.total });
      return;
    }
    grantTwinCredit(signature, root, now);

    seen.add(roll.id);
    if (seen.size > MAX_SEEN) {
      const ids = Array.from(seen);
      seen.clear();
      ids.slice(-MAX_SEEN).forEach(id => seen.add(id));
    }
    sendRuntimeMessage({ type: "DDB_ROLL_BRIDGE_FOUND_ROLL", roll }, response => {
      sendStatus({
        lastRollId: roll.id,
        lastRollAt: Date.now(),
        accepted: !!response?.accepted,
        routed: !!response?.routed
      });
      if (response?.routed) log("Routed completed roll", { title: roll.title, total: roll.total });
      else if (response?.accepted) log("Roll accepted but no Foundry tab confirmed routing", { title: roll.title, total: roll.total });
    });
  }

  // Evaluate one card right now. Called when the card changes (mutation-driven), never on a
  // global schedule. A pending card does nothing and costs nothing until it changes again.
  function evaluateCard(root) {
    if (extensionContextInvalid || processedElements.has(root)) return;
    const key = getElementKey(root);
    const now = Date.now();
    let card = cards.get(key);
    if (!card) {
      card = { root, firstSeenAt: now, sig: null, stableSince: 0, timer: null };
      cards.set(key, card);
    }
    if (card.timer) { clearTimeout(card.timer); card.timer = null; }
    if (!root.isConnected) { cards.delete(key); return; }

    const roll = parseRollElement(root);
    if (!roll || roll.pending) {
      card.sig = null; // still waiting; the next change to this card re-evaluates it
      return;
    }

    const sig = rollSignature(roll);
    if (card.sig !== sig) { card.sig = sig; card.stableSince = now; }
    const wait = (document.hidden ? 0 : SETTLE_MS) - (now - card.stableSince);
    if (wait > 0) {
      card.timer = setTimeout(() => evaluateCard(root), wait);
      return;
    }

    cards.delete(key);
    processedElements.add(root);
    submitRoll(roll, root);
  }

  function flushDirty() {
    flushScheduled = false;
    const roots = Array.from(dirtyRoots);
    dirtyRoots.clear();
    for (const root of roots) evaluateCard(root);
  }

  // Mutations are coalesced in a microtask: all changes from one DOM update batch are
  // evaluated together, immediately after the batch, with no timer involved.
  function queueRoot(root) {
    if (extensionContextInvalid || !(root instanceof HTMLElement)) return;
    dirtyRoots.add(root);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flushDirty);
    }
  }

  // Backstop only: expires cards that never resolved and re-checks waiting cards in case
  // a change was missed. It is not on the path of normal rolls.
  function sweepCards() {
    const now = Date.now();
    for (const [key, card] of Array.from(cards)) {
      if (!card.root.isConnected || now - card.firstSeenAt > MAX_PENDING_AGE_MS) {
        clearTimeout(card.timer);
        cards.delete(key);
        debug("Dropped unresolved or removed card", textOf(card.root).slice(0, 120));
      } else if (card.sig === null) {
        evaluateCard(card.root);
      }
    }
  }

  // A change deep inside a card (for example only the small element that holds the total)
  // does not look like a roll by itself, so map it back to any card we are already tracking.
  function touchTrackedCards(target) {
    if (!cards.size || !target) return;
    for (const card of cards.values()) {
      if (card.root === target || card.root.contains(target)) queueRoot(card.root);
    }
  }

  function scanNode(node) {
    if (extensionContextInvalid || !(node instanceof HTMLElement)) return;
    const roots = new Map();

    const consider = el => {
      if (!(el instanceof HTMLElement)) return;
      const text = textOf(el);
      if (text.length > MAX_CARD_TEXT) return;
      if (!looksLikeRoll(el, text)) return;
      const root = findRollRoot(el);
      if (!root) return;
      roots.set(getElementKey(root), root);
    };

    consider(node);
    node.querySelectorAll?.("[class*='game-log' i], [class*='log-entry' i], [class*='dice' i], [class*='roll' i], [data-roll-total], [data-roll], li, article").forEach(consider);

    // Do not submit nested fragments if their parent roll card is already queued.
    for (const root of roots.values()) queueRoot(root);
  }

  observer = new MutationObserver(mutations => {
    if (extensionContextInvalid) return;
    for (const mutation of mutations) {
      touchTrackedCards(mutation.target);
      for (const node of mutation.addedNodes) scanNode(node);

      // A card can also change by swapping a text node (the result replacing a
      // placeholder). Re-scan the small element that owns it.
      if (mutation.type === "childList" && mutation.target instanceof HTMLElement &&
          Array.from(mutation.addedNodes).some(n => n.nodeType === Node.TEXT_NODE)) {
        scanNode(mutation.target);
      }

      // D&D Beyond often creates a roll card in a pending state and then updates
      // text nodes inside the same element. Watch those changes too so we send
      // only the final completed card.
      if (mutation.type === "characterData") {
        const parent = mutation.target?.parentElement;
        if (parent) scanNode(parent);
      }
      if (mutation.type === "attributes" && mutation.target instanceof HTMLElement) {
        scanNode(mutation.target);
      }
    }
  });

  function markExistingRollsAsSeen() {
    // Establish a baseline before accepting new mutations. DDB's game log may
    // already contain dozens of completed rolls when this content script starts.
    // Mark those roots as processed without forwarding them to Foundry.
    const selectors = "[class*='game-log' i], [class*='log-entry' i], [class*='dice' i], [class*='roll' i], [data-roll-total], [data-roll], li, article";
    const roots = new Set();
    document.body.querySelectorAll(selectors).forEach(el => {
      if (!(el instanceof HTMLElement)) return;
      const text = textOf(el);
      if (text.length > MAX_CARD_TEXT || !looksLikeRoll(el, text)) return;
      const root = findRollRoot(el);
      if (root) roots.add(root);
    });
    for (const root of roots) processedElements.add(root);
    log("Ignored existing game-log entries at startup", roots.size);
  }

  function start() {
    if (extensionContextInvalid || !document.body) return;
    markExistingRollsAsSeen();
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-roll-total", "data-roll", "data-character-name", "aria-label"]
    });
    sendStatus();
    sweepInterval = setInterval(sweepCards, SWEEP_MS);
    statusInterval = setInterval(() => {
      if (extensionContextInvalid) {
        clearInterval(statusInterval);
        statusInterval = null;
        return;
      }
      sendStatus();
    }, 5000);
    log("Watching D&D Beyond page for completed grouped rolls");
    // Do not backfill the whole existing log on load; it can duplicate old messages.
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
