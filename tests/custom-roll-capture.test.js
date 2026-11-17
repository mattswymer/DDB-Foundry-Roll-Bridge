const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test("forwards a fulfilled standalone custom roll with D&D Beyond's confirmed persist flag", () => {
  const posted = [];
  const listeners = new Map();

  class NativeWebSocket {
    constructor() {
      this.readyState = 1;
      this.binaryType = 'blob';
      this.listeners = new Map();
    }
    addEventListener(name, callback) {
      const list = this.listeners.get(name) || [];
      list.push(callback);
      this.listeners.set(name, list);
    }
    send(data) {
      this.lastSent = data;
      return undefined;
    }
  }

  const window = {
    WebSocket: NativeWebSocket,
    location: { origin: 'https://www.dndbeyond.com', href: 'https://www.dndbeyond.com/characters/1' },
    __ddbObservedSockets: [],
    addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(message) { posted.push(message); }
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../chrome-extension/ddb-websocket-main.js'), 'utf8'),
    { window, URL, Set, WeakSet, Proxy, Reflect, Date, console },
    { filename: 'ddb-websocket-main.js' }
  );

  const socket = new window.WebSocket('wss://game.dndbeyond.com/socket');
  const customRoll = {
    eventType: 'dice/roll/fulfilled',
    data: {
      rollId: 'standalone-custom-d100',
      persist: true,
      action: 'Custom Roll',
      rolls: [{
        rollType: 'roll',
        diceNotation: { set: [{ count: 1, dieType: 'd100' }], constant: 0 },
        result: { values: [63], total: 63 }
      }]
    }
  };

  socket.send(JSON.stringify(customRoll));

  const forwarded = posted.find(message =>
    message?.source === 'ddb-foundry-roll-bridge' &&
    message?.type === 'DDB_WS_ROLL' &&
    message?.payload?.data?.rollId === 'standalone-custom-d100'
  );

  assert.ok(forwarded, 'custom roll should be published to the extension content script');
  assert.equal(forwarded.direction, 'outgoing');
  assert.equal(forwarded.payload.data.persist, true);
  assert.equal(forwarded.payload.data.rolls[0].result.total, 63);
});
