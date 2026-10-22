# DDB Direct Roll Bridge v2 (experimental)

This is a clean, separate implementation of the D&D Beyond → Foundry VTT bridge. The existing **DDB Direct Roll Bridge** on `main` is deliberately untouched and remains the fallback.

This branch adds the first implementation of two phases:

- **Phase 1 — direct capture:** consume D&D Beyond's fulfilled game-log WebSocket events, preserve their message IDs and actual die results, seed duplicate detection from recent history, reconnect with fresh short-lived JWTs, and expose transport status.
- **Phase 2 — typed Foundry cards:** normalize event payloads, classify attack/damage/healing/save/check/initiative rolls, create Foundry chat messages with structured module flags, and map D&D Beyond character IDs to Foundry actors.

The module does not evaluate a new dice roll. The totals and dice breakdown displayed in chat come from the fulfilled D&D Beyond event.

## Architecture

```text
D&D Beyond game-log WebSocket
          │ original fulfilled events
          ▼
direct-bridge (small local Node service)
  ├─ CobaltSession → short-lived JWT
  ├─ reconnect/backoff + history dedup seed
  ├─ bounded duplicate set
  └─ authenticated local SSE stream
          │ localhost only
          ▼
Foundry module: ddb-roll-bridge-v2
  ├─ event normalization + type tags
  ├─ DDB entity ID → Foundry Actor mapping
  └─ chat card + structured message flags
```

A local service is necessary for the manual Cobalt-cookie flow because browser JavaScript cannot set an arbitrary HTTP `Cookie` request header. The service performs that exchange from Node and binds only to `127.0.0.1`; no browser extension is used. The cookie stays in service memory and is never logged or written to disk.

## Compatibility target

- Foundry VTT v14
- D&D 5e system 6.0.6
- GM client runs the bridge and creates the public chat messages
- No Midi-QOL dependency

The module and transport are **experimental** and have not yet been verified against a live D&D Beyond account from this repository. Test in a non-session world first.

## Install the local service

Requires Node.js 20 or newer.

1. Download or clone this branch.
2. Open a terminal in `direct-bridge/`.
3. Run:

   ```sh
   npm install
   npm test
   npm start
   ```

4. Leave the terminal running. It prints a randomly generated local bridge access token once at startup. Copy that token into the Foundry module's setup dialog. Do not post it publicly.
5. The service binds to `127.0.0.1:39210` by default. Change the port with the `PORT` environment variable if needed.

If your Foundry is served from a custom domain, add the exact origin to `ALLOWED_ORIGINS`, comma-separated. The service allows localhost and Forge origins by default. Only expose it to origins you trust.

## Install the Foundry module

Copy `foundry-module/ddb-roll-bridge-v2/` into your Foundry `Data/modules/` directory, then enable **DDB Roll Bridge (Direct)** in the world. For Forge, upload the module folder using the Forge module installation workflow; the local bridge still needs to run on the computer whose browser is running Foundry.

Open the chat sidebar and click **DDB Bridge**.

1. Enter the local bridge URL (default `http://127.0.0.1:39210`).
2. Paste the local bridge access token from the terminal.
3. Enter the numeric D&D Beyond campaign ID from the campaign URL.
4. Paste the value of the `CobaltSession` cookie. Paste only the value, not `CobaltSession=`.
5. Leave **Skip Beyond20-bridged rolls** enabled if Beyond20 is already delivering some rolls to Foundry; disable it only if you intentionally want to mirror those too.
6. Click **Connect**.
7. Click **Character Mapping** and associate each D&D Beyond character ID with the corresponding Foundry actor.

The Cobalt cookie is not saved in Foundry settings. It is sent to the local service over loopback and held in memory there; restarting the service requires entering it again. Treat the cookie as a password: anyone who obtains it may be able to access your D&D Beyond session.

## Current Phase 1/2 behavior

- Listens for `eventType === "dice/roll/fulfilled"`.
- Uses D&D Beyond event IDs for deduplication and seeds the set from recent REST history before live capture.
- Preserves the source `entityId`, character name, action, roll type, dice notation, actual die values, breakdown, and total.
- Reconnects with a refreshed JWT and exponential backoff.
- Renders one Foundry chat card per fulfilled event, with a typed section for each sub-roll.
- Stores the normalized event, category tags, and D&D Beyond IDs in message flags for future workflows.
- Supports manual character-to-actor mapping; unmatched rolls still display under the D&D Beyond character name.

## Not implemented yet

- Automatic hit/miss resolution against Foundry targets.
- Applying damage or healing to actor HP.
- Automatically adding initiative to combat.
- Fully native Foundry `Roll` term objects / Dice So Nice animation. This phase mirrors the real values into typed chat cards; it deliberately does not re-roll.
- Campaign discovery and a polished settings application.
- Live end-to-end verification against current D&D Beyond service behavior.

## Troubleshooting

- **401/403 during configuration:** the Cobalt cookie may be expired or malformed. Refresh it from your own D&D Beyond session and enter the value again.
- **Local bridge request blocked:** check that the Node service is running, that the URL and access token match, and that your Foundry origin is allowed. Browser private-network access policies may prompt or block local access depending on the hosting/browser setup.
- **Campaign characters fail to load:** verify the campaign ID and that the Cobalt session belongs to an account with access to that campaign.
- **No rolls arrive:** keep the terminal open, check the transport status in the bridge logs, and test with a new roll. Historical rolls are used for deduplication and are not backfilled into chat.
- **Duplicate cards:** report whether Beyond20 is enabled and whether the event has `data.__b20Override__`.

Do not share your Cobalt cookie, JWT, local bridge token, or unredacted account/session logs in bug reports.
