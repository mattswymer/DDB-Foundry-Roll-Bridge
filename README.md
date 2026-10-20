# DDB → Foundry Roll Bridge v0.1.5

A read-only bridge that watches completed D&D Beyond game-log rolls and mirrors them into Foundry chat as formatted cards.

## What it does

- Waits for D&D Beyond's animated or placeholder roll card to resolve before forwarding a result.
- Extracts the visible character, roll title, formula, dice summary, total, and raw card text when available.
- Filters duplicate representations and cross-tab copies while keeping the duplicate window short enough to preserve rapid repeated rolls.
- Routes each roll to **one** Foundry tab, preferring a tab whose module is ready and whose user is the GM.
- Queues rolls briefly on the chosen page if the Foundry module is still starting.
- Shows connection, roll-routing, and Foundry acknowledgement diagnostics in the extension popup.

## What it does not do

The Foundry message is a custom HTML chat card, **not a native Foundry Roll object**. The bridge does not synchronize actors, modify character sheets, trigger Midi-QOL, or automate hits, damage, healing, saving throws, or combat. Some fields may be blank if D&D Beyond's visible game-log card does not expose them.

Roll extraction relies on D&D Beyond's page structure. A D&D Beyond UI change can require an update, so test the bridge after major site changes.

## Install

1. Copy `foundry-module/ddb-direct-roll-bridge` into your Foundry `Data/modules/` folder.
2. Enable **DDB Direct Roll Bridge** in the world and launch it as the GM.
3. Open `chrome://extensions`, enable Developer Mode, and choose **Load unpacked** on the `chrome-extension` folder.
4. Open the Foundry game in one tab and the D&D Beyond campaign/game log in another.
5. Make a test roll and check the Foundry chat and extension popup.

The extension injects scripts only on D&D Beyond, The Forge, and local Foundry URLs (`localhost` / `127.0.0.1`). Arbitrary custom-domain self-hosted Foundry URLs are not included in this build.

## Diagnostics

Click the extension icon to inspect D&D Beyond detection, Foundry detection, module readiness, routed rolls, acknowledgements, and recent roll totals.

- **Ready (GM):** Foundry is available to receive rolls.
- **GM session needed:** the detected Foundry tab is not logged in as GM; the bridge will try another eligible tab.
- **No acknowledgement yet:** a roll has not yet been confirmed by the Foundry module, or no roll has been sent.

## Version 0.1.5

- Corrected formula whitespace normalization.
- Shortened local duplicate suppression to reduce false suppression of rapid repeated rolls.
- Bounded and corrected cross-tab duplicate-cache cleanup; cross-tab matches include character context where available.
- Prevented a single roll from being sent to every open Foundry tab, avoiding duplicate chat messages in the same world.
- Prioritized ready GM tabs and queued rolls during module startup.
- Restricted content-script injection and host access to the supported sites.
- Removed unused extension permissions and reduced raw roll data in error logs.
