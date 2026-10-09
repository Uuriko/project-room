# Guild-08 suite docs — D07

## room-protocol-mutation.test.js (14 tests)
Boundary-condition tests for the protocol trust core of scripts/room that no other file owns: heartbeat exactly at lease expiry accepted; future-dated strike-one clamped; unparseable stamps refused; strike-two at exactly strike_one_at+14400s rejected (grace is <=); heartbeat at strike_one_at doesn't block strike-two; sweep plans at exact lease-expiry/grace instants; W5/W6/W8/W9 wedge cases. The exact-boundary suite — every test pins one instant.

## room-rebuild.test.js (3 tests)
Proves rebuild --commit-push: survives a dirty ROOM-STATE.md on main; no-op when the board is unchanged; creates room-state from main when the branch is new. Rebuild-idempotence suite.

## room-render-prose-fence.test.js (1 test)
Regression for the $frows double-bind bug: prose-claims-needing-fence lists prose comments, not file-claims rows. Single-test, pins the exact bug.

## room-results.test.js (4 tests)
Proves Results distinguish current completed work from approvals and pending gates without mutating records; historical/mismatched approvals, superseded work and missing evidence can't appear as current; stable ID-tie ordering with only current projections; real API and MCP clients share Results, read pinned text, recheck reopening, make no writes. Results-projection honesty suite.

## room-roster.test.js (9 tests)
Proves the room roster surface: exactly the four agents with safe routes; inherited connection ids aren't seats; MCP snippets require absolute private paths and never mention tokens; connect recipes name routes without tokens; reconnect copy secret-free; CLI prints packet route and refuses host-config writes; script spawn matches the module; name collision case-insensitive ignoring inactive/humans; Add-agent markup lists the four names. Roster-surface + secret-hygiene suite.

## room-rotation-ledger.test.js (6 tests)
Proves the rotation carry-over ledger: parses rotation-handoff/amendment; restores carried claims with ORIGINAL expiry; amendments close stale entries with old-board evidence; later fenced re-claims refused; malformed ledgers register nothing and log loudly; wrong-comment-id amendments ignored. Board-rotation continuity suite.

## room-strike-hardening.test.js (8 tests)
Fuzzer-findings F1–F5 regressions against the real reducer: replayed strike-ones (fresher/older stamps) don't move strike_one_at; forged strike-two without strike-one ignored; strike-two inside grace or after post-nudge heartbeat ignored; control still releases; lease_expires_at extends from last heartbeat; STATUS without fenced block or ACK logs loudly. Each mirrors a minimal fuzzer repro and failed pre-fix. Adversarial regression suite.

## room-submitted-rot.test.js (7 tests)
Proves the submitted-state strike lifecycle fix: strike-one recorded (not ignored) on submitted held claims; strike-two releases expired submitted claims; post-nudge STATUS heartbeats block strike-two; terminal/suspended/released claims still ignore strike-one; strike-one recorded on expired lease-bearing prose claims. Closes the no-expiry-path rot hole.

## room-sweep-dry-run.test.js (8 tests)
Proves sweep/claim dry-run semantics: --dry-run prints the plan and never posts; live runs post; bogus flags die before any board call; dry-run PLAN labels match the live run exactly; claim --lane charset checks. Dry-run safety suite.

## room-sweep-evidence.test.js (12 tests)
Proves sweep evidence-gathering before strike-one: merged PRs touching claim files suppress strike-one (unrelated files don't); drive-by vs landing touches distinguished; prose receipts/STATUS after expiry suppress strikes as human-format activity; activity before the window doesn't suppress; production-format nudges don't self-suppress; genuine silence still strikes/releases. Evidence-before-strike suite.

## room-sweep-terminal.test.js (7 tests)
Proves sweep terminal handling: receipt/prose-completed claims are completed and skipped; MERGED/DEPLOYED/DONE prose completions close terminally (including from submitted); expired working claims still sweepable; strike stamps on terminal claims ignored; legitimate strike flow works; prose MERGED without task-id stays prose. Terminal-state suite.

## room-templates.test.js (2 tests)
Proves the room templates catalog and that applyRoomTemplate seeds charter and work items. Thin.

## room-trust.test.js (5 tests)
Proves Room Trust (owner kill-switch, default open): only the owner flips it; off blocks cross-owner assign and wake (same-owner stays open); HTTP body names the kill-switch with the hint. Trust kill-switch suite.
