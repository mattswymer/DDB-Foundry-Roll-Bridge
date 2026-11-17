const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

let createMockChatMessage;\n\nclass MockRoll {
  constructor(formula, data = {}) {
    this.formula = formula; this.data = data;
    this.terms = [...formula.matchAll(/(\\d*)d(\\d+)(kh1|kl1)?/gi)].map(m => ({ class:"Die", number:Number(m[1]||1), faces:Number(m[2]), results:[], evaluated:false }));
    this.total = null; this.evaluated = false;
  }
  toJSON() { return { class:"Roll", formula:this.formula, terms:this.terms.map(t=>({...t,results:[...t.results]})), options:{}, evaluated:this.evaluated, total:this.total }; }
  static fromData(data) {
    const roll = new MockRoll(data.formula); roll.terms=data.terms; roll.evaluated=data.evaluated;
    const dice = roll.terms.reduce((s,t)=>s+t.results.filter(r=>r.active!==false).reduce((n,r)=>n+r.result,0),0);
    const constants = data.formula.replace(/\\d*d\\d+(?:kh1|kl1)?/gi,"").replace(/\\s+/g,"") || "0";
    roll.total = dice + Function("return ("+constants+")")(); return roll;
  }
  async toMessage(messageData, options={}) {
    return createMockChatMessage({...messageData,content:`<div class="dice-roll"><div class="dice-formula">${this.formula}</div><div class="dice-total">${this.total}</div></div>`,roll:this,create:options.create});
  }
}

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
    console: { debug() {}, info() {}, warn() {}, error() {} },
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
  createMockChatMessage = async data => { const message = { id: `message-${messages.length+1}`, ...data }; messages.push(message); return message; };
  sandbox.Roll = MockRoll;
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

test('standalone custom d100 roll creates one native Foundry Roll without an actor mapping', async () => {
  const h = setupReceiver();
  const event = customD100Event();
  await h.send(event);
  await h.send(event);

  assert.equal(h.messages.length, 1);
  const [message] = h.messages;
  assert.match(message.content, /1d100/);
  assert.match(message.content, />73</);
  assert.equal(message.roll.formula, '1d100');
  assert.equal(message.roll.total, 73);
  assert.equal(message.roll.terms[0].results[0].result, 73);
  assert.equal(message.flags['ddb-direct-roll-bridge'].ddbRollId, 'custom-d100-001');
  assert.equal(message.flags['ddb-direct-roll-bridge'].source, 'ddb-websocket-custom');
  assert.equal(message.flags['ddb-direct-roll-bridge'].fallback, undefined);
  assert.equal(h.acknowledgements.filter(ack => ack.ok).length, 2);
  assert.equal(h.acknowledgements[0].native, true);
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
  assert.match(h.messages[0].content, /1d6 \\+ 1d4/);
  assert.match(h.messages[0].content, />7</);
  assert.equal(h.messages[0].roll.formula, '1d6 + 1d4');
  assert.deepEqual(h.messages[0].roll.terms.map(term => term.results[0].result), [4, 3]);
  assert.equal(h.messages[0].roll.total, 7);
  assert.equal(h.messages[0].flags['ddb-direct-roll-bridge'].source, 'ddb-websocket-custom');
  assert.equal(h.messages[0].flags['ddb-direct-roll-bridge'].ddbRollId, 'custom-mixed-001');
});
