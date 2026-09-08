# Lean work discovery

## Implemented contract

The existing authenticated snapshot route accepts `?view=work`. It returns
`snapshotView:"work"`, `snapshotVersion:1`, committed sequence, viewer/session
metadata, Room brief and state containing only Room, members and current work.
It omits messages, event tail, read marker, reply-request state and prior work
receipts/checks/decisions. Selected-task and discovery reads share the same
allowlisted current-work record helper. Default snapshot behavior is unchanged.

Focused/search agent orientation requests the view; full orientation and public
`snapshot()` remain unchanged. Search phrases stay local. Matching, ranking,
focus-before-limit, next-step/action descriptions, tool count and one evaluation
clock remain unchanged. No schema, UI, dispatch, permission or read-marker change.

Pinned identity checks cover the new request, including room, member, kind, active
status and absent human-session bindings. Client validation checks the versioned
envelope, current record shapes, member permissions, sequence and brief consistency.
Unexpected versions/partial shapes fail without an automatic weaker read. A legacy
full-snapshot response can be used directly, with its consumed envelope/current
records validated; unused historical content is not replay-audited by the client.
Transport/authentication errors do not trigger a fallback request. The actual
retained schema12 fallback works, retaining its higher transfer cost.

An initial compatibility test failed because the new validator unnecessarily
required an unrelated reply-request advertisement, absent in fallback4d22189.
That field is now optional for legacy responses (and must be1 if supplied).
Identity, current-work and legacy envelope checks remain in place. The final core
test regenerates that exact commit into a disposable package rather than depending
on a sibling artifact directory being present in a fresh checkout.

## Measured result

Same fixed scenarios and three repeats as the
[preserved baseline](DISCOVERY-TRANSFER-2026-09-08.md). All search-result bytes stay
identical; all reads retain two requests, including one identity check.

| Work / messages | Prior discovery body bytes | New body bytes | Reduction |
| --- | ---: | ---: | ---: |
|10 /20 |52,304 |11,910 |77.2% |
|100 /250 |361,321 |103,981 |71.2% |
|400 /1,200 |1,333,622 |411,782 |69.1% |

These are decoded local HTTP body bytes, not compressed wire traffic, model tokens,
latency, memory, Workers CPU or observed user workloads. Current work transfer still
scales with work count; authentication and storage still parse the full Room
projection. This is not a constant-size service search, access restriction or
complete large-room performance fix. Full snapshot and selected-task measurements
are unchanged. Baseline remains preserved separately from optimized output.

## Verification

569 core/API/package checks and six actual local desktop/touch browser journeys
pass. Five new snapshot tests cover strict selectors, authentication/session
bindings, no historical/private conversation fields, absence of event/cursor
queries, corrupted response refusal, local query privacy, no weaker retry, exact
fallback compatibility and result parity. Existing lifecycle/search tests cover
replaced evidence, missing permissions, cancellation and scope expiry.
The profiler regression verifies unrelated chat no longer grows discovery transfer.

All19 public assets match retained candidatecefc89b, so no visual redesign or new
UI screenshot is needed. The broader176 browser checks were not rerun; six key
discovery/reconnect journeys were. No native model, live data, deployment, push
or preview restart.

Final frozen runtime `2553d7329100c25591ac63ff410e4d906837fc04` passes569 core,
six browser journeys,13 local Workers checks (including the new view and account
session fence) and two exact-commit desktop/touch fallback-recovery journeys.
Retained `../project-room-runtime-packages-20260908/candidate-2553d73` is65files,
19assets, schema12, manifest SHA256:
`a6c48fa38643d787a4757959e40bbd8337af95b58e3ad9b1a96b800d8fccac2d`.
Fallback4d22189 and all older candidates are preserved. Workers restart evidence
remains at `/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-cf-store-xkQWMz`.

Actual retained client/server package measurements also match the new counts.
The new client on retained fallback4d22189 returns the same search results using
52,272 /361,289 /1,333,590 decoded bytes at the three sizes (three identical repeats
each). Its legacy full response lacks the32-byte reply-contract advertisement;
do not conflate this with the original cefc89b baseline. All package measurements
preserve full audits and manifest verification. Optimized profiler output and the
observed retained-package summary are saved under the sibling package directory's
`evidence-2553d73/`, separately from the unmodified original baseline.
These local recovery checks do not certify hosted restore or current authority.

## Next

The exact package is qualified locally. Next profile remaining full-projection parse
cost before deciding on database projection changes or server-side search. Avoid
caching authority or putting private queries into URLs. Native-host acceptance and
independent current-authority/hosted recovery remain separate gates. Goal incomplete.
