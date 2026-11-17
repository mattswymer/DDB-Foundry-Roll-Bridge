const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setupReceiver() {
  const listeners = new Map();
  const messages = [];
  const acknowledgements = [];
  let ready;
  const document = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    dispatchEvent(event) {
      if (event.type === 'DDB_DIRECT_ROLL_BRIDGE_ACK') acknowledgements.push(JSON.parse(event.detail));
    },
    createElement() {
      let value = '';
      return {
        set textContent(next) { value = String(next); },
        get innerHTML() {
          return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
      };
    }
  };
  class CustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const sandbox = {
    document,
    CustomEvent,
    Hooks: { once(name, callback) { if (name === 'ready') ready = callback; } },
    game: {
      modules: { get: () => ({ version: '1.1.2' }) },
      user: { isGM: true, name: 'GM' },
      messages: { find: () => null, get: () => null },
      actors: [],
      settings: { get: () => ({}) },
      world: { id: 'test-world' }
    },
    ChatMessage: {
      getSpeaker: () => ({ alias: 'D&D Beyond' }),
      getWhisperRecipients: () => [],
      async create(data) {
        const message = { id: `message-${messages.length + 1}`, ...data };
        messages.push(message);
        return message;
      }
    },
    console: { debug() {}, warn() {}, error() {} },
    Date,
    Set,
    Map,
    Array,
    Number,
    String,
    JSON,
    Math,
    Promise
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../foundry-module/ddb-direct-roll-bridge/scripts/receiver.js'), 'utf8'),
    sandbox,
    { filename: 'receiver.js' }
  );
  ready();
  return {
    messages,
    acknowledgements,
    async send(payload) {
      listeners.get('DDB_DIRECT_ROLL_BRIDGE_WS_ROLL')({
        detail: JSON.stringify(payload)
      });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

function customD100Event() {
  return {
    eventType: 'dice/roll/fulfilled',
    data: {
      rollId: 'custom-d100-001',
      action: 'custom',
      context: { entityId: '101018406', name: 'Tyndall', messageScope: 'gameId' },
      context: {},
      rolls: [{
        rollType: 'roll',
        diceNotation: {
          set: [{ count: 1, dice: [{ dieType: 'd100', dieValue: 73 }], dieType: 'd100', operation: 0 }],
          constant: 0
        },
        result: { values: [73], constant: 0, text: '73', total: 73 }
      }]
    }
  };
}

test('standalone custom d100 roll creates one Foundry fallback card without an actor mapping', async () => {
  const h = setupReceiver();
  const event = customD100Event();
  await h.send(event);
  await h.send(event);

  assert.equal(h.messages.length, 1);
  const [message] = h.messages;
  assert.match(message.content, /1d100/);
  assert.match(message.content, /d100: 73/);
  assert.match(message.content, />73</);
  assert.equal(message.flags['ddb-direct-roll-bridge'].ddbRollId, 'custom-d100-001');
  assert.equal(message.flags['ddb-direct-roll-bridge'].fallback, true);
  assert.match(message.content, /Tyndall/);
  assert.equal(message.flags['ddb-direct-roll-bridge'].failureReason, 'Standalone D&D Beyond custom dice roll');
  assert.equal(message.flags['ddb-direct-roll-bridge'].source, 'ddb-websocket-fallback');
  assert.equal(h.acknowledgements.filter(ack => ack.ok).length, 2);
  assert.equal(h.acknowledgements[1].duplicate, true);
});

test('malformed custom dice data is not turned into an empty fallback card', async () => {
  const h = setupReceiver();
  const event = customD100Event();
  event.data.rolls[0].diceNotation.set[0].dieType = '<img>';
  await h.send(event);

  assert.equal(h.messages.length, 0);
  assert.equal(h.acknowledgements.length, 1);
  assert.equal(h.acknowledgements[0].ok, false);
});

test('standalone custom mixed dice roll preserves both dice sets and total', async () => {
  const h = setupReceiver();
  const event = customD100Event();
  event.data.rollId = 'custom-mixed-001';
  event.data.rolls[0].diceNotation.set = [
    { count: 1, dice: [{ dieType: 'd6', dieValue: 4 }], dieType: 'd6', operation: 0 },
    { count: 1, dice: [{ dieType: 'd4', dieValue: 3 }], dieType: 'd4', operation: 0 }
  ];
  event.data.rolls[0].result = { values: [4, 3], constant: 0, text: '4+3', total: 7 };
  await h.send(event);

  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, /1d6 \+ 1d4/);
  assert.match(h.messages[0].content, /d6: 4/);
  assert.match(h.messages[0].content, /d4: 3/);
  assert.match(h.messages[0].content, />7</);
  assert.equal(h.messages[0].flags['ddb-direct-roll-bridge'].ddbRollId, 'custom-mixed-001');
});
