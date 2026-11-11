# Fresh wake discovery beside preserved recovery

Client source `f6ecc372dcb31886caed50190a9211f35911dc50`, based on main `dd9f34d324ad32eb359bd48d7eb6eafa98dfc14b`. This tree adopts the separately owned server `31f2130ed` + `3041b4188976b3d7ccf2a38056edd933bca3dfce` as local `5fc81a436` + `469a01ce6` for actual HTTP qualification. Root already has that server patch; cherry-pick only the client source, then this evidence. Root regenerates combined manifest.

## Exact behavior and limits

Only an acquired listener heartbeat with exact `wakeSelection:{version:1,newest:true,roomId}` enables probing on a bridge with at least two sessions. Capability requires the server's already installed and receipted bounded wake indexes. No DDL, key, permission or new registry is created. Old servers and one-session bridges retain original oldest-only behavior. Explicit newest responses must echo `order:'newest'` and the exact selected room, and contain no foreign-room wakes; ignored selection fails closed.

One bounded recent head peek precedes each original oldest page. Every HTTP poll uses the same existing interval and shared cooldown. Recent continuation is not a recovery frontier: the oldest cursor remains independent and advances across finite cycles. A quiet thread outside every head window is eventually reached by that cursor even while new head arrivals continue. One cycle can perform up to 20 recent plus 20 oldest polls, paced by the existing 2.5-second total-poll interval. Routing/context/cooldown delays can increase discovery latency.

Each head probe designates only its newest eligible ordinary root. Seen signals, existing receipts of any phase, formal request roots, a matching parked-root fact, and unresolved/denied authors do not consume this designation. Protected source-author and listener checks still run at execution. Nothing acknowledges or silently completes a formal, queued, started, uncertain or undelivered result.

At four sessions: at most one priority turn runs, at most one queued root retains the pending priority designation, and three recovery turns may run. A newer waiting ordinary root can demote the prior pending designation into the original normal FIFO without losing or reordering its inputs; an older candidate cannot displace it. Active same-thread turns are never preempted. The reserved slot can deliberately idle. This is not an unconditional response-time guarantee or a global cross-host scheduling rule.

## Evidence

Before: the bounded queue control fails because all four slots start historical work (expected three); same-thread preservation control passes. After: 109/109 focused checks pass, zero skipped. Controls include 50 historical newest roots followed by a newer question, bounded pending replacement, continued recovery, same-thread exclusion, one-session FIFO, ignored/wrong-scope selector refusal, exact capability, eligibility exclusions, oldest cursor progress outside the recent window, existing formal/unknown delivery/restart/claim/privacy/parking behaviors and candidate manifest.

Actual local HTTP fixture: 500 older wake records and three held historical prompts; a newly enqueued independent question is discovered through real newest polling, delivers a useful body in the fourth slot, and ACKs only its own signal while the original three turns remain held/unacknowledged. Existing terminal receipt replay and a new Bridge instance reusing saved receipts do not repeat model execution or POST. Discovery observation 17.36 ms; subsequent delivery observation 51.37 ms; 22 instrumented HTTP requests from discovery. These are local synthetic-host observations, not model/provider latency, Cloudflare CPU or an SLA. The fixture does not emulate an 18-hour wall-clock delay. No live listener test or Native Worker test was run by this client lane; the server owner separately qualified the reverse-index Worker path.

An intermediate queue-only test had an incomplete test cleanup gate and was explicitly terminated; the corrected control releases all gates. No live host was stopped. Final ESLint exits zero with one test-only prefer-const warning (outer bridge binding is retained so early fixture cleanup is safe), secret scan and diff check pass. Official manifest: schema 45, 182 assets.

```sh
node --test tests/room-acp-fresh-priority.test.mjs tests/room-acp-fresh-http.test.mjs tests/room-acp-queue-fairness.test.mjs tests/room-acp-wake-drain.test.js tests/room-acp-poll-scope.test.mjs tests/room-acp-authority-view.test.mjs tests/room-acp-formal-delivery.test.mjs tests/room-acp-chat-retry.test.js tests/room-acp-claim-retry.test.js tests/room-acp-park-context.test.mjs tests/candidate-manifest.test.js
node node_modules/eslint/bin/eslint.js room-acp/src/bridge.mjs room-acp/src/queue.mjs room-acp/src/room.mjs tests/room-acp-fresh-priority.test.mjs tests/room-acp-fresh-http.test.mjs
node scripts/secret-scan-diff.mjs --base 469a01ce6
```

Raw-byte log hashes and compressed logs are saved beside this receipt. No private transcript or credential is included.
