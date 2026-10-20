(() => {
  const MODULE_ID = "ddb-direct-roll-bridge";
  const MODULE_VERSION = "0.1.4";
  const seen = new Set();
  const MAX_SEEN = 300;

  function log(...args) {
    console.debug(`${MODULE_ID} |`, ...args);
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  }

  function parseEventDetail(detail) {
    if (!detail) return null;
    if (typeof detail === "string") {
      try { return JSON.parse(detail); } catch (_) { return null; }
    }
    if (typeof detail === "object") return detail;
    return null;
  }

  function emitExtensionEvent(name, payload) {
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload || {}) }));
  }

  function getSpeaker(characterName) {
    const name = String(characterName || "").trim();
    if (!name) return ChatMessage.getSpeaker();

    const actor = game.actors?.find?.(a => a.name?.toLowerCase() === name.toLowerCase());
    if (actor) return ChatMessage.getSpeaker({ actor });

    return {
      ...ChatMessage.getSpeaker(),
      alias: name
    };
  }

  function buildContent(roll) {
    const character = escapeHtml(roll.character || "D&D Beyond");
    const title = escapeHtml(roll.title || "D&D Beyond Roll");
    const formula = escapeHtml(roll.formula || "");
    const diceSummary = escapeHtml(roll.diceSummary || "");
    const diceCount = Array.isArray(roll.dice) ? roll.dice.reduce((sum, d) => sum + Number(d.count || 0), 0) : 0;
    const diceLabel = diceSummary ? `${diceSummary}${diceCount ? ` (${diceCount} dice)` : ""}` : "";
    const total = roll.total !== null && roll.total !== undefined ? escapeHtml(roll.total) : "—";
    const raw = escapeHtml(roll.rawText || "");

    return `
      <div class="ddb-direct-roll-card">
        <div class="ddb-direct-roll-header">
          <div>
            <div class="ddb-direct-roll-character">${character}</div>
            <div class="ddb-direct-roll-title">${title}</div>
          </div>
          <div class="ddb-direct-roll-total">${total}</div>
        </div>
        ${formula ? `<div class="ddb-direct-roll-formula"><strong>Formula:</strong> ${formula}</div>` : ""}
        ${diceLabel ? `<div class="ddb-direct-roll-dice"><strong>Dice:</strong> ${diceLabel}</div>` : ""}
        ${raw ? `<details class="ddb-direct-roll-raw"><summary>D&D Beyond text</summary><div>${raw}</div></details>` : ""}
      </div>
    `;
  }

  async function postRoll(roll) {
    if (!game.user?.isGM) {
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: false, reason: "not-gm", id: roll?.id || null, at: Date.now() });
      return;
    }

    if (!roll?.id) {
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: false, reason: "missing-roll-id", at: Date.now() });
      return;
    }

    if (seen.has(roll.id)) {
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: true, duplicate: true, id: roll.id, at: Date.now() });
      return;
    }

    seen.add(roll.id);
    if (seen.size > MAX_SEEN) {
      const ids = Array.from(seen);
      seen.clear();
      ids.slice(-MAX_SEEN).forEach(id => seen.add(id));
    }

    const content = buildContent(roll);
    const speaker = getSpeaker(roll.character);

    const message = await ChatMessage.create({
      speaker,
      content,
      flags: {
        [MODULE_ID]: {
          ddbRollId: roll.id,
          source: "ddb-direct-extension",
          raw: roll
        }
      }
    });

    emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: true, id: roll.id, messageId: message?.id || null, at: Date.now() });
  }

  Hooks.once("ready", () => {
    document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_PING", () => {
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_MODULE_READY", {
        ok: true,
        moduleId: MODULE_ID,
        version: MODULE_VERSION,
        user: game.user?.name,
        isGM: !!game.user?.isGM,
        world: game.world?.id,
        at: Date.now()
      });
    });

    document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_ROLL", event => {
      const roll = parseEventDetail(event.detail);
      if (!roll) {
        emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: false, reason: "bad-event-detail", at: Date.now() });
        return;
      }
      postRoll(roll).catch(err => {
        console.error(`${MODULE_ID} | Failed to post DDB roll`, err, roll);
        emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: false, reason: String(err?.message || err), id: roll?.id || null, at: Date.now() });
      });
    });

    emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_MODULE_READY", {
      ok: true,
      moduleId: MODULE_ID,
      version: MODULE_VERSION,
      user: game.user?.name,
      isGM: !!game.user?.isGM,
      world: game.world?.id,
      at: Date.now()
    });

    log("Ready. Waiting for D&D Beyond rolls from Chrome extension.");
  });
})();
