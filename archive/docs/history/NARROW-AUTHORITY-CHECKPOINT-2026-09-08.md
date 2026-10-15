# Fresh authority, less decoding

## Implemented

Runtime `7a091c7560c8d1d2237f86559c289f2d6df8122d` adds one internal
`roomAuthority` read: committed sequence, owner ID and complete member records.
Fixed SQL JSON paths select those fields from the existing projection. Ordinary
credential authentication, account-session membership, managed-agent sponsorship
and invitation membership-evidence verification now use it. No caller-supplied
authority, cache, new endpoint, schema, index or stored format is introduced.

The invitation verifier still checks the original complete joined-event envelope,
journal, binding, sequence and membership provenance. Credential and parent
revocation/expiry, account epoch, sponsor ownership/revision, member status,
permissions and session binding retain their existing checks. Each invocation
reads storage again within its existing transaction boundaries. Returned members
are freshly decoded objects, not mutable aliases shared across callers.

## Evidence for the change

The [previous baseline](DISCOVERY-STORAGE-READS-2026-09-08.md) showed four full-room
decodes per legacy operation and seven for managed agents. A paired local probe
compared current full selection/decoding with fixed-path extraction on identical
disposable rooms: ten warmups, five alternating batches of 50 reads per method,
exact consumed-value equality and no writes. Before implementation, median narrow
read times were approximately 0.017–0.018 ms / 0.114–0.122 ms / 0.490–0.498 ms at
the three sizes, versus 0.036–0.037 / 0.377–0.423 / 1.787–1.805 ms for full reads.

These are warm sequential Node microbenchmarks, including statement preparation,
SQL selection and JavaScript decoding—not HTTP latency, CPU time or Workers
performance. Later runs overlapped other qualification work and showed greater
timing variability; raw ranges are retained. Tests assert parity, never speed.

All four client operations now decode the full room once, plus three narrow reads
for legacy agents or six for owner-connected agents. The narrow text is 1,244
bytes in these fixtures; it can grow with membership. Total database projection
selections remain four/seven. SQLite still processes the stored JSON text; the
reduction below is specifically input passed to JavaScript JSON decoding.

| Work / messages | Legacy before → after bytes | Managed before → after bytes |
| --- | ---: | ---: |
| 10 / 20 | 98,412 → 28,335 | 172,221 → 32,067 |
| 100 / 250 | 1,113,572 → 282,125 | 1,948,751 → 285,857 |
| 400 / 1,200 | 5,001,972 → 1,254,225 | 8,753,451 → 1,257,957 |

This is 71.2–74.9% less JavaScript projection input for legacy agents and
81.4–85.6% less for managed agents. All six final scenarios, three rotated repeats
each, preserve HTTP body sizes, client result sizes, request counts and all
20-table recovery audit hashes. No human read marker advances. The instrumentation
counts both narrow and full reads so moving work into SQL is not hidden.

SQLite documents that JSON text still needs internal processing; selected JSON
extraction is not constant-time storage access. No JSONB migration or caching was
needed. [SQLite JSON documentation](https://www.sqlite.org/json1.html).

## Test findings and coverage

Nine new Node tests cover exact narrow value/provenance parity, independent return
objects, missing rooms, legacy and managed keys, human room sessions, owner and
invited account sessions, wrong session bindings, transaction snapshots across a
second connection's commit, and fresh state after that transaction ends. Six of
those tests change member/sponsor/credential state after identity preflight or
immediately before the committed response read and require denial with no weaker
retry. Existing tests cover rotation, expiry, sponsor/account suspension and
non-resurrection, invitation evidence and recovery.

The strengthened Workers test initially failed because its new no-full-read
assertion also exercised invited participants: their evidence verifier still read
the full room. That assertion exposed an incomplete optimization, not a production
access bypass. The verifier now receives the same complete member evidence and
sequence via the narrow read. Node and Workers tests cover invited identities,
and the Workers test repeats all credential modes after a real local restart.

Final qualification:

- 579 core/API/package checks pass on the final source.
- 26 selected desktop/touch browser journeys pass: discovery, contribution,
  reconnect, connection lifecycle and cross-session behavior.
- Two additional exact-commit desktop/touch fallback recovery journeys pass.
- 13 local Workers checks pass, including actual retained schema12 candidate →
  pause → fallback → candidate switching on populated data, plus older migrations.
- All 65 packaged files match source. All 19 public assets are byte-identical to
  prior candidate2553d73. No visual redesign or new screenshot-inspection claim.

The broader 176 browser suite and Workers browser check were not rerun. Simulated
humans and scripted MCP participants are not native-model acceptance or human
retention evidence. No real-user latency or retention improvement is claimed.

## Retained artifacts

Package directory, relative to the integration repository:
`../project-room-runtime-packages-20260908/candidate-7a091c7`.
65 runtime files, 19 assets, schema/writer12; source tree
`91af058bc68807c757597ad98b2eb701f0a89520`; manifest SHA256
`0749f5fb5e7b068474664c7dbc3ce7defcd6f940bce690ca9060e5898db560ec`.
Fallback `4d22189ccdebc56db23397e6cc75b07eff0e3c2c` is unchanged and verified.

Sibling `evidence-narrow-authority/` retains `before.json` (probe started before
runtime edits), `after.json` (initial implementation) and `final-7a091c7.json`
(final frozen source including invitation evidence). Older baseline and package
evidence remain untouched. Local Workers restart evidence is retained at
`/var/folders/h3/r7zqdttd19v3xzb_q69dqkzc0000gn/T/project-room-cf-store-0clTYM`.

## Next and boundaries

This addresses repeated authority decoding, not all large-room work. Return to
an integrated crowded-room human/agent journey: find the next useful task, recover
context after absence, contribute and inspect a result. Measure friction across
that whole flow before further isolated optimization or adding controls. Keep
future selected-task storage shaping separate and evidence-driven.

No native models, paid compute, deployment, push, live migration, preview restart,
new automation or external service action. Native-host usage approval, independent
current-authority/hosted recovery, publication and real-user retention evidence
remain separate open gates. The overall product goal is active and incomplete.
