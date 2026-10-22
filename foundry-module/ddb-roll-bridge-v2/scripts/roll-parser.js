/**
 * Pure D&D Beyond game-log normalization.
 * Never evaluates dice: DDB's fulfilled event is the authoritative result.
 */
export const ROLL_EVENT = "dice/roll/fulfilled";

export function rollNotation(roll = {}) {
  if (typeof roll.diceNotationStr === "string" && roll.diceNotationStr.trim()) {
    return roll.diceNotationStr.trim();
  }
  const sets = (roll.diceNotation?.set ?? []).map((set) => {
    const count = Number(set?.count ?? 0);
    const dieType = String(set?.dieType ?? "");
    return count > 0 && /^d\d+$/i.test(dieType) ? `${count}${dieType}` : "";
  }).filter(Boolean);
  const constant = Number(roll.diceNotation?.constant ?? 0);
  const dice = sets.join(" + ");
  if (!dice) return Number.isFinite(constant) ? String(constant) : "";
  if (!constant) return dice;
  return `${dice} ${constant > 0 ? "+" : "-"} ${Math.abs(constant)}`;
}

export function classifyRoll(roll = {}, action = "") {
  const type = `${roll.rollType ?? ""} ${roll.rollKind ?? ""}`.toLowerCase();
  const actionType = String(action ?? "").toLowerCase();
  if (/initiative/.test(type) || /^initiative$/.test(actionType)) return "initiative";
  if (/saving throw|\bsave\b|\bsaving\b/.test(type)) return "save";
  if (/\bheal(?:ing)?\b|hit points restored/.test(type)) return "healing";
  if (/damage|\bforce\b|\bslashing\b|\bpiercing\b|\bbludgeoning\b|\bfire\b|\bcold\b|\blightning\b|\bthunder\b|\bpoison\b|\bpsychic\b|\bradiant\b|\bnecrotic\b|\bacid\b/.test(type)) return "damage";
  if (/to hit|attack roll|\battack\b/.test(type)) return "attack";
  if (/ability check|skill check|\bcheck\b/.test(type)) return "check";
  return "roll";
}

export function normalizeMessage(message) {
  if (!message || message.eventType !== ROLL_EVENT || !message.id) return null;
  const data = message.data ?? {};
  const action = String(data.action ?? "D&D Beyond Roll").trim() || "D&D Beyond Roll";
  const character = String(data.context?.name ?? "Unknown Character").trim() || "Unknown Character";
  const rolls = (Array.isArray(data.rolls) ? data.rolls : []).map((roll, index) => {
    const result = roll?.result ?? {};
    const values = Array.isArray(result.values) ? result.values.map(Number).filter(Number.isFinite) : [];
    return {
      index,
      rollType: String(roll?.rollType ?? "roll"),
      rollKind: String(roll?.rollKind ?? ""),
      category: classifyRoll(roll, action),
      formula: rollNotation(roll),
      total: result.total !== null && result.total !== undefined && Number.isFinite(Number(result.total)) ? Number(result.total) : null,
      breakdown: String(result.text ?? ""),
      values,
      diceNotation: roll?.diceNotation ?? null,
      diceNotationStr: roll?.diceNotationStr ?? null
    };
  });
  if (!rolls.length) return null;
  return {
    id: String(message.id),
    gameId: String(message.gameId ?? ""),
    userId: String(message.userId ?? ""),
    entityId: String(message.entityId ?? ""),
    entityType: String(message.entityType ?? ""),
    eventType: message.eventType,
    timestamp: Number(message.dateTime) || Date.now(),
    character,
    action,
    rolls,
    source: data.__b20Override__ === true ? "beyond20" : "dndbeyond",
    raw: message
  };
}
