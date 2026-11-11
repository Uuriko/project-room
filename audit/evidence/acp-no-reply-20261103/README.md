# Ordinary ACP no-reply and local reply windows

Source `fd65608c63976bf903412c9fe8586260d5533443`, exact base `6dca37dada6d801e58aa9d748fb3630d3ca11cd7`.
No provider/model call, real credential, grant, production operation or live listener change.

A successful ordinary `{ "outcome":"no_reply", "body":"" }` is silent only with
exact keys, `end_turn`, no tools and no plan. Its discarded/silent receipt precedes
ACK; restart/lost ACK does not prompt or post again. Ordinary answered JSON posts
its body, with existing tool/error rendering; plaintext remains compatible. Invalid
no_reply shapes, activity, early stops and errors are not silently accepted.
Formal requests retain answered/declined/pending, current-context authority and
exact delivery semantics. Their pending diagnostics are exempt from this window.

A separate addressed private TurnReceipts namespace binds origin/room/member/thread
and reserves an ordinary operation before POST. The chat receipt then persists that
operation's reservation before send. A crash between these saves recovers by op ID;
unknown sends retry exactly even after later windows. Each new ordinary operation
inside 60 seconds is retained locally, marked reply_window_limited, and acknowledged
without a post or a claim of answering. This includes a second ordinary question:
use an explicit formal request for obligatory answers, or ask after the window.
There is no automatic delayed send or model/tool rerun.

The rule limits local reservation of new ordinary operations, not globally atomic
publication timestamps; an exact retry of an older uncertain operation remains
allowed. Local wall-clock rollback delays new reservations conservatively. The
existing listener fence protects one active bridge; separate host/home, old client,
manual or direct-API posting is not globally governed. Old unresolved result
receipts are not retroactively rate-limited or reclassified as ordinary/formal.
Existing atomic-file behavior is reused; no new power-loss transaction guarantee.

Before: the original nine new controls gave five pass/four fail. The intermediate
neighbor run gave 96/100 pass: four failures were existing tests requiring a second
ordinary reply immediately in the same thread. Their session reuse, slow-turn
batching and exact unknown-result retry assertions remain intact; only the local
reservation clock advances for tests needing a second allowed delivery. No real
clock, sleep, production lease or test timeout changed. Separate actual HTTP tests
prove same-thread suppression, exactly-60-second eligibility and independent
thread windows.

Final exact-source command: exit 0, 105 pass, zero fail/skip (Node v24.22.1).

```sh
/Users/johnpotter/.local/bin/node --test tests/room-acp-no-reply.test.mjs tests/room-acp-empty-turn.test.mjs tests/room-acp-chat-retry.test.js tests/room-acp-formal-delivery.test.mjs tests/room-acp-claim-retry.test.js tests/room-acp-authority-view.test.mjs tests/room-acp-bridge.test.js tests/room-acp-session-mode.test.mjs tests/candidate-manifest.test.mjs
/Users/johnpotter/.local/bin/node scripts/candidate-manifest.mjs --write
/Users/johnpotter/.local/bin/node scripts/secret-scan-diff.mjs --base 6dca37dada6d801e58aa9d748fb3630d3ca11cd7
```

ESLint on the five changed JavaScript modules/tests: exit 0. Changed-file and
committed-diff secret scans: exit 0. git diff --check: exit 0. Candidate manifest:
schema 45, 182 assets. Logs are compressed unchanged with raw digests in
qualification.json. Actual HTTP tests use a synthetic normalized Room server;
real subprocess tests use the repository's scripted ACP agent. No actual Claude
model behavior or deployed host-specific capability/latency claim is made.
