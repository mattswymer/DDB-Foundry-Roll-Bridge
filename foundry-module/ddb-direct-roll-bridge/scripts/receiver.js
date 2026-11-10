(() => {
  const MODULE_ID = "ddb-direct-roll-bridge";
  const MODULE_VERSION = "0.2.0";
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
    return { ...ChatMessage.getSpeaker(), alias: name };
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

  function remember(id) {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
    return true;
  }

  function findAttackSource(event) {
    const data = event?.data;
    const name = String(data?.context?.name || "").trim();
    const action = String(data?.action || "").trim();
    if (!name || !action) throw new Error("Missing D&D Beyond character or action name");

    const actors = game.actors.filter(a => a.name?.toLowerCase() === name.toLowerCase());
    if (actors.length !== 1) throw new Error(`Expected one Foundry actor named "${name}", found ${actors.length}`);
    const actor = actors[0];

    const items = actor.items.filter(i => i.name?.toLowerCase() === action.toLowerCase());
    if (items.length !== 1) throw new Error(`Expected one item named "${action}" on ${actor.name}, found ${items.length}`);
    const item = items[0];

    const activities = Array.from(item.system.activities?.values?.() || item.system.activities || [])
      .filter(a => a.type === "attack");
    if (activities.length !== 1) throw new Error(`Expected one attack activity on ${item.name}, found ${activities.length}`);
    return { actor, item, activity: activities[0] };
  }

  function buildNativeD20Roll(event, actor, activity, usageMessage) {
    const source = event.data.rolls?.[0];
    const notation = source?.diceNotation;
    const result = source?.result;
    if (!notation || !Array.isArray(notation.set) || !result || !Array.isArray(result.values)) {
      throw new Error("D&D Beyond attack event is missing dice notation or result values");
    }

    const sets = notation.set;
    if (!sets.length || sets.some(s => String(s.dieType).toLowerCase() !== "d20")) {
      throw new Error("Only d20 attack rolls are currently supported by native reconstruction");
    }

    const formulaParts = sets.map(s => {
      const count = Number(s.count || s.dice?.length || 0);
      if (!Number.isInteger(count) || count < 1) throw new Error("Invalid d20 count in D&D Beyond notation");
      let part = `${count}${String(s.dieType).toLowerCase()}`;
      const operation = Number(s.operation || 0);
      if (count > 1 && operation === 2) part += "kh1";
      else if (count > 1 && operation === 1) part += "kl1";
      return part;
    });
    const constant = Number(notation.constant ?? result.constant ?? 0);
    if (!Number.isFinite(constant)) throw new Error("Invalid D&D Beyond roll modifier");
    if (constant !== 0) formulaParts.push(String(constant));
    const formula = formulaParts.join(" + ").replace(/\+ -/g, "-");

    const targets = usageMessage.system?.targets || [];
    const target = targets.length === 1 ? targets[0].ac : undefined;
    const ability = activity.attack?.ability && activity.attack.ability !== "none"
      ? activity.attack.ability
      : activity._getAbilityOptions?.()[0]?.value;
    const item = activity.item;
    const last = item.getFlag("dnd5e", `last.${activity.id}`) || {};
    const attackModes = item.system.attackModes || [];
    const ammunitionOptions = item.system.ammunitionOptions || [];
    const masteryOptions = item.system.masteryOptions || [];
    const attackMode = attackModes.some(option => option.value === last.attackMode)
      ? last.attackMode : attackModes[0]?.value;
    const ammunition = ammunitionOptions.some(option => option.value === last.ammunition)
      ? last.ammunition : ammunitionOptions[0]?.value;
    const mastery = masteryOptions.some(option => option.value === last.mastery)
      ? last.mastery : masteryOptions[0]?.value;
    const options = {
      target: Number.isFinite(target) ? target : undefined,
      ability, ammunition, attackMode, mastery,
      criticalSuccess: activity.criticalThreshold,
      criticalFailure: 1,
      rollType: "attack",
      configured: true,
      originatingMessage: usageMessage.id
    };

    const roll = new CONFIG.Dice.D20Roll(formula, actor.getRollData(), options);
    const data = roll.toJSON();
    const dieTerms = data.terms.filter(t => t.class === "D20Die" || t.faces === 20);
    const diceCount = dieTerms.reduce((sum, t) => sum + Number(t.number || 1), 0);
    if (diceCount !== result.values.length) {
      throw new Error(`D&D Beyond supplied ${result.values.length} d20 values; Foundry formula expects ${diceCount}`);
    }

    const keptValue = Number(result.total) - constant;
    let valuesUsed = 0;
    let selectedOne = false;
    for (const term of data.terms) {
      if (term.class === "D20Die" || term.faces === 20) {
        const count = Number(term.number || 1);
        term.results = result.values.slice(valuesUsed, valuesUsed + count).map(value => {
          const face = Number(value);
          let active = true;
          const hasKeepRule = sets.some(s => Number(s.count || 0) > 1 && Number(s.operation || 0) !== 0);
          if (hasKeepRule) {
            active = !selectedOne && face === keptValue;
            if (active) selectedOne = true;
          }
          return { result: face, active };
        });
        valuesUsed += count;
        term.evaluated = true;
      } else {
        term.evaluated = true;
      }
    }

    data.evaluated = true;
    data.total = Number(result.total);
    data.options = { ...data.options, ...options };
    return CONFIG.Dice.D20Roll.fromData(data);
  }

  async function postNativeAttack(event) {
    const rollId = event?.data?.rollId;
    if (!game.user?.isGM) throw new Error("The Foundry session receiving rolls must be a GM");
    if (event?.eventType !== "dice/roll/fulfilled" || !rollId) throw new Error("Invalid fulfilled WebSocket roll event");
    const source = event.data.rolls?.[0];
    if (String(source?.rollType || "").toLowerCase() !== "to hit") {
      throw new Error(`Native handling not yet enabled for roll type "${source?.rollType || "unknown"}"`);
    }

    const { actor, item, activity } = findAttackSource(event);
    const usage = await activity.use(
      { consume: false, subsequentActions: false },
      { configure: false }
    );
    const usageMessage = usage?.message;
    if (!usageMessage) throw new Error("Foundry did not create the native activity usage card");

    const roll = buildNativeD20Roll(event, actor, activity, usageMessage);
    const system = {
      ...(usageMessage.system?.toObject?.() || usageMessage.system || {}),
      origin: usageMessage.id,
      ability: roll.options.ability
    };
    if (roll.options.ammunition) system.ammunition = roll.options.ammunition;
    if (roll.options.mastery) system.mastery = roll.options.mastery;
    if (roll.options.attackMode) system.mode = roll.options.attackMode;

    const messageData = {
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `${item.name} - Attack Roll`,
      type: "attack",
      system,
      flags: {
        [MODULE_ID]: {
          ddbRollId: rollId,
          source: "ddb-websocket",
          characterId: event.entityId || event.data.context?.entityId || null
        }
      }
    };

    if (event.messageScope === "userId" || event.data.context?.messageScope === "userId") {
      messageData.whisper = ChatMessage.getWhisperRecipients("GM").map(user => user.id);
    }

    const message = await CONFIG.Dice.D20Roll.toMessage([roll], messageData, { create: true });
    return { message, usageMessage, actor, item };
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
    if (!remember(roll.id)) {
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: true, duplicate: true, id: roll.id, at: Date.now() });
      return;
    }
    const message = await ChatMessage.create({
      speaker: getSpeaker(roll.character),
      content: buildContent(roll),
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

  async function handleWebSocketRoll(event) {
    const id = event?.data?.rollId || null;
    if (!id) throw new Error("WebSocket event is missing rollId");
    if (seen.has(id)) {
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: true, duplicate: true, id, at: Date.now() });
      return;
    }
    remember(id);
    try {
      const result = await postNativeAttack(event);
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", {
        ok: true, id, messageId: result.message?.id || null,
        usageMessageId: result.usageMessage?.id || null,
        native: true, at: Date.now()
      });
      log("Posted native D&D5e attack", {
        character: result.actor.name, item: result.item.name,
        total: event.data.rolls?.[0]?.result?.total, messageId: result.message?.id
      });
    } catch (error) {
      seen.delete(id);
      console.error(`${MODULE_ID} | Native WebSocket roll failed`, { id, reason: String(error?.message || error) });
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", {
        ok: false, id, reason: String(error?.message || error), native: true, at: Date.now()
      });
    }
  }

  Hooks.once("ready", () => {
    document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_PING", () => {
      emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_MODULE_READY", {
        ok: true, moduleId: MODULE_ID, version: MODULE_VERSION,
        user: game.user?.name, isGM: !!game.user?.isGM, world: game.world?.id, at: Date.now()
      });
    });

    document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_ROLL", event => {
      const roll = parseEventDetail(event.detail);
      if (!roll) {
        emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: false, reason: "bad-event-detail", at: Date.now() });
        return;
      }
      postRoll(roll).catch(err => {
        console.error(`${MODULE_ID} | Failed to post DDB roll`, { id: roll?.id || null, title: roll?.title || null, reason: String(err?.message || err) });
        emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: false, reason: String(err?.message || err), id: roll?.id || null, at: Date.now() });
      });
    });

    document.addEventListener("DDB_DIRECT_ROLL_BRIDGE_WS_ROLL", event => {
      const payload = parseEventDetail(event.detail);
      if (!payload) {
        emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_ACK", { ok: false, reason: "bad-ws-event-detail", at: Date.now() });
        return;
      }
      handleWebSocketRoll(payload);
    });

    emitExtensionEvent("DDB_DIRECT_ROLL_BRIDGE_MODULE_READY", {
      ok: true, moduleId: MODULE_ID, version: MODULE_VERSION,
      user: game.user?.name, isGM: !!game.user?.isGM, world: game.world?.id, at: Date.now()
    });
    log("Ready. Waiting for D&D Beyond WebSocket rolls and legacy DOM fallback.");
  });
})();
