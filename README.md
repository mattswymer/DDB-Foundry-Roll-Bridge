# DDB Direct Roll Bridge

**Mirror D&D Beyond rolls into native Foundry VTT chat cards.**

[![Latest Release](https://img.shields.io/github/v/release/mattswymer/DDB-Foundry-Roll-Bridge?label=release)](https://github.com/mattswymer/DDB-Foundry-Roll-Bridge/releases)
[![Issues](https://img.shields.io/github/issues/mattswymer/DDB-Foundry-Roll-Bridge)](https://github.com/mattswymer/DDB-Foundry-Roll-Bridge/issues)
[![License](https://img.shields.io/github/license/mattswymer/DDB-Foundry-Roll-Bridge)](https://github.com/mattswymer/DDB-Foundry-Roll-Bridge/blob/main/LICENSE)

Roll on D&D Beyond and see the result appear in Foundry VTT chat. The Foundry module can connect directly to the D&D Beyond Cloud Relay, so the normal relay setup does not require a browser extension. A Chrome/Edge extension is also available as an alternate delivery path.

**Version:** 1.1.2 (development)  
**Package:** Foundry VTT module (Cloud Relay delivery; browser extension optional)  
**Status:** v1.1.2 custom-roll fix passed automated tests and initial live native-roll validation through the extension route. The extension-free Cloud Relay route still needs a live custom-roll confirmation; v1.1.1 remains the latest stable release.

## Project links

- [Releases and downloads](https://github.com/mattswymer/DDB-Foundry-Roll-Bridge/releases)
- [Changelog](CHANGELOG.md)
- [Issue tracker](https://github.com/mattswymer/DDB-Foundry-Roll-Bridge/issues)
- [DDB Cloud Relay repository](https://github.com/mattswymer/DDB-Cloud-Relay)

## Features

- Captures completed D&D Beyond game-log roll events.
- Reconstructs supported attacks, ability checks, saving throws, initiative, damage, and healing as native D&D 5e chat messages.
- Preserves D&D Beyond's actual die results, including advantage and disadvantage d20 results.
- Reconstructs standalone custom dice-roller rolls, including d100 and mixed dice, as native Foundry Roll chat messages using D&D Beyond's actual die results.
- Coordinates WebSocket and DOM delivery to suppress duplicate cards and retain a fallback path.
- Routes rolls to an eligible Foundry GM tab and supports actor mapping by D&D Beyond character ID.
- Connects directly to the Cloud Relay from the Foundry module, with reconnect handling and session reattachment after a Foundry reload. This path does not require the browser extension.

The module mirrors roll results. It does not synchronize characters, automatically apply damage or healing, or integrate with Midi-QOL. Attack resolution and damage application remain part of the normal Foundry workflow. Standalone custom dice rolls are posted as native Foundry Roll messages; unsupported character-sheet actions may still use a generic result card.

## Requirements

- A modern browser supported by Foundry VTT and D&D Beyond.
- Foundry VTT 12 or later; tested against Foundry VTT 14.
- The D&D 5e game system (dnd5e).
- A Foundry GM session open in a supported browser tab.
- A D&D Beyond campaign/game log showing the rolls to mirror.

## Install the Foundry module

In Foundry, open **Add-on Modules → Install Module**, paste the stable manifest URL, and install:

```
https://github.com/mattswymer/DDB-Foundry-Roll-Bridge/releases/latest/download/module.json
```

Enable **DDB Direct Roll Bridge** in the world's Manage Modules settings, then launch the world as GM.

For The Forge, use its module installation workflow and the same manifest URL. Forge reads the module title, description, compatibility, and update information from the module manifest.

## Optional browser extension

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `chrome-extension/` directory.
5. Reload the extension after updates, then refresh the D&D Beyond and Foundry tabs.

The extension is an alternate capture and forwarding path. It is not required when using the Foundry module's direct Cloud Relay connection. The standalone custom-dice fix is implemented in the shared Foundry receiver and does not require an extension update.

The extension's default Foundry host permissions cover The Forge and localhost/127.0.0.1. Custom self-hosted domains require appropriate host permissions to be added to the extension manifest.

## Choose a delivery path

### Direct D&D Beyond Cloud Relay (extension-free)

1. Install and enable the Foundry module.
2. Open the module's **D&D Beyond Cloud Relay** settings.
3. Enter the relay admin key and create a campaign profile with its D&D Beyond Game ID.
4. Paste the CobaltSession cookie value when starting a relay session.
5. Confirm the relay reports a connection to D&D Beyond and test a roll in Foundry chat.

This is the extension-free delivery path. The Foundry module opens the relay stream directly and receives fulfilled roll events.

### Browser extension (alternate path)

1. Install the extension in Chrome or Edge.
2. Open Foundry as GM and the D&D Beyond campaign/game log.
3. Make a test roll and confirm one matching card appears in Foundry chat.

This alternate path does not require your D&D Beyond password or CobaltSession cookie.

**Cloud Relay operation:** The relay is a separate service that you or your administrator deploy and operate. It holds the active D&D Beyond CobaltSession cookie in server memory, exchanges it for short-lived tokens, and forwards live game-log events to the Foundry module.

**Credential warning:** The CobaltSession cookie grants access to your D&D Beyond session. Never share it or paste it into an issue, chat, screenshot, or source file. The module stores the admin key and cookie in Foundry client settings, which are local to that browser but are not encrypted. The relay keeps the cookie in memory while a session is active. Anyone who controls the relay and its admin key may be able to use an active session. Use a private relay deployment and stop sessions when finished.

See the [DDB Cloud Relay repository](https://github.com/mattswymer/DDB-Cloud-Relay) for deployment, configuration, and operational details.

## Troubleshooting

### Rolls do not appear

- Confirm the D&D Beyond game log is open and showing the roll.
- Confirm the Foundry world is open, the module is enabled, and the active user is a GM.
- Check the module's Cloud Relay status when using the direct relay path.
- Confirm that the campaign Game ID and saved credentials are correct.
- If using the optional browser extension, check its popup and reload it after an extension update.

### A roll appears twice or is missing

- Start with one D&D Beyond game-log tab and one Foundry GM tab.
- Record the roll type, whether rolls were rapid, and whether multiple GM tabs were open.
- Check the Foundry console and, when applicable, the extension diagnostics for the reported failure reason.
- Report reproducible cases without including passwords, cookies, session tokens, or private account data.

### D&D Beyond login expired

Update the saved CobaltSession cookie in the Cloud Relay settings and start a new session. Do not share the cookie with anyone.

## Relay protocol

The module and Cloud Relay share [protocol version 1](docs/relay-protocol.md). The module rejects missing or incompatible protocol handshakes; deploy compatible module and relay releases together.

## Compatibility

| Component | Supported / tested |
|---|---|
| Foundry VTT | 12+; verified on 14 |
| Game system | dnd5e |
| Browser extension | Optional alternate path: Chrome / Edge, Manifest V3; Chrome 111+ |
| D&D Beyond | Current game-log interface and event format |
| Cloud Relay | Protocol 1; optional separately deployed service |

D&D Beyond may change its WebSocket event format or rendered game-log interface. Test the roll types and browser/tab arrangement used by your table before relying on an update in a live session.

## Privacy and permissions

The direct Cloud Relay path requires a CobaltSession cookie, which grants access to your D&D Beyond session. The relay uses that cookie only to exchange for a short-lived token and keeps the cookie in server memory for the active session. The optional browser extension observes completed roll events on D&D Beyond and routes supported roll data to Foundry; it does not collect D&D Beyond passwords.

Review `chrome-extension/manifest.json` for browser host permissions. Do not post credentials, cookies, session tokens, or private game data in public issues.

## Changelog and support

See [CHANGELOG.md](CHANGELOG.md) for version history. To report a bug, [open a GitHub issue](https://github.com/mattswymer/DDB-Foundry-Roll-Bridge/issues) with your browser, Foundry, and dnd5e versions, the roll type, and relevant non-sensitive diagnostics.

## License

See [LICENSE](LICENSE) for license terms.
