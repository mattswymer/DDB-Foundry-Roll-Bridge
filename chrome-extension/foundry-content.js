(() => {
  const BRIDGE_NAME = "DDB → Foundry Roll Bridge";
  let isFoundry = false;
  let moduleReady = false;
  let isGM = false;
  let extensionContextInvalid = false;
  let statusInterval = null;
  const pendingRolls = [];
  const MAX_PENDING_ROLLS = 100;

  // Chrome invalidates existing content scripts when the extension is reloaded
  // or replaced. A stale script must stop messaging rather than throw every
  // time its status timer or an acknowledgement fires.
  function sendRuntimeMessage(message) {
    if (extensionContextInvalid) return false;
    try {
      if (!chrome?.runtime?.id) {
        extensionContextInvalid = true;
        if (statusInterval !== null) clearInterval(statusInterval);
        return false;
      }
      chrome.runtime.sendMessage(message, () => {
        try {
          // Reading lastError inside the callback suppresses Chrome's
          // unchecked runtime.lastError warning when a receiver is absent.
          void chrome.runtime.lastError;
        } catch (_) {
          extensionContextInvalid = true;
          if (statusInterval !== null) clearInterval(statusInterval);
        }
      });
      return true;
    } catch (_) {
      extensionContextInvalid = true;
      if (statusInterval !== null) clearInterval(statusInterval);
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
    if (!isFoundry) return;
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

  function flushPendingRolls() {
    if (!isFoundry || !moduleReady || !pendingRolls.length) return;
    const queued = pendingRolls.splice(0, pendingRolls.length);

    if (!isGM) {
      for (const roll of queued) {
        document.dispatchEvent(new CustomEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", {
          detail: JSON.stringify({
            ok: false,
            reason: "not-gm",
            id: roll.id,
            at: Date.now()
          })
        }));
      }
      log("Discarded queued rolls because this Foundry session is not GM", queued.length);
      return;
    }

    for (const roll of queued) dispatchRollToFoundry(roll);
    log("Flushed queued rolls after Foundry module became ready", queued.length);
  }

  function forwardToFoundryPage(roll) {
    isFoundry = looksLikeFoundry();
    if (!isFoundry || !roll?.id) return false;
    if (moduleReady && !isGM) return false;

    if (!moduleReady) {
      if (pendingRolls.some(pending => pending.id === roll.id)) return true;
      if (pendingRolls.length >= MAX_PENDING_ROLLS) {
        log("Rejected roll because the Foundry startup queue is full", roll.id);
        return false;
      }
      pendingRolls.push(roll);
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
    moduleReady = true;
    let detail = {};
    try { detail = JSON.parse(event.detail || "{}"); } catch (_) {}
    isGM = detail.isGM === true;
    flushPendingRolls();
    sendStatus({ moduleReady: true, moduleDetail: detail });
    log("Foundry module ready", detail);
  });

  document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_ACK", event => {
    let ack = {};
    try { ack = JSON.parse(event.detail || "{}"); } catch (_) {}
    sendRuntimeMessage({ type: "DDB_ROLL_BRIDGE_FOUNDRY_ACK", ack });
    log("Foundry ack", ack);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    isFoundry = looksLikeFoundry();
    if (!isFoundry) return;
    sendStatus();
    pingFoundryModule();
    statusInterval = setInterval(() => {
      if (extensionContextInvalid) {
        clearInterval(statusInterval);
        statusInterval = null;
        return;
      }
      isFoundry = looksLikeFoundry();
      sendStatus();
      pingFoundryModule();
    }, 5000);
  }

  setTimeout(start, 1000);
})();
