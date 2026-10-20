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

function rememberRoll(roll) {
  if (!roll || !roll.id) return false;
  STATE.counters.rollsSeen++;
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
  const tabs = await chrome.tabs.query({});
  let sent = 0;

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    try {
      // Let the Foundry content script decide whether the page is actually Foundry.
      const response = await chrome.tabs.sendMessage(tab.id, { type: "DDB_ROLL_BRIDGE_ROLL", roll });
      if (response?.ok) sent++;
    } catch (_) {}
  }

  if (sent > 0) {
    STATE.counters.rollsForwarded += sent;
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
    const isNew = rememberRoll(roll);
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
