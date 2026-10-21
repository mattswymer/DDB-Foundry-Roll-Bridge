(() => {
  const BRIDGE_NAME = "DDB → Foundry Roll Bridge";
  let isFoundry = false;
  let moduleReady = false;
  let isGM = false;
  let extensionContextInvalid = false;
  let statusInterval = null;
  const pendingRolls = [];
  const MAX_PENDING_ROLLS = 100;
  const MAX_PENDING_ROLL_AGE_MS = 60_000;

  // Chrome invalidates existing content scripts when the extension is reloaded
  // or replaced. A stale script must stop messaging rather than throw every
  // time its status timer or an acknowledgement fires.
  function invalidateContext() {
    if (extensionContextInvalid) return;
    extensionContextInvalid = true;
    if (statusInterval !== null) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
    pendingRolls.length = 0;
  }

  function isContextAvailable() {
    if (extensionContextInvalid) return false;
    try {
      if (!chrome?.runtime?.id) {
        invalidateContext();
        return false;
      }
      return true;
    } catch (_) {
      invalidateContext();
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    if (!isContextAvailable()) return false;
    try {
      chrome.runtime.sendMessage(message, () => {
        try {
          // Reading lastError inside the callback suppresses Chrome's
          // unchecked runtime.lastError warning when a receiver is absent.
          void chrome.runtime.lastError;
        } catch (_) {
          invalidateContext();
        }
      });
      return true;
    } catch (_) {
      invalidateContext();
      return false;
    }
  }

  function looksLikeFoundry() {
    return !!(
      document.querySelector("#ui-left") ||
      document.querySelector("#chat") ||
      document.querySelector("body.vtt") ||
      document.title.toLowerCase().includes("foundry")
    );
  }

  function log(...args) {
    console.debug(`[${BRIDGE_NAME}]`, ...args);
  }

  function sendStatus(extra = {}) {
    sendRuntimeMessage({
      type: "DDB_ROLL_BRIDGE_FOUNDRY_STATUS",
      status: {
        foundryDetected: isFoundry,
        moduleReady,
        isGM,
        url: location.href,
        title: document.title,
        updatedAt: Date.now(),
        ...extra
      }
    });
  }

  function pingFoundryModule() {
    if (!isContextAvailable() || !isFoundry) return;
    document.dispatchEvent(new CustomEvent("DDB_DIRECT_ROLL_BRIDGE_PING", {
      detail: JSON.stringify({ source: "extension", at: Date.now() })
    }));
  }

  function dispatchRollToFoundry(roll) {
    // Do not inject inline scripts. Foundry's CSP blocks inline execution.
    // The Foundry module listens for this DOM event directly.
    document.dispatchEvent(new CustomEvent("DDB_DIRECT_ROLL_BRIDGE_ROLL", {
      detail: JSON.stringify(roll)
    }));

    sendStatus({
      lastForwardedRollId: roll?.id || null,
      lastForwardedAt: Date.now(),
      pendingRollCount: pendingRolls.length
    });
  }

  function emitRejectedRollAck(roll, reason) {
    document.dispatchEvent(new CustomEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", {
      detail: JSON.stringify({ ok: false, reason, id: roll?.id || null, at: Date.now() })
    }));
  }

  function flushPendingRolls() {
    if (!isContextAvailable() || !isFoundry || !moduleReady || !pendingRolls.length) return;
    const queued = pendingRolls.splice(0, pendingRolls.length);
    const now = Date.now();

    for (const entry of queued) {
      const reason = now - entry.queuedAt > MAX_PENDING_ROLL_AGE_MS
        ? "startup-timeout"
        : !isGM ? "not-gm" : null;

      if (reason) emitRejectedRollAck(entry.roll, reason);
      else dispatchRollToFoundry(entry.roll);
    }

    log("Resolved queued rolls after Foundry module became ready", queued.length);
  }

  function forwardToFoundryPage(roll) {
    if (!isContextAvailable()) return false;
    isFoundry = looksLikeFoundry();
    if (!isFoundry || !roll?.id) return false;
    if (moduleReady && !isGM) return false;

    if (!moduleReady) {
      const now = Date.now();
      for (let i = pendingRolls.length - 1; i >= 0; i--) {
        if (now - pendingRolls[i].queuedAt > MAX_PENDING_ROLL_AGE_MS) {
          const [expired] = pendingRolls.splice(i, 1);
          emitRejectedRollAck(expired.roll, "startup-timeout");
        }
      }
      if (pendingRolls.some(pending => pending.roll.id === roll.id)) return true;
      if (pendingRolls.length >= MAX_PENDING_ROLLS) {
        log("Rejected roll because the Foundry startup queue is full", roll.id);
        return false;
      }
      pendingRolls.push({ roll, queuedAt: now });
      sendStatus({
        lastQueuedRollId: roll.id,
        pendingRollCount: pendingRolls.length
      });
      return true;
    }

    dispatchRollToFoundry(roll);
    return true;
  }

  document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_MODULE_READY", event => {
    if (!isContextAvailable()) return;
    moduleReady = true;
    let detail = {};
    try { detail = JSON.parse(event.detail || "{}"); } catch (_) {}
    isGM = detail.isGM === true;
    flushPendingRolls();
    sendStatus({ moduleReady: true, moduleDetail: detail });
    log("Foundry module ready", detail);
  });

  document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_ACK", event => {
    if (!isContextAvailable()) return;
    let ack = {};
    try { ack = JSON.parse(event.detail || "{}"); } catch (_) {}
    sendRuntimeMessage({ type: "DDB_ROLL_BRIDGE_FOUNDRY_ACK", ack });
    log("Foundry ack", ack);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isContextAvailable()) {
      sendResponse({ ok: false, reason: "extension-context-invalid" });
      return true;
    }
    if (message?.type === "DDB_ROLL_BRIDGE_ROLL") {
      const forwarded = forwardToFoundryPage(message.roll);
      sendResponse({ ok: forwarded, foundryDetected: isFoundry, moduleReady, isGM });
      return true;
    }

    if (message?.type === "DDB_ROLL_BRIDGE_PING_FOUNDRY") {
      pingFoundryModule();
      sendResponse({ ok: true, foundryDetected: isFoundry, moduleReady });
      return true;
    }
  });

  function start() {
    if (!isContextAvailable()) return;
    isFoundry = looksLikeFoundry();
    if (!isFoundry) return;
    sendStatus();
    pingFoundryModule();
    statusInterval = setInterval(() => {
      if (!isContextAvailable()) return;
      isFoundry = looksLikeFoundry();
      sendStatus();
      pingFoundryModule();
    }, 5000);
  }

  setTimeout(start, 1000);
})();
