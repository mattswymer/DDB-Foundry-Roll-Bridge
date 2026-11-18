# DDB Cloud Relay Protocol 1

This document defines the WebSocket contract shared by DDB Cloud Relay and DDB Direct Roll Bridge.

## Connection

- HTTP API base: the configured relay HTTPS origin.
- WebSocket endpoint: `wss://<relay-host>/stream`.
- All API requests except `GET /health` require the `x-relay-admin` header.
- The Foundry client must authenticate immediately after the WebSocket opens.

The first client message is:

```json
{ "type": "auth", "key": "<relay-admin-key>" }
```

## Server messages

### Ready

After successful authentication, the server sends:

```json
{
  "type": "status",
  "status": "stream-ready",
  "protocol": 1,
  "relayVersion": "1.1.0",
  "gameId": "campaign-id",
  "userId": "ddb-user-id"
}
```

The module requires protocol version 1. Unknown, missing, or different protocol versions are rejected. Deploy the relay and module as a compatible pair.

### Roll event

```json
{
  "type": "ddb-event",
  "receivedAt": "ISO-8601 timestamp",
  "payload": {
    "eventType": "dice/roll/fulfilled",
    "data": {
      "rollId": "unique-roll-id"
    }
  }
}
```

The relay forwards upstream game-log events without interpreting roll types. The Foundry module processes completed `dice/roll/fulfilled` events and deduplicates by `data.rollId`. Deferred events are not posted as completed rolls.

For standalone custom dice-roller rolls, D&D Beyond identifies the action as `custom` and the roll type as `roll`. The event includes the dice notation and individual die results. The Foundry module validates the notation, die results, and reported total, then reconstructs a native Foundry `Roll` using those exact results. This handling is implemented in the module receiver; no relay protocol or Cloud Relay deployment change is required.

### Status messages

| Status | Meaning |
|---|---|
| `stream-ready` | Relay client authenticated and attached to active session |
| `ddb-connected` | Upstream D&D Beyond WebSocket connected |
| `ddb-disconnected` | Upstream D&D Beyond WebSocket closed; relay will retry |
| `ddb-socket-error` | Upstream WebSocket reported an error |
| `token-refreshed` | D&D Beyond token refreshed |
| `reauth-required` | Cookie rejected or account identity changed; user action required |

An error message has `type: "error"` and a non-sensitive `message` string. Clients must not log credentials or tokens.

## Close codes

| Code | Meaning | Client behavior |
|---|---|---|
| `4400` | Malformed client message | Stop and report protocol error |
| `4401` | Client authentication timeout / reauthentication required | Stop automatic reconnect and request user action |
| `4402` | No active session or relay operating window closed | Stop; start an active session |
| `4403` | Invalid admin key | Stop; correct the saved key |
| Other / abnormal | Transient network or server interruption | Reconnect with exponential backoff |

## Delivery guarantees and limitations

- The relay keeps session state in memory and supports one active campaign session per instance.
- The relay does not persist events or automatically backfill missed rolls from REST history.
- The module only marks a roll as delivered after a Foundry chat message exists.
- The module uses roll IDs to suppress duplicate deliveries within its active Foundry session.
- A relay process restart or Cloud Run scale-to-zero event loses the active session; the user must start it again.
