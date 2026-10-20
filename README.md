# DDB → Foundry Direct Roll Bridge v0.1.4

This version waits for D&D Beyond dice animations/placeholders to finish, then posts one completed roll card to Foundry.

## Install

1. Copy `foundry-module/ddb-direct-roll-bridge` to your Foundry `Data/modules/` folder.
2. Enable **DDB Direct Roll Bridge** in your world.
3. Open `chrome://extensions`, enable Developer Mode, and use **Load unpacked** on the `chrome-extension` folder.
4. Open Foundry as GM in one tab.
5. Open the D&D Beyond campaign page/game log in another tab.
6. Click the extension icon to view diagnostics.

## v0.1.4
- Groups nested D&D Beyond dice nodes into one roll payload.
- Stops initial page-load backfill to avoid importing old rolls.
- Adds dice summary/count to the Foundry chat card.
- Keeps the v0.1.2 Foundry ChatMessage fix.


## v0.1.4
- Ignores interim D&D Beyond placeholder rolls such as `?` / `... NOW`.
- Waits for the completed roll result before forwarding to Foundry.
- Watches text-node updates inside the same D&D Beyond roll card, not just newly-added elements.
