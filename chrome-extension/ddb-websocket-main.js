(() => {
  "use strict";

  // Run in D&D Beyond's MAIN world at document_start so the page's WebSocket
  // constructor is wrapped before the application creates its sockets.
  if (window.__ddbWebSocketCaptureInstalled) return;
  window.__ddbWebSocketCaptureInstalled = true;

  const NativeWebSocket = window.WebSocket;
  const MAX_CAPTURED_EVENTS = 200;
  const capture = [];
  const diagnostics = {
    socketsCreated: 0,
    listenersAttached: 0,
    messagesReceived: 0,
    textMessages: 0,
    jsonMessages: 0,
    rollEventsCaptured: 0,
    socketEndpoints: [],
    lastMessageAt: null
  };

  window.__ddbCapture = capture;
  window.__ddbWsDiagnostics = diagnostics;

  function inspectMessage(event) {
    diagnostics.messagesReceived += 1;
    diagnostics.lastMessageAt = new Date().toISOString();

    // D&D Beyond's roll frames are plain-text JSON. Track but ignore binary frames.
    if (typeof event.data !== "string") return;
    diagnostics.textMessages += 1;

    let payload;
    try {
      payload = JSON.parse(event.data);
      diagnostics.jsonMessages += 1;
    } catch (_) {
      return;
    }

    if (!payload || typeof payload !== "object") return;
    if (typeof payload.eventType !== "string" ||
        !/^dice\\/roll(?:\\/|$)/.test(payload.eventType)) return;

    // Keep the parsed source event intact. Bound memory use during long sessions.
    capture.push(payload);
    if (capture.length > MAX_CAPTURED_EVENTS) capture.splice(0, capture.length - MAX_CAPTURED_EVENTS);
    diagnostics.rollEventsCaptured += 1;

    const firstRoll = Array.isArray(payload.data?.rolls) ? payload.data.rolls[0] : null;
    console.info("[DDB Roll Capture]", {
      eventType: payload.eventType,
      rollId: payload.data?.rollId ?? null,
      rollType: firstRoll?.rollType ?? null,
      action: payload.data?.action ?? null,
      messageScope: payload.messageScope ?? payload.data?.context?.messageScope ?? null
    });
  }

  // Proxy preserves native constructor behavior and static constants while
  // attaching one passive observer to every newly created WebSocket.
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      diagnostics.socketsCreated += 1;

      // Record only the endpoint, never query parameters (which may contain tokens).
      try {
        const endpoint = new URL(String(args[0]), window.location.href);
        const safeEndpoint = endpoint.origin + endpoint.pathname;
        if (!diagnostics.socketEndpoints.includes(safeEndpoint)) {
          diagnostics.socketEndpoints.push(safeEndpoint);
        }
      } catch (_) {
        // Diagnostics must never interfere with the page's WebSocket.
      }

      socket.addEventListener("message", inspectMessage);
      diagnostics.listenersAttached += 1;
      return socket;
    }
  });

  console.info("[DDB Roll Capture] WebSocket capture hook installed");
})();
