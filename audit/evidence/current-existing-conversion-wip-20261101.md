# Existing-room current conversion: offline WIP

This is not a release qualification, deployed change, or a claim that the production blob problem is fixed.

Executable checkpoint: `node --test tests/replay-current-h-messages.test.mjs tests/normalized-current-serving.test.mjs` (24 passed). Existing legacy room → bounded immutable H capture/hash/codec → complete work-default/ref qualification → dual message membership/fields/body-ref/ancestry/pin qualification → actual target metadata/proofs → independently bound post/reply tail → canonical comparison → atomic current head/carrier → actual post/reply → work propose/accept/start/result/complete/read saved bytes. Full state equals the pre-publication shared-reducer state; `auditRecovery` passes. Existing canonical hashes are unchanged at activation. An admitted concurrent-arrival control commits 10 arriving posts in 50 conversion units, with zero backlog at activation; this is a Node control, not Worker capacity evidence.

Metadata admission uses the current prospective metadata hash. Historical checkpoint sequence/hash remain separate, nullable and untrusted; pre-H provenance remains UNKNOWN and certification false. Missing/wrong metadata proof and unregistered metadata mutation controls refuse. Active source mutation exclusion uses the existing format permit plus a protected migrationFence metadata witness. Target metadata is not served before an independent ready receipt and final head barrier. Publication tombstones the fence in the same transaction. Message membership witnesses contain sequence + existing canonical entity hash, never duplicate bodies.

Next mandatory work:

- Actual Worker migration/restart/fault/cost/net-drain qualification, including exact current recovery pair. Existing 2537 cost receipts do not certify this changed source.
- Default composed context/Orient, activation/Begin and selected work context still invoke legacy whole-room/work reads; these routes remain unsupported and must use bounded current readers. Optional room-guide hooks also still require removal or conversion.
- Existing canonical-messageAuthority source needs full incremental content qualification; archived retained-ID target conversion and since-join history-floor qualification remain explicit no-publication refusals. Large/inactive member context still needs bounded addressing.
- Conversion tail currently admits message.posted and work_claim.updated only; work-changing posts, work/membership/retention/expiry/other event dependencies must be added or explicitly refuse. Ordinary normalized work actions already use the actual endpoint.
- Abandon/cleanup of partially populated target metadata and same-head recapture require reconciliation; no automatic proof adoption or historical certificate is allowed.
- Privacy/account/room deletion and all remaining serving readers/writers require composed qualification; production integrity/replay diagnosis limitations remain open. The old historical journal-gap red remains preserved.
- No floor45 activation, merge, deployment, historical proof stamping, or grant widening occurred.
