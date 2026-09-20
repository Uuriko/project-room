# Workspace history checkpoint — September 19, 2026

## Behavior

Explicit Rooms and Inbox button navigation now adds browser history. Initial restore and refresh keep replacement semantics; repeated clicks do not add duplicate entries. Back and Forward preserve the selected private conversation and unsent room/Inbox writing. Account destinations restore even without an open room.

A historical Rooms entry for another room opens the account room chooser without silently switching sessions or clearing current writing. Returning to the current room restores its room query. Both fragment and history traversal events are handled. Existing room access and draft confirmation still govern an explicit room switch.

No router dependency, backend schema, provider behavior, deployment or external message was added. History contains destination and room metadata, not private draft text or source IDs.

## Verification

The desktop/mobile history regressions failed before the fix. The final targeted navigation set covers arrival, reload/source links, selection/reading continuity, work-source continuity, desktop/mobile Back/Forward, account-only sessions and historical cross-room contexts.

See the execution ledger in PRODUCT-EXECUTION-PLAN.md for final counts. Test output is retained locally under ignored test-results/workspace-history/.

## Boundaries and next work

This is destination-button history, not a replacement for every existing navigation path. Room browsing still shares the Rooms fragment; a distinct route and the delayed-response audit are next. Cross-room history uses the chooser rather than automatically changing access sessions. The cross-room regression constructs historical entries; it does not establish every real multi-room flow.

Unsent draft preservation here is in-session navigation. It does not promise crash/reload durability for unsaved private text. Current Catch up remains room-scoped. Earlier full-suite failures remain unclassified unless explicitly resolved by another checkpoint; scoped green tests do not establish release readiness.
