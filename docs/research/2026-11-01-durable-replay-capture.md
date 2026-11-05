# Durable capture and binding checkpoint

This is the first unwired production lifecycle slice after portable witness
hashing. `server/replay-cutover.mjs` exports explicit capture/progress functions
and proposed DDL. No store-open migration, default dispatch, operator route or
schema version is activated. Capture defaults and maximum admission are both
4 MiB; quotas are unchanged. Runtime value/row headroom is checked before the
whole-value CAST, using the existing runtime limit probe.

One typed `message_replay_units` table separates room, generation, domain and
unit identities. It holds the immutable SQL-copied witness, bounded header and
hash controls, and room source controls. The existing `(room_id,part)` legacy
staging key cannot hold a second part-zero representation; its bytes and all
legacy cursor/snapshot fields remain untouched. Only one live capture may
exist per room. A different request cannot silently copy or replace it again.

A capture binds H, the head event ID, the preserved independent metadata and
content proof, source epoch, ceiling and generation. Its append-only existing
`operator_actions` receipt binds the header digest and initial portable hash
state digest. Each subsequent phase receipt binds the new hash state digest
and the original header. Therefore changing a derived control and recomputing
its local checksum does not establish trust: the independent immutable receipt
must still match. Both local-hash forgery controls refuse before progress.
Receipts use separate capture/hash namespaces, stable canonical intent fields,
and existing request IDs. A retry after later steps returns the original
receipt and does no more work. Audit failure rolls back the entire slice.

Each hash step transfers at most a 16 KiB fixed witness chunk plus bounded
controls. It checks exact generation/header/audit binding, epoch, active
capture head, original event anchor, witness byte bounds and exact expected
cursor. It never reads the growing live projection. Completion means only
that captured bytes match the preserved old metadata proof: `certified=false`
and `publication=pending` remain explicit. No archive/source semantic parity
or serving completeness certificate is issued.

Ordinary event append uses one primary-key probe of
`(room_id,generation='',domain='control',unit_key='capture-head')`.
It does not scan generation headers or leaf rows. Actual October workerd
measurements show one INSERT statement reads 2 rows/writes 5 with that guard
absent, and reads 3/writes 5 with it present, identically at zero and 17,405
derived leaves. Thus the guard adds one logical row read and no row write on
ordinary append in this fixture. These counters are SQLite logical rows,
not physical page I/O or total room-command cost. QUERY PLAN separately
confirms an indexed SEARCH rather than a SCAN.

Event UPDATE/DELETE, prefix INSERT and room-head rollback invalidate the
candidate; event rewrites also remove its privacy-bearing derived rows. These
rare invalidation/deletion operations can delete many units and are not
claimed to fit a replay step's write budget. They preserve only room controls
and append-only audit history. Room deletion cascades all owned units. This
matches logical SQLite deletion, not a physical media erasure guarantee.
Missing or changed trigger definitions refuse before new progress. Malformed
integer-affinity controls are guarded in SQL before materialization.

For this sidecar-only format, global schema floor 45 is not yet necessary:
explicit tests reopen and write through the unchanged version-44 store while
keeping the captured derivation untouched. The existing global writer fence
is unchanged. The extension has its own explicit writer guards using the
existing Node writer function or Durable Object permit, plus exact table and
trigger verification on every new operation. This is not silent fallback to
an optional schema: invoking the new operation without the exact extension
refuses. The old store does not consume or overwrite the new units.

This coexistence result does not authorize changing old checkpoint formats,
activating default replay, semantic restore or publication. Those boundaries
must separately demonstrate safe prior-writer refusal or require a new global
floor. A future global writer-version upgrade must explicitly reconcile this
extension's permit guards as part of its migration. It cannot leave old
version-specific guards behind. No global-floor increase or downgrade path is
claimed by this first slice.

Qualification: 72 composed focused Node controls, including the approved seven
shared writer-codec controls, plus actual supported Worker capture/progress at
2,376,000 bytes, process restart, interleaved appends, original receipt retry,
and 17,405-leaf guard census. Targeted lint, syntax, module coverage and diff
checks pass. Fixtures are synthetic; no current Muse eligibility or live calls
are claimed. The parent four red controls remain acceptance requirements:
this slice addresses source invalidation in the new path but does not yet
supply bounded semantic replay, independent archived parity, final publication
or durable historical replay after checkpoint loss.
