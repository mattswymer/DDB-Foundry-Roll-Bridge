const test = require('node:test');
const assert = require('node:assert/strict');
const { RollCoordinator } = require('../chrome-extension/roll-coordinator.js');

function setup({ healthy = true, graceMs = 1000, ackTimeoutMs = 15000, retentionMs = 30000 } = {}) {
  let time = 0;
  const submitted = [], suppressed = [];
  const matches = (a, b) => a.total === b.total && a.character === b.character && a.action === b.action;
  const coordinator = new RollCoordinator({
    matches, now: () => time, graceMs, ackTimeoutMs, retentionMs,
    onSubmitDom: (roll, meta) => submitted.push({ roll, ...meta }),
    onSuppressDom: (roll, meta) => suppressed.push({ roll, ...meta })
  });
  coordinator.setHookHealthy(healthy);
  return {
    coordinator, submitted, suppressed,
    advance(ms) { time += ms; coordinator.tick(); },
    roll(extra = {}) { return { total: 17, character: "Fennorin", action: "Shortsword", ...extra }; }
  };
}

test("WebSocket first: DOM waits and is suppressed after delivery", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("dom1", h.roll());
  h.coordinator.acknowledge("ws1", true);
  assert.equal(h.suppressed.length, 1);
  assert.equal(h.submitted.length, 0);
});

test("DOM first: waits for matching WebSocket and successful delivery", () => {
  const h = setup();
  h.coordinator.addDom("dom1", h.roll());
  h.coordinator.addWebSocket("ws1", h.roll());
  assert.equal(h.submitted.length, 0);
  h.coordinator.acknowledge("ws1", true);
  assert.equal(h.suppressed.length, 1);
});

test("WebSocket-only roll creates no DOM fallback", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.acknowledge("ws1", true);
  assert.equal(h.submitted.length, 0);
});

test("DOM-only roll submits when grace expires", () => {
  const h = setup();
  h.coordinator.addDom("dom1", h.roll());
  h.advance(999);
  assert.equal(h.submitted.length, 0);
  h.advance(1);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].reason, "grace-expired");
});

test("DOM submits immediately when WebSocket hook is unavailable", () => {
  const h = setup({ healthy: false });
  h.coordinator.addDom("dom1", h.roll());
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].reason, "websocket-hook-unavailable");
});

test("two identical WebSocket rolls pair one-to-one with two DOM cards", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addWebSocket("ws2", h.roll());
  h.coordinator.addDom("dom1", h.roll());
  h.coordinator.addDom("dom2", h.roll());
  h.coordinator.acknowledge("ws2", true);
  h.coordinator.acknowledge("ws1", true);
  assert.deepEqual(new Set(h.suppressed.map(x => x.wsId)), new Set(["ws1", "ws2"]));
  assert.equal(h.suppressed.length, 2);
});

test("one WebSocket claim cannot suppress two identical DOM cards", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("dom1", h.roll());
  h.coordinator.addDom("dom2", h.roll());
  h.coordinator.acknowledge("ws1", true);
  assert.equal(h.suppressed.length, 1);
  h.advance(1000);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].cardId, "dom2");
});

test("routing failure releases a held DOM card", () => {
  const h = setup();
  h.coordinator.addDom("dom1", h.roll());
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.acknowledge("ws1", false);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0].reason, "websocket-failed");
});

test("failure ACK before DOM arrival submits the later DOM card", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.acknowledge("ws1", false);
  h.coordinator.addDom("dom1", h.roll());
  assert.equal(h.submitted.length, 1);
});

test("success ACK before DOM arrival suppresses the later DOM card", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.acknowledge("ws1", true);
  h.coordinator.addDom("dom1", h.roll());
  assert.equal(h.suppressed.length, 1);
});

test("late WebSocket event is suppressed after DOM fallback was submitted", () => {
  const h = setup();
  h.coordinator.addDom("dom1", h.roll());
  h.advance(1000);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.coordinator.addWebSocket("ws-late", h.roll()).action, "suppress-websocket");
});

test("hook becoming unhealthy releases all waiting DOM cards", () => {
  const h = setup();
  h.coordinator.addDom("dom1", h.roll());
  h.coordinator.addDom("dom2", h.roll({ total: 18 }));
  h.coordinator.setHookHealthy(false);
  assert.equal(h.submitted.length, 2);
});

test("duplicate DOM mutations and duplicate WebSocket IDs are idempotent", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  assert.equal(h.coordinator.addWebSocket("ws1", h.roll()).action, "duplicate-websocket");
  h.coordinator.addDom("dom1", h.roll());
  assert.equal(h.coordinator.addDom("dom1", h.roll()).action, "duplicate-dom");
  h.coordinator.acknowledge("ws1", true);
  assert.equal(h.suppressed.length, 1);
});

test("different signatures do not match", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("dom1", h.roll({ total: 4 }));
  h.coordinator.acknowledge("ws1", true);
  h.advance(1000);
  assert.equal(h.suppressed.length, 0);
  assert.equal(h.submitted.length, 1);
});


test("DOM-first pairing preserves WebSocket-to-DOM matcher argument order", () => {
  let time = 0;
  const submitted = [], suppressed = [];
  const coordinator = new RollCoordinator({
    matches: (ws, dom) => ws.kind === "websocket" &&
      dom.kind === "dom" &&
      ws.total === dom.total &&
      ws.character === dom.character &&
      ws.action === dom.action,
    now: () => time,
    graceMs: 1000,
    ackTimeoutMs: 15000,
    onSubmitDom: (roll, meta) => submitted.push({ roll, ...meta }),
    onSuppressDom: (roll, meta) => suppressed.push({ roll, ...meta })
  });
  coordinator.setHookHealthy(true);
  coordinator.addDom("dom-directional", {
    kind: "dom", total: 18, character: "Barfolomew Wells", action: "Dagger"
  });
  coordinator.addWebSocket("ws-directional", {
    kind: "websocket", total: 18, character: "Barfolomew Wells", action: "Dagger"
  });
  coordinator.acknowledge("ws-directional", true);
  assert.equal(suppressed.length, 1);
  assert.equal(submitted.length, 0);
});

test("old coordinator records are pruned", () => {
  const h = setup({ retentionMs: 100 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.acknowledge("ws1", true);
  h.advance(101);
  assert.equal(h.coordinator.addWebSocket("ws1", h.roll()).action, "route-websocket");
});
