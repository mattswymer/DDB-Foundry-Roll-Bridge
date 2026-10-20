(() => {
  const BRIDGE_NAME = "DDB → Foundry Roll Bridge";
  let isFoundry = false;
  let moduleReady = false;

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
    chrome.runtime.sendMessage({
      type: "DDB_ROLL_BRIDGE_FOUNDRY_STATUS",
      status: {
        foundryDetected: isFoundry,
        moduleReady,
        url: location.href,
        title: document.title,
        updatedAt: Date.now(),
        ...extra
      }
    }, () => void chrome.runtime.lastError);
  }

  function pingFoundryModule() {
    if (!isFoundry) return;
    document.dispatchEvent(new CustomEvent("DDB_DIRECT_ROLL_BRIDGE_PING", {
      detail: JSON.stringify({ source: "extension", at: Date.now() })
    }));
  }

  function forwardToFoundryPage(roll) {
    if (!isFoundry) return false;

    // Do not inject inline scripts. Foundry's CSP blocks inline execution.
    // The Foundry module listens for this DOM event directly.
    document.dispatchEvent(new CustomEvent("DDB_DIRECT_ROLL_BRIDGE_ROLL", {
      detail: JSON.stringify(roll)
    }));

    sendStatus({ lastForwardedRollId: roll?.id || null, lastForwardedAt: Date.now() });
    return true;
  }

  document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_MODULE_READY", event => {
    moduleReady = true;
    let detail = {};
    try { detail = JSON.parse(event.detail || "{}"); } catch (_) {}
    sendStatus({ moduleReady: true, moduleDetail: detail });
    log("Foundry module ready", detail);
  });

  document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_ACK", event => {
    let ack = {};
    try { ack = JSON.parse(event.detail || "{}"); } catch (_) {}
    chrome.runtime.sendMessage({ type: "DDB_ROLL_BRIDGE_FOUNDRY_ACK", ack }, () => void chrome.runtime.lastError);
    log("Foundry ack", ack);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "DDB_ROLL_BRIDGE_ROLL") {
      const forwarded = forwardToFoundryPage(message.roll);
      sendResponse({ ok: forwarded, foundryDetected: isFoundry, moduleReady });
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
    setInterval(() => {
      isFoundry = looksLikeFoundry();
      sendStatus();
      pingFoundryModule();
    }, 5000);
  }

  setTimeout(start, 1000);
})();
