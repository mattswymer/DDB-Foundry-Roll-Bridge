import { normalizeMessage } from "./roll-parser.js";

const MODULE_ID = "ddb-roll-bridge-v2";
const MAX_SEEN_EVENTS = 1000;
const seenEvents = new Set();
let eventSource = null;
let bridgeState = "disconnected";

function log(...args) {
  console.debug(`[${MODULE_ID}]`, ...args);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function baseUrl() {
  return String(setting("bridgeUrl") || "http://127.0.0.1:39210").replace(/\/+$/, "");
}

function authHeaders() {
  return { "Content-Type": "application/json", "Authorization": `Bearer ${setting("bridgeToken") || ""}` };
}

async function bridgeRequest(path, options = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
    cache: "no-store"
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.error || `Local bridge request failed (HTTP ${response.status}).`);
  return body;
}

function rememberEvent(id) {
  if (!id || seenEvents.has(id)) return false;
  seenEvents.add(id);
  if (seenEvents.size > MAX_SEEN_EVENTS) {
    const ids = Array.from(seenEvents);
    seenEvents.clear();
    ids.slice(-MAX_SEEN_EVENTS).forEach(value => seenEvents.add(value));
  }
  return true;
}

function resolveActor(roll) {
  const mappings = setting("actorMappings") || {};
  const mappedId = mappings[String(roll.entityId)];
  if (mappedId) {
    const actor = game.actors?.get(mappedId);
    if (actor) return actor;
  }
  const matches = game.actors?.filter?.(actor => actor.name?.trim().toLowerCase() === roll.character.trim().toLowerCase()) || [];
  return matches.length === 1 ? matches[0] : null;
}

function renderRollCard(roll) {
  const rows = roll.rolls.map(item => {
    const total = item.total === null ? "—" : String(item.total);
    const type = item.rollKind ? `${item.rollType} · ${item.rollKind}` : item.rollType;
    const values = item.breakdown || (item.values.length ? item.values.join(" + ") : "");
    return `
      <section class="ddb-rb2-row" data-category="${escapeHtml(item.category)}">
        <div class="ddb-rb2-kind">${escapeHtml(type)}</div>
        <div class="ddb-rb2-total">${escapeHtml(total)}</div>
        <div class="ddb-rb2-tags"><span class="ddb-rb2-tag">${escapeHtml(item.category)}</span></div>
        ${item.formula ? `<div class="ddb-rb2-formula"><strong>Formula:</strong> ${escapeHtml(item.formula)}</div>` : ""}
        ${values ? `<div class="ddb-rb2-breakdown"><strong>Actual dice:</strong> ${escapeHtml(values)}</div>` : ""}
      </section>`;
  }).join("");

  return `
    <article class="ddb-rb2-card">
      <header class="ddb-rb2-header">
        <div><div class="ddb-rb2-character">${escapeHtml(roll.character)}</div><div class="ddb-rb2-action">${escapeHtml(roll.action)}</div></div>
        <span class="ddb-rb2-source">D&D Beyond</span>
      </header>
      ${rows}
    </article>`;
}

async function postRoll(roll) {
  if (!rememberEvent(roll.id)) return;
  const actor = resolveActor(roll);
  const speaker = actor
    ? ChatMessage.getSpeaker({ actor })
    : { ...ChatMessage.getSpeaker(), alias: roll.character || "D&D Beyond" };

  await ChatMessage.create({
    speaker,
    content: renderRollCard(roll),
    flags: {
      [MODULE_ID]: {
        eventId: roll.id,
        gameId: roll.gameId,
        entityId: roll.entityId,
        entityType: roll.entityType,
        action: roll.action,
        character: roll.character,
        timestamp: roll.timestamp,
        source: roll.source,
        categories: [...new Set(roll.rolls.map(item => item.category))],
        rolls: roll.rolls,
        raw: roll.raw
      }
    }
  });
  log("Mirrored fulfilled roll", { id: roll.id, character: roll.character, action: roll.action });
}

function processRawMessage(raw) {
  const normalized = normalizeMessage(raw);
  if (!normalized) return;
  postRoll(normalized).catch(error => {
    console.error(`[${MODULE_ID}] Failed to create chat card:`, error);
    ui.notifications?.error?.(`DDB Roll Bridge: ${error.message}`);
  });
}

function stopEventStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function startEventStream() {
  stopEventStream();
  const url = new URL(`${baseUrl()}/events`);
  url.searchParams.set("token", setting("bridgeToken") || "");
  eventSource = new EventSource(url.toString());

  eventSource.addEventListener("roll", event => {
    try { processRawMessage(JSON.parse(event.data)); }
    catch (error) { console.warn(`[${MODULE_ID}] Ignored malformed roll event.`, error); }
  });
  eventSource.addEventListener("status", event => {
    try {
      const status = JSON.parse(event.data);
      bridgeState = status.state || "unknown";
      updateBridgeButton();
      log("Transport status", status);
    } catch {}
  });
  eventSource.onerror = () => {
    bridgeState = "reconnecting";
    updateBridgeButton();
  };
}

function updateBridgeButton() {
  document.querySelectorAll("[data-ddb-rb2-open]").forEach(button => {
    button.dataset.state = bridgeState;
    button.title = `DDB Roll Bridge: ${bridgeState}`;
    const label = button.querySelector(".ddb-rb2-button-label");
    if (label) label.textContent = `DDB Bridge · ${bridgeState}`;
  });
}

async function connectBridge({ cobaltSession, gameId, skipBeyond20 }) {
  const url = baseUrl();
  const token = setting("bridgeToken");
  if (!token) throw new Error("Enter the local bridge access token shown in the direct-bridge terminal.");

  await bridgeRequest("/configure", {
    method: "POST",
    body: JSON.stringify({ cobaltSession, gameId, skipBeyond20 })
  });
  await bridgeRequest("/start", { method: "POST", body: "{}" });

  await game.settings.set(MODULE_ID, "campaignId", String(gameId));
  await game.settings.set(MODULE_ID, "skipBeyond20", !!skipBeyond20);
  startEventStream();
  bridgeState = "connecting";
  updateBridgeButton();
  ui.notifications?.info?.("DDB Roll Bridge connected. Waiting for new fulfilled rolls.");
}

function openSetupDialog() {
  const campaignId = escapeHtml(setting("campaignId") || "");
  const bridgeUrl = escapeHtml(baseUrl());
  const bridgeToken = escapeHtml(setting("bridgeToken") || "");
  const skipBeyond20 = setting("skipBeyond20") !== false;
  const content = `
    <form class="ddb-rb2-setup">
      <p>Connect directly to the D&D Beyond game log. The CobaltSession cookie is sent only to the local bridge process and D&D Beyond's authentication endpoint; it is not saved in Foundry settings.</p>
      <div class="form-group"><label>Local bridge URL</label><input name="bridgeUrl" type="url" value="${bridgeUrl}" required /></div>
      <div class="form-group"><label>Local bridge access token</label><input name="bridgeToken" type="password" value="${bridgeToken}" required autocomplete="off" /></div>
      <div class="form-group"><label>D&D Beyond campaign ID</label><input name="gameId" inputmode="numeric" value="${campaignId}" required /></div>
      <div class="form-group"><label>CobaltSession cookie value</label><input name="cobaltSession" type="password" value="" required autocomplete="off" placeholder="Paste cookie value; do not include 'CobaltSession='" /></div>
      <div class="form-group"><label><input name="skipBeyond20" type="checkbox" ${skipBeyond20 ? "checked" : ""}/> Skip rolls already flagged as delivered by Beyond20</label></div>
      <p class="notes">The bridge must be running on this computer. The cookie is held in the bridge process memory only; restarting the bridge requires entering it again.</p>
    </form>`;

  new Dialog({
    title: "DDB Direct Roll Bridge",
    content,
    buttons: {
      connect: {
        label: "Connect",
        callback: async html => {
          const root = html[0] || html;
          const form = root.querySelector("form");
          const data = new FormData(form);
          const nextUrl = String(data.get("bridgeUrl") || "http://127.0.0.1:39210").trim().replace(/\/+$/, "");
          const nextToken = String(data.get("bridgeToken") || "").trim();
          const gameId = String(data.get("gameId") || "").trim();
          const cobaltSession = String(data.get("cobaltSession") || "").trim();
          const skip = form.querySelector('[name="skipBeyond20"]').checked;

          if (!/^\d{1,20}$/.test(gameId)) {
            ui.notifications?.error?.("Enter the numeric D&D Beyond campaign ID.");
            return;
          }
          await game.settings.set(MODULE_ID, "bridgeUrl", nextUrl);
          await game.settings.set(MODULE_ID, "bridgeToken", nextToken);
          try {
            await connectBridge({ cobaltSession, gameId, skipBeyond20: skip });
            ui.notifications?.info?.("Use the Character Mapping button to associate D&D Beyond characters with Foundry actors.");
          } catch (error) {
            console.error(`[${MODULE_ID}] Connection failed:`, error);
            ui.notifications?.error?.(`DDB Roll Bridge: ${error.message}`);
          }
        }
      },
      mappings: {
        label: "Character Mapping",
        callback: () => openMappingDialog()
      },
      stop: {
        label: "Stop",
        callback: async () => {
          try { await bridgeRequest("/stop", { method: "POST", body: "{}" }); } catch (error) { log("Stop request failed", error); }
          stopEventStream();
          bridgeState = "stopped";
          updateBridgeButton();
        }
      },
      cancel: { label: "Close" }
    },
    default: "connect"
  }, { width: 620 }).render(true);
}

