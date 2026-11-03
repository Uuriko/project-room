# ACP oversized ordinary context parking

Runtime `6fdb6bec4c73b2f692afac8343c0f2a9a45d025d`, causal test hardening
`6dcd8ce3876e76af9860aeb5467f35af85a221b7`, based on exact main `00c4bfd7a30b9738dfe39497fc72a78dd28bd3b8`.
Local Node v24.22.1 with a real synthetic normalized Room HTTP server.
No live launcher, installed runtime, saved identity or receipt was edited.

The original full-thread `413 current_thread_too_large` stops the entire bridge.
A selected-message read for the same root succeeds. The executable synthetic
regression seeds a legal 30-reply conversation, queues 12 old wakes, then supplies
an independent direct question and FYI on two existing source pages. Against the
original runtime, the later question produces zero posts where one is required.
With the fix, the original 12 signals/message IDs and request ID stay queued and
unacknowledged; the local metadata carries the exact typed reason and selected
GET review pointer. No session/model execution or reply is started for the batch.
A restarted bridge and repeated source traversal do not refetch the blocked full
thread, while the independent question posts one useful answer and the FYI is
persisted silent. Only those two fresh wakes are acknowledged.

The actual HTTP authorization, selected/full context, lease and POST/ACK paths
are exercised. Source page ordering is supplied by the focused test's poll stub;
this is not a claim of a newly modified live poll service. No model/provider or
Cloudflare performance claim is made.

Only the ordinary pre-execution full-read typed refusal is parked. Unrelated
413/503 errors retain queued retry behavior; selected-authority refusal and
incomplete formal context retain global controlled-stop behavior. Existing
started/result recovery remains unchanged. Parking-save fault leaves the
original batch queued, with no model execution or ACK. Wrong stored operation
binding fails closed. There is no partial-history execution, whole-history
fallback, new receipt phase, public diagnostic post or automatic resume/ACK.
Old readers may retry the queued batch and stop, but cannot mistake it for a
completed or acknowledged operation. Parked obligations still need explicit
operator review; this repair enables independent threads, not old-thread completion.

Final qualification:

- 99 focused regression checks pass, zero skip/fail, exit 0.
- Final causal-test ordering hardening plus manifest: 15 pass, zero skip/fail.
- ESLint, changed-file and committed-diff secret scans, diff check: exit 0.
- Existing manifest generator: schema 45, 182 assets; existing manifest tests8/8.

```sh
/Users/johnpotter/.local/bin/node --test --test-name-pattern='real HTTP oversize' tests/room-acp-park-context.test.mjs
/Users/johnpotter/.local/bin/node --test tests/room-acp-park-context.test.mjs tests/room-acp-context-limit.test.mjs tests/room-acp-stale-wakes.test.mjs tests/room-acp-poll-scope.test.mjs tests/room-acp-no-reply.test.mjs tests/room-acp-formal-delivery.test.mjs tests/room-acp-chat-retry.test.js tests/room-acp-claim-retry.test.js
/Users/johnpotter/.local/bin/node --test tests/room-acp-park-context.test.mjs tests/candidate-manifest.test.js
/Users/johnpotter/.local/bin/node scripts/candidate-manifest.mjs --write
```

The causal-before run uses the exact original bridge file from git, restored in a
finally block after the run, without altering the test's HTTP backend. Two earlier
fixture setup attempts are preserved separately: inherited message-ID collision
and chat-flood refusal, neither a runtime falsifier. The final fixture uses unique
message IDs and advances only its synthetic Store clock by 2,001 ms between seed
writes, preserving the actual rate guard. No test timeout or production budget
was increased. All raw logs have SHA-256 digests in qualification.json.
