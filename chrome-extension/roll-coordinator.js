(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DDBRollCoordinator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class RollCoordinator {
    constructor({ matches, onSubmitDom, onSuppressDom, onAckTimeout, now = () => Date.now(), graceMs = 1000, ackTimeoutMs = 15000, statusRetryMs = 2000, retentionMs = 30000 } = {}) {
      if (typeof matches !== "function") throw new TypeError("matches must be a function");
      this.matches = matches;
      this.onSubmitDom = typeof onSubmitDom === "function" ? onSubmitDom : () => {};
      this.onSuppressDom = typeof onSuppressDom === "function" ? onSuppressDom : () => {};
      this.onAckTimeout = typeof onAckTimeout === "function" ? onAckTimeout : () => {};
      this.now = now;
      this.graceMs = graceMs;
      this.ackTimeoutMs = ackTimeoutMs;
      this.statusRetryMs = statusRetryMs;
      this.retentionMs = retentionMs;
      this.hookHealthy = false;
      this.domCards = new Map();
      this.wsRolls = new Map();
      this.sequence = 0;
    }

    setHookHealthy(healthy) {
      this.hookHealthy = healthy === true;
      if (!this.hookHealthy) {
        const handledClaims = new Set();
        for (const card of this.domCards.values()) {
          if (card.status !== "waiting") continue;
          const claim = card.wsId ? this.wsRolls.get(card.wsId) : null;
          if (!claim) {
            this._submit(card, "websocket-hook-unavailable");
            continue;
          }
          if (handledClaims.has(claim.id)) continue;
          handledClaims.add(claim.id);
          if (claim.status === "pending") {
            claim.status = "timed-out";
            claim.acknowledgedAt = this.now();
          }
          this._applyWsStatus(claim);
        }
      }
    }

    addDom(cardId, roll, surface = "other") {
      if (!cardId || this.domCards.has(cardId)) return { action: "duplicate-dom" };
      const now = this.now();
      const normalizedSurface = typeof surface === "string" && surface ? surface : "other";
      const card = {
        id: cardId, roll, surface: normalizedSurface, status: "waiting",
        createdAt: now, expiresAt: now + this.graceMs,
        sequence: ++this.sequence, wsId: null
      };
      this.domCards.set(cardId, card);
      const claim = this._oldestMatchingWs(roll, ["pending", "delivered", "failed", "timed-out"], normalizedSurface);
      if (claim) {
        this._pair(card, claim);
        if (!this.hookHealthy && claim.status === "pending") {
          claim.status = "timed-out";
          claim.acknowledgedAt = this.now();
        }
        this._applyWsStatus(claim);
        return {
          action: card.status === "waiting" ? "hold-dom" : card.status === "suppressed" ? "suppress-dom" : "submit-dom",
          wsId: claim.id
        };
      }
      if (!this.hookHealthy) {
        this._submit(card, "websocket-hook-unavailable");
        return { action: "submit-dom", reason: "websocket-hook-unavailable" };
      }
      return { action: "hold-dom", expiresAt: card.expiresAt };
    }

    addWebSocket(wsId, roll) {
      if (!wsId) return { action: "reject-websocket", reason: "missing-id" };
      const existing = this.wsRolls.get(wsId);
      if (existing) return { action: "duplicate-websocket", status: existing.status };
      const now = this.now();
      const lateDom = this._oldestMatchingDom(roll, ["submitted"]);
      if (lateDom) {
        const suppressed = {
          id: wsId, roll, status: "suppressed", createdAt: now,
          sequence: ++this.sequence, domId: lateDom.id,
          domIds: new Map([[lateDom.surface, lateDom.id]])
        };
        this.wsRolls.set(wsId, suppressed);
        lateDom.wsId = wsId;
        lateDom.matchedLateWsAt = now;
        return { action: "suppress-websocket", domId: lateDom.id, reason: "dom-already-submitted" };
      }

      const claim = {
        id: wsId, roll, status: "pending", createdAt: now,
        sequence: ++this.sequence, domId: null, domIds: new Map(),
        fallbackSubmitted: false, statusChecks: 0, unknownStatusChecks: 0
      };
      this.wsRolls.set(wsId, claim);

      // One fulfilled DDB roll may have one DOM representation per surface.
      // Pair the oldest waiting card in each distinct surface, preserving FIFO
      // when multiple identical rolls are in flight.
      const candidates = Array.from(this.domCards.values())
        .filter(card => card.status === "waiting" && !card.wsId && this.matches(roll, card.roll))
        .sort((a, b) => a.sequence - b.sequence);
      for (const card of candidates) {
        if (claim.domIds.has(card.surface)) continue;
        this._pair(card, claim);
      }
      return { action: "route-websocket", domId: claim.domId, domIds: Array.from(claim.domIds.values()) };
    }

    acknowledge(wsId, ok, detail = {}) {
      const claim = this.wsRolls.get(wsId);
      if (!claim) return { action: "unknown-websocket" };
      if (!["pending", "checking"].includes(claim.status)) return { action: "already-acknowledged", status: claim.status };
      claim.status = ok === true ? "delivered" : "failed";
      claim.acknowledgedAt = this.now();
      claim.detail = detail;
      this._applyWsStatus(claim);
      const cards = this._cardsForClaim(claim);
      return {
        action: claim.status === "delivered" ? "suppress-dom" : claim.fallbackSubmitted ? "submit-dom" : "recorded",
        status: claim.status,
        domId: claim.domId,
        domIds: Array.from(claim.domIds.values()),
        cardCount: cards.length
      };
    }

    resolveStatus(wsId, status, detail = {}) {
      const claim = this.wsRolls.get(wsId);
      if (!claim || !["checking", "pending"].includes(claim.status)) {
        return { action: "ignore-status", status: claim?.status || "unknown-websocket" };
      }
      claim.statusCheckInFlight = false;
      claim.statusDetail = detail;
      if (status === "exists") {
        claim.status = "delivered";
        claim.acknowledgedAt = this.now();
        this._applyWsStatus(claim);
        return { action: "suppress-dom", status: claim.status };
      }
      if (status === "pending") {
        claim.status = "checking";
        claim.ackDeadline = this.now() + this.statusRetryMs;
        return { action: "retry-status", status: claim.status };
      }
      claim.unknownStatusChecks++;
      if (claim.unknownStatusChecks < 2) {
        claim.status = "checking";
        claim.ackDeadline = this.now() + this.statusRetryMs;
        return { action: "retry-status", status: claim.status };
      }
      claim.status = "failed";
      claim.acknowledgedAt = this.now();
      this._applyWsStatus(claim);
      return { action: "submit-fallback", status: claim.status };
    }

    tick() {
      const now = this.now();
      for (const card of this.domCards.values()) {
        if (card.status !== "waiting") continue;
        if (!card.wsId && now >= card.expiresAt) {
          this._submit(card, "grace-expired");
        } else if (card.wsId && now >= card.ackDeadline) {
          const claim = this.wsRolls.get(card.wsId);
          if (!claim || !["pending", "checking"].includes(claim.status) || claim.statusCheckInFlight) continue;
          if (claim.status === "pending") claim.status = "checking";
          claim.statusCheckInFlight = true;
          claim.statusChecks++;
          try {
            this.onAckTimeout(claim.id, { attempt: claim.statusChecks });
          } catch (error) {
            this.resolveStatus(claim.id, "unknown", { reason: String(error?.message || error) });
          }
        }
      }
      this._prune(now);
    }

    _oldestMatchingWs(roll, statuses, surface) {
      return Array.from(this.wsRolls.values())
        .filter(entry => statuses.includes(entry.status) &&
          !entry.domIds?.has(surface) && this.matches(entry.roll, roll))
        .sort((a, b) => a.sequence - b.sequence)[0] || null;
    }

    _oldestMatchingDom(roll, statuses) {
      // Keep matcher argument order consistent: WebSocket roll first, DOM roll second.
      return Array.from(this.domCards.values())
        .filter(entry => statuses.includes(entry.status) && !entry.wsId && this.matches(roll, entry.roll))
        .sort((a, b) => a.sequence - b.sequence)[0] || null;
    }

    _pair(card, claim) {
      card.wsId = claim.id;
      card.ackDeadline = this.now() + this.ackTimeoutMs;
      if (!claim.domIds) claim.domIds = new Map();
      claim.domIds.set(card.surface, card.id);
      if (!claim.domId) claim.domId = card.id;
    }

    _cardsForClaim(claim) {
      return Array.from(claim.domIds?.values() || [])
        .map(id => this.domCards.get(id))
        .filter(Boolean)
        .sort((a, b) => a.sequence - b.sequence);
    }

    _applyWsStatus(claim) {
      const cards = this._cardsForClaim(claim).filter(card => card.status === "waiting");
      if (claim.status === "delivered") {
        for (const card of cards) this._suppress(card, "websocket-delivered");
        return;
      }
      if (claim.status === "failed" || claim.status === "timed-out") {
        const reason = claim.status === "failed" ? "websocket-failed" : "websocket-ack-timeout";
        for (const card of cards) {
          if (!claim.fallbackSubmitted) {
            claim.fallbackSubmitted = true;
            this._submit(card, reason);
          } else {
            this._suppress(card, "websocket-fallback-already-submitted");
          }
        }
      }
    }

    _submit(card, reason) {
      if (card.status !== "waiting") return;
      card.status = "submitted";
      card.dispositionAt = this.now();
      card.reason = reason;
      this.onSubmitDom(card.roll, { cardId: card.id, reason, wsId: card.wsId });
    }

    _suppress(card, reason) {
      if (card.status !== "waiting") return;
      card.status = "suppressed";
      card.dispositionAt = this.now();
      card.reason = reason;
      this.onSuppressDom(card.roll, { cardId: card.id, reason, wsId: card.wsId });
    }

    _prune(now) {
      for (const [id, card] of this.domCards) {
        if (now - (card.dispositionAt ?? card.createdAt) > this.retentionMs) this.domCards.delete(id);
      }
      for (const [id, claim] of this.wsRolls) {
        if (claim.status === "pending" && now - claim.createdAt > this.ackTimeoutMs * 2) this.wsRolls.delete(id);
        else if (claim.status !== "pending" && now - (claim.acknowledgedAt ?? claim.createdAt) > this.retentionMs) this.wsRolls.delete(id);
      }
    }
  }

  return { RollCoordinator };
});