async function openMappingDialog() {
  let characters;
  try {
    const response = await bridgeRequest("/characters");
    characters = response.characters || [];
  } catch (error) {
    ui.notifications?.error?.(`Could not load D&D Beyond characters: ${error.message}`);
    return;
  }

  const mappings = setting("actorMappings") || {};
  const actors = game.actors?.contents || [];
  const options = ['<option value="">— Use character name as chat alias —</option>']
    .concat(actors.map(actor => `<option value="${escapeHtml(actor.id)}">${escapeHtml(actor.name)}</option>`))
    .join("");
  const rows = characters.map(character => `
    <div class="form-group ddb-rb2-map-row">
      <label><strong>${escapeHtml(character.name)}</strong><small> DDB ID: ${escapeHtml(character.id)}${character.userName ? ` · ${escapeHtml(character.userName)}` : ""}</small></label>
      <select data-ddb-id="${escapeHtml(character.id)}">${options.replace(`value="${escapeHtml(mappings[character.id] || "")}"`, `value="${escapeHtml(mappings[character.id] || "")}" selected`)}</select>
    </div>`).join("");

  new Dialog({
    title: "D&D Beyond → Foundry Character Mapping",
    content: `<form class="ddb-rb2-mappings"><p>Select the Foundry actor that represents each D&D Beyond character. Unmapped characters still post using their D&D Beyond name.</p>${rows || "<p>No characters were returned for this campaign.</p>"}</form>`,
    buttons: {
      save: {
        label: "Save Mapping",
        callback: async html => {
          const root = html[0] || html;
          const next = {};
          root.querySelectorAll("select[data-ddb-id]").forEach(select => {
            if (select.value) next[select.dataset.ddbId] = select.value;
          });
          await game.settings.set(MODULE_ID, "actorMappings", next);
          ui.notifications?.info?.("Character mapping saved.");
        }
      },
      cancel: { label: "Cancel" }
    },
    default: "save"
  }, { width: 700 }).render(true);
}

function addChatButton(app, html) {
  const root = html?.[0] || html;
  if (!(root instanceof HTMLElement) || root.querySelector("[data-ddb-rb2-open]")) return;
  const target = root.querySelector(".chat-controls") || root.querySelector(".chat-form") || root.querySelector(".window-header");
  if (!target) return;
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.ddbRb2Open = "true";
  button.className = "ddb-rb2-open";
  button.innerHTML = '<span class="ddb-rb2-button-label">DDB Bridge · disconnected</span>';
  button.addEventListener("click", openSetupDialog);
  target.append(button);
  updateBridgeButton();
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "bridgeUrl", {
    name: "Local Bridge URL",
    hint: "Address of the local DDB Direct Bridge service.",
    scope: "client", config: true, type: String, default: "http://127.0.0.1:39210"
  });
  game.settings.register(MODULE_ID, "bridgeToken", {
    name: "Local Bridge Access Token",
    hint: "Generated when the local bridge starts. Stored as a client setting.",
    scope: "client", config: true, type: String, default: ""
  });
  game.settings.register(MODULE_ID, "campaignId", {
    name: "D&D Beyond Campaign ID",
    hint: "Numeric ID from the D&D Beyond campaign URL.",
    scope: "client", config: true, type: String, default: ""
  });
  game.settings.register(MODULE_ID, "skipBeyond20", {
    name: "Skip Beyond20-bridged rolls",
    hint: "Avoid duplicate chat cards when Beyond20 already delivered a roll to Foundry.",
    scope: "client", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "actorMappings", {
    name: "D&D Beyond Character Mappings",
    scope: "world", config: false, type: Object, default: {}
  });
});

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  Hooks.on("renderChatLog", addChatButton);
  log("Ready. Open the DDB Bridge button in chat to configure the direct connection.");
});

Hooks.on("deleteChatMessage", message => {
  const id = message?.flags?.[MODULE_ID]?.eventId;
  if (id) seenEvents.delete(String(id));
});

game.modules.get(MODULE_ID).api = {
  openSetupDialog,
  openMappingDialog,
  getStatus: () => bridgeState,
  stop: () => { stopEventStream(); bridgeState = "stopped"; updateBridgeButton(); }
};
