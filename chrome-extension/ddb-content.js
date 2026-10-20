(() => {
  const BRIDGE_NAME = "DDB → Foundry Roll Bridge";
  const seen = new Set();
  const processedElements = new WeakSet();
  const pendingRoots = new Map();
  const MAX_SEEN = 300;
  const PROCESS_DELAY_MS = 1400;
  const PENDING_RECHECK_MS = 900;
  const MAX_PENDING_AGE_MS = 15000;
  const MAX_CARD_TEXT = 1400;

  function log(...args) {
    console.debug(`[${BRIDGE_NAME}]`, ...args);
  }

  function sendStatus(extra = {}) {
    chrome.runtime.sendMessage({
      type: "DDB_ROLL_BRIDGE_DDB_STATUS",
      status: {
        url: location.href,
        title: document.title,
        lastScanAt: Date.now(),
        ...extra
      }
    }, () => void chrome.runtime.lastError);
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

  function maybeNumber(text) {
    const match = String(text || "").match(/[-+]?\d+/);
    return match ? Number(match[0]) : null;
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
      "[class*='dice-result' i]",
      "[class*='number' i]"
    ];
    for (const sel of selectors) {
      for (const found of el.querySelectorAll(sel)) {
        const attr = found?.getAttribute("data-roll-total");
        const num = maybeNumber(attr || found?.textContent);
        if (Number.isFinite(num)) return num;
      }
    }

    // Prefer a number after labels like Total/Result if present.
    const labelled = cleanText(text).match(/(?:total|result)\D{0,12}([-+]?\d+)/i);
    if (labelled) return Number(labelled[1]);

    const nums = cleanText(text).match(/[-+]?\d+/g) || [];
    if (!nums.length) return null;
    return Number(nums[nums.length - 1]);
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

    // Avoid sending tiny partial dice fragments. A complete roll needs at least a total or a formula.
    if (total === null && !formula) return null;

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
    if (!roll?.id || seen.has(roll.id)) return;
    seen.add(roll.id);
    if (seen.size > MAX_SEEN) {
      const ids = Array.from(seen);
      seen.clear();
      ids.slice(-MAX_SEEN).forEach(id => seen.add(id));
    }
    chrome.runtime.sendMessage({ type: "DDB_ROLL_BRIDGE_FOUND_ROLL", roll }, response => {
      if (chrome.runtime.lastError) return;
      sendStatus({ lastRollId: roll.id, lastRollAt: Date.now(), accepted: !!response?.accepted });
      if (response?.accepted) log("Forwarded grouped roll", roll);
    });
  }

  function queueRoot(root) {
    if (!(root instanceof HTMLElement)) return;
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
    if (!(node instanceof HTMLElement)) return;
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

  const observer = new MutationObserver(mutations => {
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
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    sendStatus();
    setInterval(() => sendStatus(), 5000);
    log("Watching D&D Beyond page for completed grouped rolls");
    // Do not backfill the whole existing log on load; it can duplicate old messages.
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
