(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DDBRollCoordinator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class RollCoordinator {
    constructor({ matches, onSubmitDom, onSuppressDom, now = () => Date.now(), graceMs = 1000, ackTimeoutMs = 15000, retentionMs = 30000 } = {}) {
      if (typeof matches !== "function") throw new TypeError("matches must be a function");
      this.matches = matches;
      this.onSubmitDom = typeof onSubmitDom === "function" ? onSubmitDom : () => {};
      this.onSuppressDom = typeof onSuppressDom === "function" ? onSuppressDom : () => {};
      this.now = now;
      this.graceMs = graceMs;
      this.ackTimeoutMs = ackTimeoutMs;
      this.retentionMs = retentionMs;
      this.hookHealthy = false;
      this.domCards = new Map();
      this.wsRolls = new Map();
      this.sequence = 0;
    }

    setHookHealthy(healthy) {
      this.hookHealthy = healthy === true;
      if (!this.hookHealthy) {
        for (const card of this.domCards.values()) {
          if (card.status === "waiting") this._submit(card, "websocket-hook-unavailable");
        }
      }
    }

    addDom(cardId, roll) {
      if (!cardId || this.domCards.has(cardId)) return { action: "duplicate-dom" };
      const now = this.now();
      const card = { id: cardId, roll, status: "waiting", createdAt: now, expiresAt: now + this.graceMs, sequence: ++this.sequence, wsId: null };
      this.domCards.set(cardId, card);
      if (!this.hookHealthy) {
        this._submit(card, "websocket-hook-unavailable");
        return { action: "submit-dom", reason: "websocket-hook-unavailable" };
      }
      const claim = this._oldestMatchingWs(roll, ["pending", "delivered", "failed"]);
      if (claim) {
        this._pair(card, claim);
        this._applyWsStatus(card, claim);
        return { action: card.status === "waiting" ? "hold-dom" : card.status === "suppressed" ? "suppress-dom" : "submit-dom", wsId: claim.id };
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
        const suppressed = { id: wsId, roll, status: "suppressed", createdAt: now, sequence: ++this.sequence, domId: lateDom.id };
        this.wsRolls.set(wsId, suppressed);
        lateDom.wsId = wsId;
        lateDom.matchedLateWsAt = now;
        return { action: "suppress-websocket", domId: lateDom.id, reason: "dom-already-submitted" };
      }
      const claim = { id: wsId, roll, status: "pending", createdAt: now, sequence: ++this.sequence, domId: null };
      this.wsRolls.set(wsId, claim);
      const card = this._oldestMatchingDom(roll, ["waiting"]);
      if (card) this._pair(card, claim);
      return { action: "route-websocket", domId: card?.id || null };
    }

    acknowledge(wsId, ok, detail = {}) {
      const claim = this.wsRolls.get(wsId);
      if (!claim) return { action: "unknown-websocket" };
      if (claim.status !== "pending") return { action: "already-acknowledged", status: claim.status };
      claim.status = ok === true ? "delivered" : "failed";
      claim.acknowledgedAt = this.now();
      claim.detail = detail;
      const card = claim.domId ? this.domCards.get(claim.domId) : null;
      if (card && card.status === "waiting") this._applyWsStatus(card, claim);
      return { action: card ? (card.status === "suppressed" ? "suppress-dom" : "submit-dom") : "recorded", status: claim.status, domId: card?.id || null };
    }

    tick() {
      const now = this.now();
      for (const card of this.domCards.values()) {
        if (card.status !== "waiting") continue;
        if (!card.wsId && now >= card.expiresAt) {
          this._submit(card, "grace-expired");
        } else if (card.wsId && now >= card.ackDeadline) {
          const claim = this.wsRolls.get(card.wsId);
          if (claim?.status === "pending") {
            claim.status = "timed-out";
            claim.acknowledgedAt = now;
          }
          this._submit(card, "websocket-ack-timeout");
        }
      }
      this._prune(now);
    }

    _oldestMatchingWs(roll, statuses) {
      return Array.from(this.wsRolls.values())
        .filter(entry => statuses.includes(entry.status) && !entry.domId && this.matches(entry.roll, roll))
        .sort((a, b) => a.sequence - b.sequence)[0] || null;
    }

    _oldestMatchingDom(roll, statuses) {
      // Keep the matcher argument order consistent: WebSocket roll first,
      // DOM roll second, regardless of which one arrived first.
      return Array.from(this.domCards.values())
        .filter(entry => statuses.includes(entry.status) && !entry.wsId && this.matches(roll, entry.roll))
        .sort((a, b) => a.sequence - b.sequence)[0] || null;
    }

    _pair(card, claim) {
      card.wsId = claim.id;
      card.ackDeadline = this.now() + this.ackTimeoutMs;
      claim.domId = card.id;
    }

    _applyWsStatus(card, claim) {
      if (claim.status === "delivered") this._suppress(card, "websocket-delivered");
      else if (claim.status === "failed") this._submit(card, "websocket-failed");
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
