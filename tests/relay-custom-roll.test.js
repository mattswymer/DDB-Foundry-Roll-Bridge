const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('direct Cloud Relay forwards a fulfilled custom roll to the shared Foundry receiver event', async () => {
  const hooks = new Map();
  const dispatched = [];
  const sockets = [];

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(name, callback) {
      const list = this.listeners.get(name) || [];
      list.push(callback);
      this.listeners.set(name, list);
    }
    send(value) { this.sent.push(value); }
    close() {}
    emit(name, value) {
      for (const callback of this.listeners.get(name) || []) callback(value);
    }
  }

  class MockCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }

  const sandbox = {
    Hooks: {
      once(name, callback) { hooks.set(name, callback); }
    },
    game: {
      user: { isGM: true },
      settings: {
        register() {},
        registerMenu() {},
        get(_module, key) {
          if (key === 'relayAdminKey') return 'test-admin-key';
          if (key === 'activeCampaignProfile') return 'campaign-1';
          if (key === 'campaignProfiles') return [{ id: 'campaign-1', gameId: '123456' }];
          return '';
        },
        async set() {}
      }
    },
    foundry: {
      applications: {
        api: {
          ApplicationV2: class {},
          HandlebarsApplicationMixin: Base => Base
        }
      },
      utils: { randomID: () => 'test-id' }
    },
    document: {
      querySelector: () => null,
      createTextNode: value => ({ textContent: value }),
      dispatchEvent: event => { dispatched.push(event); }
    },
    CustomEvent: MockCustomEvent,
    WebSocket: MockWebSocket,
    fetch: async () => ({
      ok: true,
      async json() { return { active: true, gameId: '123456' }; }
    }),
    clearTimeout() {},
    setTimeout() { return 1; },
    console,
    window: { confirm: () => true }
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../foundry-module/ddb-direct-roll-bridge/scripts/relay.js'), 'utf8'),
    sandbox,
    { filename: 'relay.js' }
  );

  hooks.get('init')();
  await hooks.get('ready')();
  assert.equal(sockets.length, 1, 'Foundry module should open the direct relay WebSocket');

  const socket = sockets[0];
  socket.emit('open');
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'auth', key: 'test-admin-key' });

  const customRoll = {
    eventType: 'dice/roll/fulfilled',
    data: {
      rollId: 'relay-custom-d100-001',
      persist: true,
      action: 'custom',
      context: { name: 'Tyndall', messageScope: 'gameId' },
      rolls: [{
        rollType: 'roll',
        diceNotation: { set: [{ count: 1, dieType: 'd100', operation: 0 }], constant: 0 },
        result: { values: [86], total: 86, constant: 0 }
      }]
    }
  };

  socket.emit('message', {
    data: JSON.stringify({ type: 'ddb-event', payload: customRoll })
  });

  const delivered = dispatched.find(event => event.type === 'DDB_DIRECT_ROLL_BRIDGE_WS_ROLL');
  assert.ok(delivered, 'relay should dispatch the shared receiver event');
  assert.deepEqual(JSON.parse(delivered.detail), customRoll);
});
