(() => {
  "use strict";

  // Run in D&D Beyond's MAIN world at document_start so the page's WebSocket
  // constructor is wrapped before the application creates its sockets.
  if (window.__ddbWebSocketCaptureInstalled) return;
  window.__ddbWebSocketCaptureInstalled = true;

  const NativeWebSocket = window.WebSocket;
  const MAX_CAPTURED_EVENTS = 200;
  const capture = [];
  window.__ddbCapture = capture;

  function inspectMessage(event) {
    // D&D Beyond's roll frames are plain-text JSON. Ignore binary/non-JSON frames.
    if (typeof event.data !== "string") return;

    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    if (!payload || typeof payload !== "object") return;
    if (typeof payload.eventType !== "string" ||
        !/^dice\/roll(?:\/|$)/.test(payload.eventType)) return;

    // Keep the parsed source event intact. Bound memory use during long sessions.
    capture.push(payload);
    if (capture.length > MAX_CAPTURED_EVENTS) capture.splice(0, capture.length - MAX_CAPTURED_EVENTS);

    const firstRoll = Array.isArray(payload.data?.rolls) ? payload.data.rolls[0] : null;
    console.info("[DDB Roll Capture]", {
      eventType: payload.eventType,
      rollId: payload.data?.rollId ?? null,
      rollType: firstRoll?.rollType ?? null,
      action: payload.data?.action ?? null,
      messageScope: payload.messageScope ?? payload.data?.context?.messageScope ?? null
    });
  }

  // Proxy preserves the native constructor behavior and static constants while
  // attaching one passive observer to every newly created WebSocket.
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      socket.addEventListener("message", inspectMessage);
      return socket;
    }
  });

  console.info("[DDB Roll Capture] WebSocket capture hook installed");
})();
