const STATE = {
  recentRolls: [],
  lastRollIds: new Set(),
  ddb: {
    detected: false,
    url: null,
    title: null,
    lastScanAt: null,
    lastRollAt: null,
    lastRollId: null,
    lastAccepted: null
  },
  foundry: {
    detected: false,
    moduleReady: false,
    url: null,
    title: null,
    lastSeenAt: null,
    lastForwardedAt: null,
    lastForwardedRollId: null,
    lastAckAt: null,
    lastAck: null
  },
  counters: {
    rollsSeen: 0,
    rollsAccepted: 0,
    rollsForwarded: 0,
    foundryAcks: 0,
    foundryErrors: 0
  }
};

const MAX_RECENT = 50;
const MAX_SEEN = 200;
// Multiple open D&D Beyond character tabs can independently observe the same
// shared game-log roll. Deduplicate at the background level, across all tabs.
const CROSS_TAB_DUPLICATE_WINDOW_MS = 1800;
const MAX_RECENT_SIGNATURES = 300;
const recentRollSignatures = new Map();

function normalizeRollPart(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getCrossTabRollSignature(roll) {
  return [
    normalizeRollPart(roll.title),
    normalizeRollPart(roll.formula),
    String(roll.total ?? "")
  ].join("|");
}

function getRollCharacterKey(roll) {
  const character = normalizeRollPart(roll.character);
  return character === normalizeRollPart("D&D Beyond") ? "" : character;
}

function isSupportedFoundryUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === "https:" &&
        (host === "forge-vtt.com" || host.endsWith(".forge-vtt.com"))) ||
      (parsed.protocol === "http:" &&
        (host === "localhost" || host === "127.0.0.1"))
    );
  } catch (_) {
    return false;
  }
}

function isCrossTabDuplicate(roll) {
  const now = Date.now();
  for (const [signature, entry] of recentRollSignatures) {
    if (now - entry.timestamp > CROSS_TAB_DUPLICATE_WINDOW_MS) recentRollSignatures.delete(signature);
  }

  const signature = getCrossTabRollSignature(roll);
  const sourceTabId = roll.sourceTabId;
  const character = getRollCharacterKey(roll);
  const recentEntries = (recentRollSignatures.get(signature) || [])
    .filter(entry => now - entry.timestamp <= CROSS_TAB_DUPLICATE_WINDOW_MS);

  // Never collapse two identical results from the same tab: those can be two
  // legitimate rapid rolls. When both character names are known, also require
  // them to match so identical checks by different characters are not confused.
  const duplicate = recentEntries.some(entry =>
    sourceTabId != null &&
    entry.sourceTabId != null &&
    sourceTabId !== entry.sourceTabId &&
    (!character || !entry.character || character === entry.character)
  );
  if (duplicate) {
    recentRollSignatures.set(signature, recentEntries);
    return true;
  }

  recentEntries.push({ timestamp: now, sourceTabId, character });
  recentRollSignatures.set(signature, recentEntries.slice(-10));
  while (recentRollSignatures.size > MAX_RECENT_SIGNATURES) {
    recentRollSignatures.delete(recentRollSignatures.keys().next().value);
  }
  return false;
}

function rememberRoll(roll) {
  if (!roll || !roll.id) return false;
  STATE.ddb.lastRollAt = Date.now();
  STATE.ddb.lastRollId = roll.id;

  if (STATE.lastRollIds.has(roll.id)) {
    STATE.ddb.lastAccepted = false;
    return false;
  }

  STATE.lastRollIds.add(roll.id);
  if (STATE.lastRollIds.size > MAX_SEEN) {
    const ids = Array.from(STATE.lastRollIds);
    STATE.lastRollIds = new Set(ids.slice(-MAX_SEEN));
  }

  STATE.counters.rollsAccepted++;
  STATE.ddb.lastAccepted = true;
  STATE.recentRolls.unshift(roll);
  STATE.recentRolls = STATE.recentRolls.slice(0, MAX_RECENT);
  return true;
}

async function broadcastRoll(roll) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (error) {
    STATE.counters.foundryErrors++;
    console.error("[DDB → Foundry Roll Bridge] Could not query tabs", error);
    return 0;
  }
  let sent = 0;

  for (const tab of tabs) {
    if (!tab.id || !isSupportedFoundryUrl(tab.url)) continue;
    try {
      // Let the Foundry content script decide whether the page is actually Foundry.
      const response = await chrome.tabs.sendMessage(tab.id, { type: "DDB_ROLL_BRIDGE_ROLL", roll });
      if (response?.ok) sent++;
    } catch (_) {}
  }

  if (sent > 0) {
    // Count rolls routed to at least one Foundry tab, not tab deliveries.
    STATE.counters.rollsForwarded++;
    STATE.counters.foundryTabsReached = (STATE.counters.foundryTabsReached || 0) + sent;
    STATE.foundry.lastForwardedAt = Date.now();
    STATE.foundry.lastForwardedRollId = roll.id;
  }

  return sent;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "DDB_ROLL_BRIDGE_DDB_STATUS") {
    STATE.ddb = {
      ...STATE.ddb,
      detected: true,
      url: message.status?.url || sender?.tab?.url || null,
      title: message.status?.title || sender?.tab?.title || null,
      lastScanAt: message.status?.lastScanAt || Date.now()
    };
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "DDB_ROLL_BRIDGE_FOUND_ROLL") {
    const roll = {
      ...message.roll,
      receivedAt: Date.now(),
      sourceTabId: sender?.tab?.id ?? null
    };
    // First deduplicate identical roll representations emitted by separate DDB
    // tabs, then apply the existing ID-based guard as a second layer.
    STATE.counters.rollsSeen++;
    const duplicateAcrossTabs = isCrossTabDuplicate(roll);
    const isNew = duplicateAcrossTabs ? false : rememberRoll(roll);
    if (duplicateAcrossTabs) {
      STATE.counters.crossTabDuplicates = (STATE.counters.crossTabDuplicates || 0) + 1;
      STATE.ddb.lastAccepted = false;
    }
    if (isNew) broadcastRoll(roll);
    sendResponse({ ok: true, accepted: isNew });
    return true;
  }

  if (message.type === "DDB_ROLL_BRIDGE_FOUNDRY_STATUS") {
    STATE.foundry = {
      ...STATE.foundry,
      detected: !!message.status?.foundryDetected,
      moduleReady: !!message.status?.moduleReady,
      url: message.status?.url || sender?.tab?.url || null,
      title: message.status?.title || sender?.tab?.title || null,
      lastSeenAt: message.status?.updatedAt || Date.now(),
      lastForwardedAt: message.status?.lastForwardedAt || STATE.foundry.lastForwardedAt,
      lastForwardedRollId: message.status?.lastForwardedRollId || STATE.foundry.lastForwardedRollId
    };
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "DDB_ROLL_BRIDGE_FOUNDRY_ACK") {
    STATE.foundry.lastAckAt = Date.now();
    STATE.foundry.lastAck = message.ack || null;
    STATE.counters.foundryAcks++;
    if (message.ack && message.ack.ok === false) STATE.counters.foundryErrors++;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "DDB_ROLL_BRIDGE_GET_STATUS") {
    sendResponse({
      ok: true,
      state: {
        ddb: STATE.ddb,
        foundry: STATE.foundry,
        counters: STATE.counters,
        recentRolls: STATE.recentRolls.slice(0, 10)
      }
    });
    return true;
  }
});
