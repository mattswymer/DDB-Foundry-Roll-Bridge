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
  foundryTabs: {},
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
const MAX_TRACKED_FOUNDRY_TABS = 100;
const FOUNDRY_URL_PATTERNS = [
  "https://forge-vtt.com/*",
  "https://*.forge-vtt.com/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
  "https://localhost/*",
  "https://127.0.0.1/*"
];
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
    const localHost = host === "localhost" || host === "127.0.0.1";
    const forgeHost = host === "forge-vtt.com" || host.endsWith(".forge-vtt.com");
    return (
      (parsed.protocol === "https:" && forgeHost) ||
      ((parsed.protocol === "http:" || parsed.protocol === "https:") && localHost)
    );
  } catch (_) {
    return false;
  }
}

function isCrossTabDuplicate(roll) {
  const now = Date.now();
  for (const [signature, entries] of recentRollSignatures) {
    const active = entries.filter(entry => now - entry.timestamp <= CROSS_TAB_DUPLICATE_WINDOW_MS);
    if (active.length) recentRollSignatures.set(signature, active);
    else recentRollSignatures.delete(signature);
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
    tabs = await chrome.tabs.query({ url: FOUNDRY_URL_PATTERNS });
  } catch (error) {
    STATE.counters.foundryErrors++;
    console.error("[DDB → Foundry Roll Bridge] Could not query Foundry tabs", error);
    return 0;
  }

  // ChatMessage.create is broadcast to the whole Foundry world. Sending a roll
  // to every open Foundry tab would therefore create one duplicate per tab.
  // Prefer a tab known to have the module ready, and stop at the first tab that
  // accepts the roll. A content script can queue a roll during module startup.
  const candidates = tabs
    .filter(tab => tab.id && isSupportedFoundryUrl(tab.url))
    .sort((a, b) =>
      Number(!!STATE.foundryTabs[b.id]?.moduleReady && !!STATE.foundryTabs[b.id]?.isGM) -
      Number(!!STATE.foundryTabs[a.id]?.moduleReady && !!STATE.foundryTabs[a.id]?.isGM) ||
      Number(!!STATE.foundryTabs[b.id]?.moduleReady) -
      Number(!!STATE.foundryTabs[a.id]?.moduleReady)
    );

  for (const tab of candidates) {
    try {
      const response = await chrome.tabs.sendMessage(
        tab.id,
        { type: "DDB_ROLL_BRIDGE_ROLL", roll }
      );
      if (!response?.ok) continue;

      STATE.counters.rollsForwarded++;
      STATE.counters.foundryTabsReached = (STATE.counters.foundryTabsReached || 0) + 1;
      STATE.foundry.lastForwardedAt = Date.now();
      STATE.foundry.lastForwardedRollId = roll.id;
      return 1;
    } catch (_) {
      // The tab may have navigated or its content script may not be available.
      // Try the next eligible Foundry tab rather than failing the whole roll.
    }
  }

  return 0;
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

    if (!isNew) {
      sendResponse({ ok: true, accepted: false, routed: false });
      return true;
    }

    // Keep the message channel open until routing finishes so the MV3 service
    // worker has an active event while asynchronous tab APIs are pending.
    broadcastRoll(roll).then(sent => {
      sendResponse({ ok: true, accepted: true, routed: sent > 0 });
    }).catch(error => {
      STATE.counters.foundryErrors++;
      console.error("[DDB → Foundry Roll Bridge] Roll routing failed", error);
      sendResponse({ ok: true, accepted: true, routed: false });
    });
    return true;
  }

  if (message.type === "DDB_ROLL_BRIDGE_FOUNDRY_STATUS") {
    const status = {
      detected: !!message.status?.foundryDetected,
      moduleReady: !!message.status?.moduleReady,
      isGM: message.status?.isGM === true,
      url: message.status?.url || sender?.tab?.url || null,
      title: message.status?.title || sender?.tab?.title || null,
      lastSeenAt: message.status?.updatedAt || Date.now(),
      lastForwardedAt: message.status?.lastForwardedAt || null,
      lastForwardedRollId: message.status?.lastForwardedRollId || null
    };

    STATE.foundry = {
      ...STATE.foundry,
      ...status,
      lastForwardedAt: status.lastForwardedAt || STATE.foundry.lastForwardedAt,
      lastForwardedRollId: status.lastForwardedRollId || STATE.foundry.lastForwardedRollId
    };

    const tabId = sender?.tab?.id;
    if (tabId != null) {
      STATE.foundryTabs[tabId] = status;
      const tracked = Object.entries(STATE.foundryTabs)
        .sort((a, b) => Number(b[1].lastSeenAt || 0) - Number(a[1].lastSeenAt || 0));
      for (const [id] of tracked.slice(MAX_TRACKED_FOUNDRY_TABS)) {
        delete STATE.foundryTabs[id];
      }
    }

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
