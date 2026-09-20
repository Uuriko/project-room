# Room-list and delayed-response continuity — September 19, 2026

The room chooser now uses `#pr-view/room-list`, distinct from the open room's `#pr-view/rooms`. The explicit Switch room button adds history, while restoration replaces the current entry. Existing account-home Rooms links remain supported. Both paths share one destination-writing helper, with no new router or schema.

Desktop/mobile browser regressions cover room → chooser → Inbox → Back/Forward, preserving unsent room/private drafts. Separate tests reload the chooser with and without an open room. Existing cross-room history fallback now lands on the canonical chooser fragment.

Inbox list/read requests capture the navigation generation. A response belonging to a departed view cannot select/render a source or restore its page scroll. Hidden reader rendering is suppressed, including completion of existing background draft operations. Disconnect and reconnect may complete their operation, but their refresh cannot navigate back into a departed Inbox.

Four new route/read regressions failed before the corresponding fix. A separate held disconnect regression also failed before its fix: it visibly reopened Inbox over current room writing. These tests use local fixtures; no external messages or provider operations ran.

## Remaining scope

Search/pagination, share/send completions and broader access-transition combinations still need the focused asynchronous-state audit. A concrete next regression is leaving a pending search or pagination request, re-entering Inbox, and trying that action again: their current early stale-response returns precede clearing the busy flag. Reproduce this before changing those paths. No claim is made that all async operations have been audited. Unsent text is preserved during in-session navigation; reload tests verify the destination, not crash durability of unsaved private writing. Historical full-suite failures remain separate release debt.

Final verification counts are recorded in the product execution plan. Logs are retained locally under ignored `test-results/room-list-continuity/`. No push or deployment.

Verification: 109 distinct browser checks passed across final runs; 38 focused unit checks passed. The broad run initially had one outdated Telegram empty-state wording assertion; baseline markup already used the current copy. The updated check verifies the visible empty state, and the full Telegram pair then passed with binding, secret and reconnect assertions preserved. Lint reports zero errors and 79 existing warnings; diff whitespace check passed.
