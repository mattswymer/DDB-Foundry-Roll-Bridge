const test = require('node:test');
const assert = require('node:assert/strict');
const { RollCoordinator } = require('../chrome-extension/roll-coordinator.js');

function setup({ healthy = true, graceMs = 1000, ackTimeoutMs = 15000, statusRetryMs = 2000, retentionMs = 30000 } = {}) {
  let time = 0;
  const submitted = [], suppressed = [], statusQueries = [];
  const matches = (a, b) => a.total === b.total && a.character === b.character && a.action === b.action;
  const coordinator = new RollCoordinator({
    matches, now: () => time, graceMs, ackTimeoutMs, statusRetryMs, retentionMs,
    onAckTimeout: (id, meta) => statusQueries.push({ id, ...meta }),
    onSubmitDom: (roll, meta) => submitted.push({ roll, ...meta }),
    onSuppressDom: (roll, meta) => suppressed.push({ roll, ...meta })
  });
  coordinator.setHookHealthy(healthy);
  return {
    coordinator, submitted, suppressed, statusQueries,
    advance(ms) { time += ms; coordinator.tick(); },
    roll(extra = {}) { return { total: 17, character: "Fennorin", action: "Shortsword", ...extra }; }
  };
}

test("WebSocket first: every distinct DOM surface is suppressed after delivery", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.coordinator.acknowledge("ws1", true);
  assert.deepEqual(h.suppressed.map(x => x.cardId).sort(), ["log1", "popup1"]);
  assert.equal(h.submitted.length, 0);
});

test("DOM surfaces first: one WebSocket claim pairs and suppresses both", () => {
  const h = setup();
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  const decision = h.coordinator.addWebSocket("ws1", h.roll());
  assert.equal(decision.domIds.length, 2);
  h.coordinator.acknowledge("ws1", true);
  assert.equal(h.suppressed.length, 2);
  assert.equal(h.submitted.length, 0);
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

test("two identical WebSocket rolls pair FIFO independently on popup and log surfaces", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addWebSocket("ws2", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("popup2", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.coordinator.addDom("log2", h.roll(), "log");
  h.coordinator.acknowledge("ws2", true);
  h.coordinator.acknowledge("ws1", true);
  assert.equal(h.suppressed.length, 4);
  assert.deepEqual(
    Object.fromEntries(h.suppressed.map(x => [x.cardId, x.wsId])),
    { popup1: "ws1", popup2: "ws2", log1: "ws1", log2: "ws2" }
  );
  assert.equal(h.submitted.length, 0);
});

test("one failed claim submits one fallback and suppresses its other surface", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.coordinator.acknowledge("ws1", false);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.suppressed.length, 1);
});

test("late second surface is suppressed after successful delivery", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.acknowledge("ws1", true);
  const decision = h.coordinator.addDom("log1", h.roll(), "log");
  assert.equal(decision.action, "suppress-dom");
  assert.equal(h.suppressed.length, 2);
  assert.equal(h.submitted.length, 0);
});

test("late second surface cannot create a second fallback after failed delivery", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.acknowledge("ws1", false);
  const decision = h.coordinator.addDom("log1", h.roll(), "log");
  assert.equal(decision.action, "suppress-dom");
  assert.equal(h.submitted.length, 1);
  assert.equal(h.suppressed.length, 1);
});

test("routing failure before DOM arrival submits only the first later surface", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.acknowledge("ws1", false);
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  assert.equal(h.submitted.length, 1);
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

test("hook becoming unhealthy checks Foundry before submitting one fallback", () => {
  const h = setup({ statusRetryMs: 20 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.coordinator.setHookHealthy(false);
  assert.equal(h.statusQueries.length, 1);
  assert.equal(h.submitted.length, 0);
  h.coordinator.resolveStatus("ws1", "unknown");
  h.advance(20);
  h.coordinator.resolveStatus("ws1", "unknown");
  assert.equal(h.submitted.length, 1);
  assert.equal(h.suppressed.length, 1);
});

test("hook becoming unhealthy does not bypass an already delivered claim", () => {
  const h = setup();
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.acknowledge("ws1", true);
  h.coordinator.setHookHealthy(false);
  h.coordinator.addDom("log1", h.roll(), "log");
  assert.equal(h.submitted.length, 0);
  assert.equal(h.suppressed.length, 2);
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
  }, "log");
  coordinator.addWebSocket("ws-directional", {
    kind: "websocket", total: 18, character: "Barfolomew Wells", action: "Dagger"
  });
  coordinator.acknowledge("ws-directional", true);
  assert.equal(suppressed.length, 1);
  assert.equal(submitted.length, 0);
});

test("unconfirmed delivery submits at most one fallback after status checks", () => {
  const h = setup({ ackTimeoutMs: 100, statusRetryMs: 20 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.advance(100);
  assert.equal(h.submitted.length, 0);
  h.coordinator.resolveStatus("ws1", "unknown");
  h.advance(20);
  h.coordinator.resolveStatus("ws1", "unknown");
  assert.equal(h.submitted.length, 1);
  assert.equal(h.suppressed.length, 1);
});

test("old coordinator records are pruned", () => {
  const h = setup({ retentionMs: 100 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.acknowledge("ws1", true);
  h.advance(101);
  assert.equal(h.coordinator.addWebSocket("ws1", h.roll()).action, "route-websocket");
});


test("ack timeout queries Foundry and suppresses DOM when the native message exists", () => {
  const h = setup({ ackTimeoutMs: 100 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.advance(100);
  assert.equal(h.statusQueries.length, 1);
  assert.equal(h.statusQueries[0].id, "ws1");
  assert.equal(h.submitted.length, 0);
  assert.equal(h.coordinator.resolveStatus("ws1", "exists").action, "suppress-dom");
  assert.equal(h.suppressed.length, 2);
  assert.equal(h.submitted.length, 0);
});

test("pending Foundry processing is polled again without submitting a fallback", () => {
  const h = setup({ ackTimeoutMs: 100, statusRetryMs: 20 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.advance(100);
  assert.equal(h.statusQueries.length, 1);
  assert.equal(h.coordinator.resolveStatus("ws1", "pending").action, "retry-status");
  h.advance(20);
  assert.equal(h.statusQueries.length, 2);
  assert.equal(h.submitted.length, 0);
  assert.equal(h.coordinator.resolveStatus("ws1", "exists").action, "suppress-dom");
  assert.equal(h.suppressed.length, 1);
});

test("unknown Foundry status is checked twice before one DOM fallback is submitted", () => {
  const h = setup({ ackTimeoutMs: 100, statusRetryMs: 20 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.advance(100);
  assert.equal(h.coordinator.resolveStatus("ws1", "unknown").action, "retry-status");
  h.advance(20);
  assert.equal(h.statusQueries.length, 2);
  assert.equal(h.coordinator.resolveStatus("ws1", "unknown").action, "submit-fallback");
  assert.equal(h.submitted.length, 1);
  assert.equal(h.suppressed.length, 1);
});

test("late final acknowledgment wins while a status query is in flight", () => {
  const h = setup({ ackTimeoutMs: 100 });
  h.coordinator.addWebSocket("ws1", h.roll());
  h.coordinator.addDom("popup1", h.roll(), "popup");
  h.coordinator.addDom("log1", h.roll(), "log");
  h.advance(100);
  assert.equal(h.coordinator.acknowledge("ws1", true).action, "suppress-dom");
  assert.equal(h.suppressed.length, 2);
  assert.equal(h.submitted.length, 0);
  assert.equal(h.coordinator.resolveStatus("ws1", "unknown").action, "ignore-status");
});
