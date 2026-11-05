# Presence private-target query qualification

Runtime source: `42e0ca1c108212a4348a9243fea6f7a1a95d5b52`, base `bf089acfcf7dd1987ca3f04753264a4a1bcb88d2`. Root verified base runtime identical to deployed `7ee5ad65a6628cd2b959c4561889e5741b3561e7`. Actual probes used these local checkout sources, never production. Parent reports a recorded 30,174 ms CPU / 44,966 ms wall presence invocation, outcome **canceled**, not a confirmed CPU-limit exception. This experiment proves a synchronous cost defect; it does not establish the sole production outage cause or recovery.

## Source and fix

`cloudflare/room.mjs` ProjectRoom.fetch → shared HTTP handler → `server/http.mjs` presence route authenticates/rate-checks and selects current SSE watcher IDs → `RoomStore.presence` read transaction authenticates again → `presenceMembers`:

- Reads fresh room authority; `room()` hydrates/deep-freezes the whole legacy projection on a cache miss, including work/message/body sidecars. Sequence cache hits skip hydration until the room changes.
- Iterates all current work and `workClaims.list(roomId)` (full board decode) to derive held/executing work.
- Computes last-command stamps from complete event history, member-added stamps, and per-agent identity/host/queued-wake/directory facts. Host status is currently fetched twice for each agent. These remain existing costs.
- The old privacy filter evaluates a correlated history EXISTS for every edit/deletion/redaction/poll/pin follow-up. Warm projection caching cannot eliminate it.

The single runtime hunk materializes private originals once, then reuses separate id and JSON messageId membership sets. Separate sets retain SQLite TEXT-column versus JSON-value affinity; COALESCE maps NULL membership to false, matching EXISTS. All six private follow-up types, unrelated event types, mixed actors and foreign rooms remain equivalent. No schema/index/DDL, permissions or response fields change. History scanning and temporary sets remain proportional to history size.

## Actual Native full HTTP service measurements

Workerd / SQLite-backed Durable Object; production ProjectRoom and HTTP handler, synthetic initialRoom/events, 64 active members. Each history contains N posts plus N edits and 65 bootstrap/member events. Twenty percent of posts are private. Fresh isolate restart precedes cold samples; constructor SQL/time is excluded. Counts intercept underlying ctx.storage.sql.exec, including raw permit SQL, rather than relying only on adapter observation. Adapter materialized result bytes are separately counted; payloads are ASCII. Concurrent samples aggregate two overlapping HTTP calls in the same DO, not per-request attribution.

| Posts + edits | Phase | Before SQL rows read | After SQL rows read | Before / after observed wall |
| --- | --- | ---: | ---: | --- |
| 1,000 + 1,000 | warm | 906,240 | 9,141 | 381 / 5 ms in initial fleet run |
| 2,500 + 2,500 | cold | 5,640,091 | 22,342 | see exact final JSON |
| 2,500 + 2,500 | warm | 5,640,090 | 22,341 | about 2,350 / 8 ms |
| 2,500 + 2,500 | concurrent pair | 11,280,180 | 44,682 | 4,756 / 16 ms |

All final responses are HTTP200 with 64 members. Fixed clocks/history produce byte-identical complete response SHA256 before/after at both sizes, across cold/warm/concurrent calls. Every sample reports zero SQL rows written and zero unavailable cursor counters. Cold 2,500-post hydration weight is still 1,259,384 bytes; aggregate adapter result size 1,406,776 bytes. Warm hydration is zero, but adapter results still total 68,397 bytes. The expensive query alone contributes 5,639,945 before versus 22,196 after rows at that size. These are local observations, not CPU measurements or production guarantees.

Initial 100/1,000-post tests on both exact6a64 and bf089 reproduce identical read counts. A larger 5,000-post +5,000-edit fixture fails honestly during seed at the Native projection row ceiling; its failure log is preserved and not reported as measured presence behavior. No attempts to bypass that ceiling.

## Checks and reproduction

- `/Users/johnpotter/.local/bin/node --test tests/presence-private-target-query.test.mjs tests/presence.test.js`: 3 pass, 0 fail/skip. Includes 90 independent original-query equivalence datasets over SQL NULL, strings, numeric/boolean/array/object JSON, both original-id forms, all six follow-ups, actors and room separation; EXPLAIN rejects correlated scans in actual captured production SQL.
- `node --test tests/presence-states.test.js tests/agent-presence.test.js tests/agent-presence-http.test.js tests/private-existence-boundary.test.js`: 48 pass, 0 fail/skip.
- Focused ESLint: exit0, zero errors, 30 existing raw-members warnings.
- Actual Native final runner: exit0; final JSON contains 12 samples (16 HTTP calls). Hash equality and cost-growth assertions independently verified.

Exact executable fixture and runner are gzip files here. Decompress to a temporary directory; the runner references the preserved old/fixed checkout paths and the fixture template `/tmp/presence-cost-1101/fixture.template.mjs`. The existing checkout Cloudflare dependencies provide esbuild0.28.2 / Miniflare4.20260730.0; compatibility date2026-07-30/nodejs_compat. Replace checkout paths explicitly for another machine. All source/log hashes are in qualification.json; raw generated bearer values never enter saved logs/artifacts. Initial fixture errors (edit revision, Host and trusted visitor-IP requirements) are retained separately and were corrected without changing production guards.

The Graphify result is advisory only: graph ffc20d378 predates this source and identifies presenceMembers; current source and executable calls above establish the path.

Offline normalized45 source at root aa4a88c211cf65c956e0ae926966842de6b8a157 already has `presence → currentPresenceMembers`: protected roster plus bounded host-window observations, explicit execution/held-work/queued-wake not-evaluated coverage. It does not traverse event history or hydrate the legacy room/board on that branch. This is a source comparison, not qualification or deployment of that offline format. The legacy query repair does not activate it.

Large measurement JSON files are stored as deterministic `.json.gz` files. Use `gzip -dc <file.json.gz>` to inspect the original JSON. `measurement-encoding.json` pins decoded hashes and sizes; compression round trips were checked byte for byte. Runtime and measurements are unchanged.
## Finite readiness contention supplement

After freeze, the same admitted 64-member /2,500-post+2,500-edit workload ran two presence HTTP calls alongside the **actual outer Worker `/api/ready` and its probeStorage RPC**. The fixture remaps its namespace name to the same disposable seeded DO; no readiness implementation/deadline changed. Each version was seeded, cold-reopened and warmed first. The old response was HTTP200 after 4,909.8 ms at the Node controller; the Worker reported probeWait2,445 ms against its existing2,500 ms budget. The new response was also HTTP200, after22.1 ms controller /9 ms probeWait. Both underlying SELECT1 probes logged0 ms on their I/O-bound clock. **No timeout was reproduced.** The finite experiment links competing synchronous presence work to readiness delay locally; it does not prove the cause or recovery of production46-second RPC cancellation. Arrival order, local Miniflare scheduling and separate clocks limit extrapolation. Exact source, logs, results and digests accompany this supplemental receipt; no runtime changes after42e.
