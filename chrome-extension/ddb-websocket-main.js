(() => {
  "use strict";

  if (window.__ddbWebSocketCaptureInstalled) return;
  window.__ddbWebSocketCaptureInstalled = true;

  const NativeWebSocket = window.WebSocket;
  const MAX_CAPTURED_EVENTS = 200;
  const capture = [];
  const seenMessageEvents = new WeakSet();
  const diagnostics = {
    socketsCreated: 0,
    listenersAttached: 0,
    onmessageHooksInstalled: 0,
    onmessageAssignments: 0,
    messagesReceived: 0,
    messagesSent: 0,
    textMessagesSent: 0,
    jsonMessagesSent: 0,
    textMessages: 0,
    jsonMessages: 0,
    rollEventsCaptured: 0,
    socketEndpoints: [],
    socketStates: [],
    lastMessageAt: null
  };

  window.__ddbCapture = capture;
  window.__ddbObservedSockets = [];
  window.__ddbWsDiagnostics = diagnostics;

  function inspectMessage(event) {
    if (seenMessageEvents.has(event)) return;
    seenMessageEvents.add(event);

    diagnostics.messagesReceived += 1;
    diagnostics.lastMessageAt = new Date().toISOString();

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
        !/^dice\/roll(?:\/|$)/.test(payload.eventType)) return;

    capture.push(payload);
    if (capture.length > MAX_CAPTURED_EVENTS) {
      capture.splice(0, capture.length - MAX_CAPTURED_EVENTS);
    }
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

  // Also observe the onmessage IDL property without breaking the page's handler.
  const onmessageDescriptor = Object.getOwnPropertyDescriptor(
    NativeWebSocket.prototype,
    "onmessage"
  );

  function instrumentSocket(socket, args) {
    diagnostics.socketsCreated += 1;
    window.__ddbObservedSockets.push(socket);

    try {
      const endpoint = new URL(String(args[0]), window.location.href);
      const safeEndpoint = endpoint.origin + endpoint.pathname;
      if (!diagnostics.socketEndpoints.includes(safeEndpoint)) {
        diagnostics.socketEndpoints.push(safeEndpoint);
      }
    } catch (_) {}

    socket.addEventListener("message", inspectMessage);
    diagnostics.listenersAttached += 1;

    // D&D Beyond sends roll events through this socket; observe outgoing frames too.
    const nativeSend = socket.send;
    socket.send = function(data) {
      diagnostics.messagesSent += 1;
      if (typeof data === "string") {
        diagnostics.textMessagesSent += 1;
        let payload;
        try {
          payload = JSON.parse(data);
          diagnostics.jsonMessagesSent += 1;
        } catch (_) {}

        if (payload && typeof payload === "object" &&
            typeof payload.eventType === "string" &&
            /^dice\\/roll(?:\\/|$)/.test(payload.eventType)) {
          capture.push(payload);
          if (capture.length > MAX_CAPTURED_EVENTS) {
            capture.splice(0, capture.length - MAX_CAPTURED_EVENTS);
          }
          diagnostics.rollEventsCaptured += 1;

          const firstRoll = Array.isArray(payload.data?.rolls) ? payload.data.rolls[0] : null;
          console.info("[DDB Roll Capture]", {
            direction: "outgoing",
            eventType: payload.eventType,
            rollId: payload.data?.rollId ?? null,
            rollType: firstRoll?.rollType ?? null,
            action: payload.data?.action ?? null,
            messageScope: payload.messageScope ?? payload.data?.context?.messageScope ?? null
          });
        }
      }
      return nativeSend.apply(this, arguments);
    };

    if (onmessageDescriptor?.configurable && onmessageDescriptor.set) {
      let pageHandler = null;
      try {
        Object.defineProperty(socket, "onmessage", {
          configurable: true,
          enumerable: onmessageDescriptor.enumerable,
          get() {
            return pageHandler;
          },
          set(handler) {
            diagnostics.onmessageAssignments += 1;
            pageHandler = typeof handler === "function" ? handler : null;
            onmessageDescriptor.set.call(socket, pageHandler
              ? function(event) {
                  inspectMessage(event);
                  return pageHandler.call(this, event);
                }
              : null);
          }
        });
        diagnostics.onmessageHooksInstalled += 1;
      } catch (_) {}
    }

    diagnostics.socketStates.push({
      readyState: socket.readyState,
      binaryType: socket.binaryType
    });
    return socket;
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      return instrumentSocket(socket, args);
    }
  });

  console.info("[DDB Roll Capture] WebSocket capture hook installed");
})();
