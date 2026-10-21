# DDB → Foundry Roll Bridge

**Version 1.0.0** · Chrome/Edge extension + Foundry VTT module

A lightweight bridge that mirrors completed rolls from the D&D Beyond game log into Foundry VTT chat as readable, Foundry-styled cards.

It is designed for live tabletop sessions: open your D&D Beyond campaign/game log and your Foundry world, roll normally on D&D Beyond, and see the result appear in Foundry chat.

## Features

- Captures completed rolls from the visible D&D Beyond game log.
- Displays the character, roll name, formula, dice results, and total when D&D Beyond exposes those details.
- Filters duplicate representations of the same roll while favoring capture of legitimate rapid rolls.
- Routes each roll to one eligible Foundry tab rather than posting copies to every open tab.
- Prefers a ready Foundry GM session and queues rolls briefly while the module starts.
- Provides extension-popup diagnostics for connection status, rolls seen/routed, acknowledgements, and recent results.
- Uses a compact chat-card layout that follows Foundry's default text styling where possible.

## What it does not do

This is a **chat mirror**, not a native Foundry dice integration. The cards are custom chat messages; they are not native Foundry `Roll` objects.

It does not synchronize D&D Beyond characters with Foundry actors, move tokens, apply damage or healing, resolve attacks, automate saving throws, or integrate with Midi-QOL. Those features are intentionally outside this project's scope.

The extension reads D&D Beyond's rendered game-log interface. A D&D Beyond UI change can affect extraction, and some details may be unavailable for particular roll types.

## Requirements

- A Chromium-based browser such as Google Chrome or Microsoft Edge.
- A D&D Beyond campaign/game log that displays the rolls you want to mirror.
- A Foundry VTT world with the **DDB Direct Roll Bridge** module enabled.
- A Foundry GM session open in a supported browser tab.

## Installation

### 1. Install the Foundry module

**Recommended — install by manifest URL:** In Foundry, go to **Add-on Modules → Install Module**, paste the following into the **Manifest URL** field, and select **Install**:

```
https://raw.githubusercontent.com/mattswymer/DDB-Foundry-Roll-Bridge/main/foundry-module/ddb-direct-roll-bridge/module.json
```

Alternatively, install manually:

1. Download or clone this repository.
2. Copy the `foundry-module/ddb-direct-roll-bridge` folder into your Foundry user data directory's `Data/modules/` folder.
3. Start Foundry and enable **DDB Direct Roll Bridge** in the world's **Manage Modules** settings.
4. Launch the world as the GM.

For The Forge, use its module installation workflow and the manifest URL above.

### 2. Install the browser extension

1. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `chrome-extension/` directory.
5. Pin the extension if you want convenient access to its status popup.

After updating the code, use the extension page's **Reload** control, then refresh your D&D Beyond and Foundry tabs.

### 3. Connect and test

1. Open Foundry and enter the world as GM.
2. Open the D&D Beyond campaign page and show the game log.
3. Make a test roll on D&D Beyond.
4. Confirm that one matching card appears in Foundry chat.
5. Open the extension popup to check that both tabs are detected, the module is ready, and Foundry acknowledges the roll.

**Important:** The extension currently injects into D&D Beyond, The Forge, and local Foundry URLs (`localhost` and `127.0.0.1`). Arbitrary custom-domain self-hosted Foundry URLs are not included in the default host list.

## Troubleshooting

### Rolls do not appear

- Confirm the D&D Beyond game log is open and showing the roll.
- Confirm the Foundry world is open and the module is enabled.
- Make sure the GM session is active.
- Open the extension popup and check detection status and acknowledgements.
- Reload the extension and refresh both tabs after installing an update.

### A roll is missing or appears twice

- Test with one D&D Beyond campaign/game-log tab and one Foundry GM tab first.
- Then add other character tabs and repeat the test.
- Note the roll type, whether the rolls were rapid, and the popup's **Rolls seen**, **Rolls routed**, and **Foundry acknowledgements** counters.
- D&D Beyond changes its rendered game-log entries over time; report reproducible cases with the roll type and diagnostics.

### The first roll after startup behaves oddly

Allow Foundry and the module to finish loading before testing. If historical game-log entries are forwarded or the first new roll is missed, capture the popup diagnostics and report the sequence of steps that reproduced it.

## Diagnostics

The extension popup reports:

- **D&D Beyond tab:** whether a supported D&D Beyond page is detected.
- **Foundry tab:** whether a supported Foundry page is detected.
- **Foundry module:** whether the receiver is ready and whether the session is a GM.
- **Rolls seen / Rolls routed:** bridge counters for observed and routed candidates.
- **Foundry acknowledgements:** messages confirmed by the Foundry receiver.
- **Recent rolls:** a short list of recent character, roll, and total values.

These counters are diagnostic indicators, not a guarantee that every D&D Beyond roll type was extracted perfectly.

## Privacy and permissions

The extension processes visible roll information from D&D Beyond and sends it to the Foundry tab through the browser extension. It does not require D&D Beyond passwords or Cobalt cookies.

Host access is limited to D&D Beyond, The Forge, and local Foundry addresses listed in `chrome-extension/manifest.json`. Review that file before adding any additional hosts.

## Compatibility

- Browser extension: Manifest V3 for Chrome/Edge.
- Foundry module metadata targets Foundry versions 11 and later; the module has not been exhaustively validated across every Foundry version or system.
- Live behavior depends on the current D&D Beyond game-log interface.

## Version 1.0.0

The 1.0 release consolidates the working read-only bridge, including cross-tab routing and duplicate handling, startup queuing, extension-context cleanup, diagnostics, narrower host permissions, and Foundry-styled chat cards.

Before relying on it in a session, test the specific roll types and browser/tab arrangement used by your table. This project mirrors visible roll results; it does not guarantee native Foundry automation.

## License

See [LICENSE](LICENSE) for the project's license terms.
