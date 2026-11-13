# Changelog

All notable changes to DDB Direct Roll Bridge are documented here.

## [Unreleased]

- Coordinate each completed WebSocket roll with both D&D Beyond popup and chat-log DOM surfaces, preserving FIFO matching for rapid repeated rolls.
- Ensure a failed or timed-out WebSocket delivery produces at most one DOM fallback for a multi-surface roll.
- Add automated Node.js tests for roll-coordinator matching, delivery, fallback, timeout, and retention behavior.
- Reduce debug noise from stale, unrelated DOM candidates.


## [1.0.6] - 2026-11-09

- Preserve discarded d20 results in native Foundry attack, ability-check, and saving-throw rolls so advantage and disadvantage display both dice.

## [1.0.5] - 2026-11-09

- Match D&D Beyond healing spell names to imported Foundry items with a trailing `(Legacy)` suffix.
- Fix native check, save, and initiative success logging when those roll types do not return an item.
- Include roll type, action, and stack trace in native roll failure diagnostics.

## [1.0.4] - 2026-11-09

- Suppress legacy DOM cards when a matching native WebSocket attack, check, save, initiative, damage, or healing roll has already been routed.
- Reconstruct D&D Beyond healing rolls as native D&D5e healing messages using the imported item's Heal activity.

## [1.0.3] - 2026-11-09

- Relay completed outgoing D&D Beyond WebSocket roll events after the native send succeeds, because the client does not receive an echo of these fulfilled events.
- Continue ignoring deferred rolls and deduplicating fulfilled events by roll ID.

## [1.0.3] - 2026-11-09

- Reconstruct D&D Beyond attack, ability-check, saving-throw, initiative, and damage rolls as native D&D5e chat messages.
- Update a matching combatant's initiative when an initiative roll can be mapped unambiguously.
- Preserve the selected attack targets on native damage cards so D&D5e's Apply Damage workflow can be used.
- Relay only server-confirmed incoming WebSocket rolls; outgoing frames remain diagnostic.
- Bound the retained WebSocket socket list.

## [1.0.2] - 2026-11-09

- Added D&D Beyond WebSocket roll capture and GM-side routing.
- Reconstructed attack rolls using D&D Beyond's actual die results and modifiers, including target hit/miss evaluation.

## [1.0.1] - 2026-10-20

- Added Foundry release packaging and a downloadable module ZIP.
- Added package-page metadata links for the project website, documentation, issues, and changelog.

## [1.0.0]

- Consolidated the read-only D&D Beyond-to-Foundry roll bridge.
- Added cross-tab routing, duplicate handling, startup queuing, extension diagnostics, and Foundry-styled chat cards.
- Narrowed browser host permissions to supported D&D Beyond, The Forge, and local Foundry addresses.
