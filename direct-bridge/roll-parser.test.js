import test from "node:test";
import assert from "node:assert/strict";
import { classifyRoll, normalizeMessage, rollNotation } from "../foundry-module/ddb-roll-bridge-v2/scripts/roll-parser.js";

test("reconstructs notation when DDB omits diceNotationStr", () => {
  assert.equal(rollNotation({
    diceNotation: { constant: 4, set: [{ count: 2, dieType: "d6" }, { count: 1, dieType: "d4" }] }
  }), "2d6 + 1d4 + 4");
  assert.equal(rollNotation({ diceNotation: { constant: -2, set: [{ count: 1, dieType: "d8" }] } }), "1d8 - 2");
});

test("classifies the common roll families", () => {
  assert.equal(classifyRoll({ rollType: "to hit" }), "attack");
  assert.equal(classifyRoll({ rollType: "to hit" }, "Fire Bolt"), "attack");
  assert.equal(classifyRoll({ rollType: "damage" }), "damage");
  assert.equal(classifyRoll({ rollType: "healing" }), "healing");
  assert.equal(classifyRoll({ rollType: "saving throw" }), "save");
  assert.equal(classifyRoll({ rollType: "initiative" }), "initiative");
  assert.equal(classifyRoll({ rollType: "ability check" }), "check");
});

test("normalizes a real-shaped fulfilled event without changing dice totals", () => {
  const event = {
    id: "event-123",
    gameId: "456",
    userId: "789",
    entityId: "1234567",
    eventType: "dice/roll/fulfilled",
    dateTime: "1784681529261",
    data: {
      action: "Longsword",
      context: { name: "A Fighter" },
      rolls: [
        {
          rollType: "to hit",
          diceNotation: { constant: 5, set: [{ count: 1, dieType: "d20" }] },
          result: { total: 22, text: "17", values: [17] }
        },
        {
          rollType: "slashing",
          diceNotation: { constant: 3, set: [{ count: 1, dieType: "d8" }] },
          result: { total: 8, text: "5", values: [5] }
        }
      ]
    }
  };
  const normalized = normalizeMessage(event);
  assert.equal(normalized.id, "event-123");
  assert.equal(normalized.entityId, "1234567");
  assert.equal(normalized.character, "A Fighter");
  assert.equal(normalized.rolls[0].category, "attack");
  assert.equal(normalized.rolls[0].formula, "1d20 + 5");
  assert.equal(normalized.rolls[0].total, 22);
  assert.deepEqual(normalized.rolls[0].values, [17]);
  assert.equal(normalized.rolls[1].category, "damage");
  assert.equal(normalized.rolls[1].total, 8);
});

test("ignores non-fulfilled and malformed events", () => {
  assert.equal(normalizeMessage({ id: "1", eventType: "dice/roll/pending", data: { rolls: [{}] } }), null);
  assert.equal(normalizeMessage({ eventType: "dice/roll/fulfilled", data: { rolls: [{}] } }), null);
  const missingTotal = normalizeMessage({ id: "no-total", eventType: "dice/roll/fulfilled", data: { rolls: [{ rollType: "check" }] } });
  assert.equal(missingTotal.rolls[0].total, null);
});
