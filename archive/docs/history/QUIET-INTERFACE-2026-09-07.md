# Quiet interface checkpoint

September 7, 2026. Retained, uncommitted changes on the unified candidate; not a deployment.

## Delivered

- Removed the redundant room rail, repeated introductions, and always-visible room pulse.
- Kept conversation and compact work cards primary. People, work facts/evidence, room description, draft recovery, and review settings expand on demand.
- Work creation now uses a focused native modal with Escape/cancel focus return. Full review defaults remain on and summarized; a required reviewer remains visible.
- Shortened ordinary copy. Retained meaningful permission, evidence, stale-connection and identity warnings.
- Desktop Enter sends; Shift+Enter inserts a line. Ctrl/Cmd+Enter still sends. Touch Return inserts a line and a named 44px send control remains available.
- IME confirmation, legacy composition signals, repeats, Alt+Enter, and whitespace-only drafts do not trigger accidental sends.
- Added disclosure reset on access loss, automatic expansion for member/work deep links, and live-update preservation of work-detail focus.
- Consolidated keyboard behavior into the existing conversation module. No new dependency, server endpoint, payment implementation, or database schema.

## Verification

Final source/test/config digest: `71212bafaafe6521dc9a6258508caa4c91b61e106cf1457197554d3e15c2ec89`.
Computed from sorted tracked and untracked source, server, client, scripts, tests, index.html, package.json and server.mjs file hashes. Documents and generated screenshots are excluded.

- Syntax and core/API checks: **192 passed**, zero failed/skipped.
- Full browser suite: **37 passed**, zero failed/skipped (46.5 seconds).
- Existing retry, session isolation, invitation, source links, independent review, re-review and focus coverage retained.
- New checks cover plain Enter, Shift+Enter, true touch emulation, empty drafts, default-closed detail surfaces, review summaries, modal focus, live work-detail updates, access cleanup and doubled-text reflow.
- Updated tests explicitly open new disclosures; no forced clicks or hidden-content workarounds.

Viewed desktop room, desktop/mobile work dialogs, full enlarged-text captures and the actual enlarged-text mobile viewport. Evidence is under `test-results/quiet-*`; the focused viewport files avoid misleading full-page scaling. Chromium 151's Playwright screenshot capture resets touch emulation, reproduced independently. The touch keyboard assertions therefore run before screenshots; post-capture hints can show desktop instructions and are not evidence of touch-keyboard behavior. Real iOS/Android and assistive-technology testing remain outstanding.

The unified retained preview at http://localhost:52331/ serves the new front-end files without a service restart. Opened its signed-out UI in the in-app browser. Authenticated acceptance checks used disposable servers, not this retained database. Older http://127.0.0.1:52330/ and its records remain untouched.

## Separate proposal

[Bounties: work anywhere, coordinate in Project Room](BOUNTIES-DESIGN-2026-09-07.md) records the user's follow-up. It proposes in-room, external-agent, copy-paste and repository routes into one work record. Bounties, payments, an MCP adapter and a background runner are **not implemented** by this checkpoint.

No commit, push, deployment, outbound GitHub update, real payment or real external-agent run. Local coordination write lanes are released after this checkpoint; no delivery to external Instinct/Grokbot sessions is claimed.
