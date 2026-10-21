function fmtTime(ts) {
  if (!ts) return "never";
  return new Date(ts).toLocaleTimeString();
}

function setPill(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `pill ${cls || ""}`.trim();
}

function update() {
  chrome.runtime.sendMessage({ type: "DDB_ROLL_BRIDGE_GET_STATUS" }, response => {
    const state = response?.state;
    if (!state) return;

    setPill("ddbStatus", state.ddb.detected ? "detected" : "not seen", state.ddb.detected ? "ok" : "bad");
    document.getElementById("ddbUrl").textContent = state.ddb.detected
      ? `${state.ddb.title || "D&D Beyond"}\nlast scan: ${fmtTime(state.ddb.lastScanAt)}`
      : "Open your D&D Beyond campaign page and open the game log panel.";

    setPill("foundryStatus", state.foundry.detected ? "detected" : "not seen", state.foundry.detected ? "ok" : "bad");
    const moduleIsReady = !!state.foundry.moduleReady;
    const gmReady = moduleIsReady && state.foundry.isGM === true;
    setPill(
      "moduleStatus",
      !moduleIsReady ? "not ready" : gmReady ? "ready (GM)" : "GM session needed",
      !moduleIsReady ? "warn" : gmReady ? "ok" : "warn"
    );
    document.getElementById("foundryUrl").textContent = state.foundry.detected
      ? `${state.foundry.title || "Foundry"}\nlast seen: ${fmtTime(state.foundry.lastSeenAt)}`
      : "Open Foundry in a tab and enable the DDB Direct Roll Bridge module.";

    document.getElementById("rollsSeen").textContent = String(state.counters.rollsSeen || 0);
    document.getElementById("rollsForwarded").textContent = String(state.counters.rollsForwarded || 0);
    document.getElementById("acks").textContent = String(state.counters.foundryAcks || 0);

    const ack = state.foundry.lastAck;
    document.getElementById("lastAck").textContent = ack
      ? `last ack: ${ack.ok ? "OK" : "ERROR"} ${ack.reason ? `(${ack.reason})` : ""} at ${fmtTime(state.foundry.lastAckAt)}`
      : "No Foundry acknowledgement yet.";

    const recent = state.recentRolls || [];
    document.getElementById("recent").textContent = recent.length
      ? recent.map(r => `${r.character || "?"} — ${r.title || "Roll"} = ${r.total ?? "?"}`).join("\n")
      : "None yet";
  });
}

document.getElementById("refresh").addEventListener("click", update);
update();
setInterval(update, 2000);
