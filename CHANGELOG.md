# Changelog

All notable changes to DDB Direct Roll Bridge are documented here.

## [Unreleased]

## [1.1.2] - 2026-11-16

- Reconstruct standalone D&D Beyond custom dice rolls (including d100 and mixed dice) as native Foundry Roll messages using the exact die results supplied by D&D Beyond.
- Validate fulfilled roll IDs, dice notation, die types, individual results, and totals before posting; retain duplicate protection so each roll is created once.
- Apply the fix in the shared Foundry receiver so it works with the direct Cloud Relay connection without requiring a browser extension.


## [1.1.1] - 2026-11-16

- Prevent receiver startup from crashing when Foundry has not initialized `game.modules` while module scripts are evaluated.
- Live validation on 2026-11-16 confirmed all supported roll types, advantage, and disadvantage create the expected Foundry chat output.

## [1.1.0] - 2026-11-15

- Restore the Cloud Relay stream after a Foundry world reload when an active session exists.
- Reattach to an already-active campaign session instead of creating a conflicting session; confirm before switching campaigns.
- Handle relay protocol compatibility, expired D&D Beyond login notices, and terminal WebSocket close codes.
- Preserve campaign profile identity when names or game IDs are edited and validate unique numeric game IDs.
- Accept D&D Beyond character-sheet URLs in actor mappings and keep the mapping form open when validation fails.
- Prevent duplicate in-flight roll events from being acknowledged as completed and only mark rolls seen after a chat message is created.
- Align Foundry compatibility metadata with ApplicationV2 (Foundry 12+) and verify against Foundry 14.

## [1.0.9] - 2026-11-14

- Persist the Cloud Relay admin key and D&D Beyond CobaltSession in local Foundry client settings so they survive reloads without being shared through world settings.
- Normalize typographic apostrophes and quotation marks when matching D&D Beyond action names to Foundry items.
- Prefer the uniquely named Attack activity when a weapon has multiple attack activities, fixing native attack and damage processing for weapons with restricted attack variants.

## [1.0.8] - 2026-11-14

- Add optional D&D Beyond Cloud Relay integration with campaign profile management.


## [1.0.7] - 2026-11-12

- Coordinate each completed WebSocket roll with both D&D Beyond popup and chat-log DOM surfaces, preserving FIFO matching for rapid repeated rolls.
- Ensure a failed or timed-out WebSocket delivery produces at most one DOM fallback for a multi-surface roll.
- Verify Foundry message existence or in-progress processing before submitting a DOM fallback after an acknowledgment timeout; retry ambiguous status responses and honor late final acknowledgments.
- Add automated Node.js tests for roll-coordinator matching, delivery, fallback, timeout, and retention behavior; reduce debug noise from stale, unrelated DOM candidates.
- Resolve duplicate D&D Beyond-imported healing spells safely by matching activity configuration and preferring the item with importer provenance.
- Resolve ordinary weapon damage through its Attack activity when the item also contains separate Save activities.

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
