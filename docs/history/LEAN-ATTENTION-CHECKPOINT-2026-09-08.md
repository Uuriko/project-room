# Lean attention reads: verified local checkpoint

September 8, 2026. Broader goal active/incomplete. Runtime
`b2f92959c5bc3a2ce1ba95556084caad4e606a7e`; test-expanded candidate
`812b9c9747e304ec8c8ff916d15bc7d28b8631a4`. Subsequent edits only document the
checkpoint/next plan and move test teardown before server startup. **Not pushed
or deployed.** Room schema/writer 11, observer v1/v2, UI and service are unchanged.

## Improvement and measured boundaries

The observer fetches an event row once per distinct sequence within each
reconciliation. Only validated rows enter that short-lived map. Prior-checkpoint
and current-tail comparisons both still apply when they reference the same row.
A second reconciliation, later pull, acknowledgement and restart all read afresh.
Every actual pinned-client data request retains its session preflight. There is no
authorization cache, new endpoint, cross-pass history cache or removed delivery check.

An independent agent compared the verified frozen `7ac9edc` runtime package with
the current code using one disposable pinned-agent room and separate local journals:

| Operation | Before | After |
|---|---:|---:|
| Cold pull | 14 GETs | 12 GETs |
| Repeated unchanged pull | 16 GETs | 12 GETs |

That is 25% fewer requests for the measured steady pull, not a latency, token-cost,
retention or hosted-performance claim. Both versions preserved two pending notice
IDs/bodies across their repeated pull. All application-table rows and the Room
snapshot stayed unchanged: sequence 5, human cursor 0. The exact listener closed;
its synthetic directory was removed and absence confirmed.

Regression tests separately measure cold/steady/reopened/ack/re-ack reads and
pair every data request with its preceding session request. One observed advance
needs 14 GETs; advances in both passes can need 16. Do not impose a universal cap
that would drop necessary history checks. Actual MCP pull measures 12; CLI pull
measures 13 including its separate startup check.

## Why this design

Primary references checked September 8, 2026:

- [JSON:API compound documents](https://jsonapi.org/format/index.html#document-compound-documents)
  demonstrate related data returned together to reduce requests. This does not
  itself prove transactional consistency or authorize caching access.
- [Microsoft Graph batching](https://learn.microsoft.com/en-us/graph/json-batching)
  reduces transport round trips but retains independent permission, failure and
  throttling outcomes for subrequests. A successful envelope is not blanket success.

Our decision: remove a proven duplicate first while preserving the existing
protocol. A later compact observation could combine identity/current work/history
anchors inside the existing service read transaction, but needs a separately
qualified response/compatibility contract. This checkpoint does not implement it.
No external code or new dependency was copied.

## Verification and cleanup

Full **487 core/API/package checks, 159 browser journeys and 12 local Workers
checks pass**, no failures or skips; syntax checks pass. Twelve new checks cover
read budgets, distinct advancing checkpoints, second-pass creation/prior/tail
changes, final-pass revocation/expiry/wrong identity, late fulfilled anchor after
cancellation and retry, and a labeled synthetic sequence-one boundary.

Existing tests still cover same-sequence claim expiry, stable pending IDs, second
snapshot suppression, version compatibility, ownership, stop, unknown ack, replay,
genuine prior-writer migration/rollback and human read-marker separation. A first
successful pass may update local checked-at metadata before the second refuses;
the failure assertions preserve identity, history and pending contents, not an
incorrect promise of whole-operation rollback.

Root inspected fresh desktop-work, mobile-instructions and enlarged-text reminder
screenshots. The reminder screenshot is at the dialog's scrolled bottom; controls
remain readable/reachable. All public assets, service files and dependencies are
byte-identical to the previous checkpoint. Simulated browser checks are not human
feedback. This slice adds a real client measurement, not another semantic author/
reviewer exercise or native Claude/Grok/Instinct acceptance.

Initial restricted loopback tests could not listen; their handles exited. Corrected
test fixtures register teardown before startup so failed binding also cleans up.
Root removed the two exact synthetic failed-start databases and eight empty test
directories; no user data or previews were touched. An initial sequence-one fixture
assumption and test observer ownership/timestamp assertions were corrected, then
rerun. The product change did not need further fixes. Final focused 14 checks also
passed after teardown moved. Existing local Workers TLS-probe diagnostics remain
expected test output; no production certificate behavior changed.

Exact package under the project mirror:
`work/project-room-runtime-packages-20260908/candidate-812b9c9`.
60 files, 18 public assets, schema 11. Source tree
`671617c5a4fda2347eaacfc624b6bdbd3e5765c1`; manifest SHA256
`efce1e1a63ea7fa8aa344253a20cdb76736e929d5c19658f966330dd5896bb17`.
Cold packaged imports confirm the helper and unchanged 17 base/2 optional tools.
Only one of the 60 runtime files differs from the preceding package:
`client/assignment-watcher.mjs`, SHA256
`39a98635630982060edbea1c56ee8e4731da677136194f339b7aa110d60baed4`.

All test and measurement processes ended. Designed local Workers persistence
artifacts remain as synthetic evidence, not running services. Recorded live
fb90a70 / Worker 901be347 / schema 7 is unchanged and not reverified.

## Next, not implemented

The [reply-request plan](REPLY-REQUESTS-PLAN-2026-09-08.md) specifies explicit
open/answer/decline/cancel exchanges, room-visible exact messages, contextual human
controls, thin agent actions and anchored historical discovery. Independent review
added clarification-aware context fencing, inactive-requester response handling,
both resume anchors and immutable historical filtering. Ordinary replies never
implicitly answer; local acknowledgement never clears canonical requests.

Implement that full slice next, with genuine writer/recovery qualification as its
replay semantics require. Eligible work and standing roles follow. Native-host
acceptance and a qualified v11 fallback/hosted restore remain parallel release
gates; historical v8 switches are not proof for current data. No push/deployment,
live migration, provider, payment, outreach, recurring automation, Dasha/Desk or
personal inbox changes occurred. Broader goal remains active.
