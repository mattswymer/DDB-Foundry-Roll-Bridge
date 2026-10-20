(() => {
  const BRIDGE_NAME = "DDB → Foundry Roll Bridge";
  const seen = new Set();
  const recentSignatures = new Map();
  const processedElements = new WeakSet();
  const pendingRoots = new Map();
  const MAX_SEEN = 300;
  let extensionContextInvalid = false;
  let statusInterval = null;
  let observer = null;
  const PROCESS_DELAY_MS = 1400;
  const PENDING_RECHECK_MS = 900;
  const MAX_PENDING_AGE_MS = 15000;
  const MAX_CARD_TEXT = 1400;
  // Suppress duplicate representations of the same completed roll across rerendered DOM nodes.
  // A short window still permits a later legitimate roll with the same result.
  const DUPLICATE_SIGNATURE_WINDOW_MS = 300;

  function log(...args) {
    console.debug(`[${BRIDGE_NAME}]`, ...args);
  }

  function stopBridge() {
    if (extensionContextInvalid) return;
    extensionContextInvalid = true;
    try { observer?.disconnect(); } catch (_) {}
    if (statusInterval !== null) clearInterval(statusInterval);
    for (const pending of pendingRoots.values()) clearTimeout(pending.timer);
    pendingRoots.clear();
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

  function submitRoll(roll) {
    if (extensionContextInvalid || !roll?.id || seen.has(roll.id)) return;

    // D&D Beyond can represent one result with multiple nested elements and can
    // recreate those elements during rerenders. Element-based IDs alone do not
    // deduplicate those copies, so also compare meaningful content over a short window.
    // D&D Beyond sometimes exposes the same roll through two card shapes:
    // one includes the character/action name in the "character" field and one
    // does not. Compare a punctuation-insensitive title plus formula and total,
    // rather than requiring the extracted character/title split to match.
    const canonicalTitle = cleanText(roll.title).toLowerCase().replace(/[^a-z0-9]+/g, "");
    const signature = hashText([
      canonicalTitle,
      cleanText(roll.formula).toLowerCase().replace(/\s+/g, ""),
      String(roll.total)
    ].join("|"));
    const now = Date.now();
    for (const [key, timestamp] of recentSignatures) {
      if (now - timestamp > DUPLICATE_SIGNATURE_WINDOW_MS) recentSignatures.delete(key);
    }
    const priorAt = recentSignatures.get(signature);
    if (priorAt && now - priorAt <= DUPLICATE_SIGNATURE_WINDOW_MS) {
      log("Suppressed near-simultaneous duplicate representation", { signature, title: roll.title, total: roll.total });
      return;
    }
    recentSignatures.set(signature, now);

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

  function queueRoot(root) {
    if (extensionContextInvalid || !(root instanceof HTMLElement)) return;
    const key = getElementKey(root);
    const existing = pendingRoots.get(key);
    clearTimeout(existing?.timer);

    const firstSeenAt = existing?.firstSeenAt || Date.now();
    const timer = setTimeout(() => {
      if (processedElements.has(root)) {
        pendingRoots.delete(key);
        return;
      }

      const roll = parseRollElement(root);
      if (!roll) {
        pendingRoots.delete(key);
        return;
      }

      if (roll.pending) {
        // Wait for the animated/placeholder D&D Beyond roll card to resolve.
        // If it never resolves, drop it rather than posting a '?' result.
        if (Date.now() - firstSeenAt < MAX_PENDING_AGE_MS && document.contains(root)) {
          const retry = setTimeout(() => queueRoot(root), PENDING_RECHECK_MS);
          pendingRoots.set(key, { root, timer: retry, firstSeenAt });
        } else {
          pendingRoots.delete(key);
          log("Dropped unresolved pending roll", roll.rawText);
        }
        return;
      }

      pendingRoots.delete(key);
      processedElements.add(root);
      submitRoll(roll);
    }, PROCESS_DELAY_MS);

    pendingRoots.set(key, { root, timer, firstSeenAt });
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
      for (const node of mutation.addedNodes) scanNode(node);

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

  function start() {
    if (extensionContextInvalid || !document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-roll-total", "data-roll", "data-character-name", "aria-label"]
    });
    sendStatus();
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
