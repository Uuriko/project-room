# Production cutover contract for bounded replay

This is the proposed runtime boundary, not an activated format. Source starts
at reviewed historical-repair `142ced8c4fd72874108b432d551af4376e036131`, then
carries the existing two prototype commits unchanged. The regression checkpoint
is `cff4dddeb0ba059201988cdc0e0e8d5c6782bf98`. No runtime module, schema, flag,
production state or default behavior is changed by this document.

## Decision and completion boundary

Build one operator-selected **paged replay format** under the existing message
backfill cursor, snapshots, block reporting, operator plan/prepare lifecycle and
`operator_actions` receipts. Add a typed page table because the legacy parts
primary key `(room_id,part)` cannot express keyed domains, generations and
membership safely. Do not overload negative part numbers or synthetic room IDs.

The first production patch must be a complete vertical path: bounded legacy
checkpoint admission and transcode, real reducer continuation, independent
retained AND archived validation, and bounded final derived publication. Wire
it into existing prepare and backfill format dispatch. A format that can only
consume specially seeded fixtures is not completion. Keep the original small
operator API, its limits and conversion-only execute behavior unchanged.
Explicit input `replayFormat: "paged-v1"` selects the new preparation contract;
rooms without that committed format continue through the existing code.
This is durable representation selection, not a new feature flag or scheduler.

The prepared result can publish a proved replay/certificate boundary without
rebuilding live messages: every serving row already proved equivalent is
preserved byte-for-byte. Large-room canonical conversion is a separate existing
execute phase; this preparation must not pretend that old conversion limits
have changed. If conversion later requires a new serving representation, its
reader cutover is another reviewed contract, not a hidden prepare side effect.

## Durable representation and schema fence

Use schema v45 (or the next unclaimed version if another migration lands first).
Retain every v44 fence definition. Add an explicit versioned snapshot header to
`message_replay_snapshots` rather than replacing its legacy body during start.
Proposed added columns: `format_version`, `generation`, `control_json`. Legacy
rows have format 0; `state_json` and `messages_backfill_state` remain the exact
legacy source while a format-1 candidate is built. The format-1 control header
is at most 8 KiB and has fixed named fields, never an array of all leaf IDs.

One new table, `message_replay_units`, has these explicit columns:

```
room_id, generation, domain, unit_key, unit_kind,
row_version, payload_bytes, payload_sha256, payload
PRIMARY KEY(room_id,generation,domain,unit_key)
```

`domain` and `unit_kind` are closed registries. Domains include messages, work,
members, channels, pins, other named reducer maps, event bindings, and index
nodes. Owner/domain/key indexes support privacy deletion and point lookup.
Index nodes are separate bounded pages, not growing metadata reference arrays.
A fixed header points to a bounded forest of roots. Ordered index nodes have
at most 32 children, at most 8 KiB serialized bytes and maximum depth 8; reject
an overdeep, cyclic, missing, duplicated or inconsistent path. SQL primary-key
lookups and keyset iteration must have query-plan evidence. A directory lookup
cannot deserialize a room-sized manifest before looking up a leaf.

New source-generation controls belong on the existing room/cursor lifecycle.
A room-level source epoch advances for event UPDATE/DELETE, prefix insertion,
import/replacement, erasure, or source rollback. Ordinary contiguous append
extends the head and does not invalidate an already checked prefix. Triggers
must cover raw SQL mutations as well as code-owned writes; the existing writer
fence remains mandatory. Epoch overflow or wrong SQLite storage type refuses.
No constructor backfill/hash of all existing events or pages is permitted.

The v45 fence must cover pages plus existing events, rooms, cursors, legacy
snapshots/parts, messages and proofs. An already-open v44 writer must fail
before any incompatible write. v44 application readers must reject v45 on open;
raw SQLite readers are outside an application-version guarantee. A supported
new reader dispatches explicitly on format and refuses unknown versions,
missing roots or torn control/page pairs. No legacy fallback after a new-format
failure and no cursor reset to manufacture a healthy prefix.

At final format publication, the legacy `state_json` slot becomes an explicit
non-JSON `paged:1:` discriminator so an already-open old decoder cannot mistake
a new root for a legacy state. Before that boundary retain its old bytes and
old published cursor while transcode is pending. An already-open raw/read-only
SQLite connection cannot be denied ordinary unchanged serving reads by writer
triggers; do not claim revocation of SQLite reads. Qualify the actual old
application entry points: new opens reject schema v45, old derived decoders
refuse the discriminator, and every old mutation is fenced. Serving metadata
stays in its existing representation in this slice.

## Bounded operation and immutable inputs

Each prepare call is one stored receipt and one transaction-scoped unit:

- At most 200 fully committed events. A parser, fanout or validation unit may
  commit zero events and report its actual phase/offset/key continuation.
- At most 64 transferred payload rows and 256 KiB of total input payload and
  variable controls, including index pages and persisted parser carry.
- At most 256 KiB of serialized proposed output, admitted before writes.
  These are separate explicit input/output bounds; neither is a heap/CPU claim.
- Header/index pages at most 8 KiB; source byte slices at most 16 KiB; parser
  carry at most 32 KiB; nesting at most 64; logical keys at most 200 UTF-8 bytes.
  Keep the prototype event/message/metadata-context caps as additional limits.
  Split large text storage into bounded pages; an event whose necessary reducer
  context cannot meet the input/output contract remains explicitly pending.

Every scalar uses SQL `typeof`, CASE, range and UTF-8 size admission before it
crosses into JavaScript. INTEGER affinity is insufficient. Reject duplicate
object keys, invalid UTF-8/JSON, wrong IDs, missing parts, source gaps, oversized
keys/headers/values, manifest cycles and unsupported domains before advancing.
Durably persist parser position, lexical stack, bounded carry and a portable
incremental SHA-256 state. Test its serialized state against Node crypto across
all byte boundaries, surrogate/escape boundaries, empty input and restart.
Do not use an in-memory `Hash` object as durable continuation.

Start pins the legacy checkpoint sequence/event ID, legacy parts header and
source epoch, target head H and independent serving proof values. Format
selection makes the legacy checkpoint immutable to ordinary backfill; ordinary
appends do not rewrite it. Privacy/source replacement invalidates that pin.
Read its inline text or parts using bounded BLOB slices without joining the
parts. Persist sequence-to-ID/body-hash bindings while reading source events,
not merely the last event's hash. Same-sequence edits anywhere behind the
cursor invalidate through the source epoch. New hashes detect staging damage;
they do not independently authorize old event or serving bytes.

A legacy checkpoint is a cache, not first trust. Its checksum and source anchor
must verify; absent or corrupt checkpoints require explicit source replay under
a proved semantics contract. Normalization cannot claim that its unverified
seed prefix was replayed or certified. Header distinguishes imported cache
coverage, independently validated coverage and committed reducer coverage.

## Reducer continuation without a second reducer

Reuse public `applyEvent` and the same handler registry. Add a shared internal
context/write-set adapter, rather than copying event handlers into the paged
engine. Every supported event family must declare its read/write dependencies,
including common default-channel and work-control effects, authorization,
reply ancestry, channel companions, pins, receipt/evidence references and
public-page behavior. Missing context is a refusal, never a smaller fake room.

Maps are normalized by key and messages by ID/posting provenance. Large
non-message metadata is decomposed too: the 65 KiB whole-metadata exemption from
the experiment cannot remain the Muse bootstrap limit. Common work defaults
must run through the shared per-work decoder/handler contract, not an omitted
whole-map sweep. Multi-record effects use bounded fanout with candidate roots;
the event cursor advances only after the entire event's effects commit. Its
partial generation is invisible to readers, parity and serving publication.

Qualify every family encountered in the admitted source/tail before activating
that room. The initial edit-only experiment is not sufficient coverage for a
real historical journal. A supported-family inventory is bounded/keyset work,
not `SELECT DISTINCT json_extract(...)` over a whole room. Unsupported events
stay pending at their exact sequence; do not skip non-message transitions.
Differential tests compare full and bounded contexts, including unchanged
fields and grants, and prove rollback between every candidate/root commit.

## Independent trust, archives and live writes

Current serving authority must be independent of candidate manifests:

| Current representation | Required existing authority |
| --- | --- |
| Inline metadata/messages | Existing metadata/content proof, exact metadata serialization and complete referenced-body/work membership |
| Message references or canonical rows | Existing metadata membership proof and every existing `entity_hash`, including full indexed proof fields |
| Archived messages | Existing independently proved archive marker/membership AND a pre-existing independent proof for every archived row |
| Missing archive/entity proof | Explicit first-trust refusal; derived hashes, surviving row counts and the backup's mere existence cannot repair it |

Validate every archived record's content, record/extras, pin/thread fields and
original posting sequence against replay and its independent current proof.
Archive count is necessary and insufficient. An event-source change can leave
all serving proofs intact: the red control demonstrates precisely that case.
Existing backup byte/content digests establish the captured backup's bytes;
they are not automatically current archive authority or an authorized restore.
Never stamp newly trusted event/row baselines because replay and a freshly
computed manifest agree with one another.

Capture immutable independent proof values at H and build/verify exact expected
serving serialization from the candidate through the existing at-rest codec.
The serializer must be resumable and retain exact ordering/encoding semantics;
its final hash must equal the independent proof captured at H. Storage shape,
archive controls and retained membership are inputs that must themselves be
proved. Do not normalize unexplained shape differences to make the hash match.

The bootstrap gate now has a measured explicit operator exception. In one
writer transaction at H, first admit the existing projection using
`octet_length(TEXT)` (no whole-value CAST), exact integer/head and bounded proof
controls, then preserve the existing independent metadata/content proof and
head event ID and SQL-copy the admitted projection once into a fixed witness
value. Copying bytes does not certify them: incremental hashing must equal the
preserved old proof before any candidate can qualify. No new hash of the
current source is accepted as first-trust authority. Later witness reads use
only the immutable captured value, never offsets into a growing live blob.

This is an explicitly admitted bootstrap exception to the engineering 256 KiB
transfer/output step target, not a quota increase or a generally permitted
whole-string JS parse. The qualification ceiling is 8 MiB; a production
operator default of 4 MiB leaves existing projection growth headroom, with
any higher request explicit and still below the measured runtime value/row
limit. At 8 MiB ordinary later append already refuses the existing projection
limit. Therefore capture eligibility never promises later live writes will
fit. Actual row overhead and the runtime value limit must also be admitted.

The current experiment transfers 16 KiB chunks. SQLite may read/materialize
the fixed captured value to evaluate `substr`; a bounded output does not prove
16 KiB of native SQL work. Resource qualification includes this cost. The
latest 8 MiB run observed a 781 ms maximum slice wall time and approximately
2.25 process CPU seconds over 513 separate read requests; it establishes no
strict per-request CPU guarantee. These reads never reparse JSON or copy a
growing live projection, but the fixed native value ceiling is a distinct
resource bound that must remain explicit at operator admission.

`428aa557cca28422077b885314326bdd5e63c4e4` preserves the earlier whole-value
experiment. Its failure on the pinned July workerd does not establish a
production 2 MiB limit or failed INSERT SELECT: phase diagnostics established
`length(CAST(projection AS BLOB))` failed during admission first. Replacing
that with `octet_length` moved the older-runtime split-copy failure to the
BLOB CAST inside page-copy. The adapter maps native SQLITE_TOOBIG to
`pilot_limit`; it does not impose a separate 2 MiB fixture cap. Runtime builds,
not compatibility dates, determine the SQLite value limit.

The supported October binary is pinned in the witness qualification record.
It reports 8,388,642 bytes; both 2,376,000-byte and 8,388,608-byte one-row SQL
captures pass. The one-row Muse-sized capture is much cheaper than the split
copy, so prospective page writers are not a prerequisite for this one-time
bootstrap bridge. The existing legacy `(room_id,part)` staging key cannot hold
a parallel immutable witness while preserving checkpoint part zero; the
executable collision control demonstrates why an explicit typed unit contract
is needed rather than invented internal part numbers or room keys.

The production acceptance gate remains: portable incremental hashing and the
exact shared serving codec, complete independently proved archive membership,
source-epoch/head binding, replay continuation, old writer/read format fences,
and final publication parity. Host-side streaming hash tests establish the
captured-byte witness, not a completed portable serving certificate. No
schema/default activation or serving rewrite is part of this experiment.

For qualified representations, preserve replay progress across appends and
coalesce dirty entity/version keys in the same typed page store using the
existing writer/proof boundaries. Dirty entries are cache invalidation, not a
second task queue. Raw writes must dirty or invalidate too. A scanned prefix
is never assumed unchanged because its last event stayed unchanged. Fold
suffixes, validate dirty keys and both directions of membership with keyset
cursors; do not restart the complete room after each append. Under continuous
valid writes below measured service capacity, backlog must drain. Under faster
writes remain honestly pending, without a false current-head certificate.

## Bounded final publication

Completion at current head requires all of these inside one final transaction:
source epoch/head/event identity still match; replay coverage is complete; both
membership directions and every retained/archive record passed independent
parity; dirty versions are drained; metadata/codec proofs match; no unresolved
source/reducer block remains; all candidate pages and semantics references are
coherent. Recheck only bounded fixed controls/dirty frontier/root bindings at
this boundary, never scan/rebuild all live messages or all events again.

Commit the small format/root binding, `state_seq/replay_event_id`, then the
existing applied cursor and parity certificate plus completed receipt. There
is no mixed-generation serving table: preserve current serving row/proof bytes.
Until that commit, expose neither applied progress nor complete certification.
An appended tail can retain already validated coverage but requires replay and
proof coverage for that tail before current-head publication. Interrupt after
every write boundary; cursor, roots and receipt must roll back together.
Unknown outcome retries the original operation ID and exact input, returning
the saved result even after later progress. A fresh step needs a fresh plan/ID.

## Historical semantics are durable authority, not disposable cache

The current historical-repair patch fixes derived state but stores no complete
replay-semantics contract. Losing that checkpoint then appending a modern event
recreates the old quarantine; the new control proves this current limitation.
Strict full journal semantic restore also still rejects immutable historical
`work.accepted`. Do not rewrite the event or relax modern `work.accepted`.

Use a bounded immutable **semantics receipt** in existing `operator_actions`,
separate from disposable page/checkpoint rows. It names the exact semantics
implementation (`pre749-session-v1`), exact source interval and verified source
root, independently proved serving evidence used for qualification, source/
privacy epoch and operator operation identity. Extend the existing explicit
source-tested historical repair qualification to issue that contract only
after full equality/proof checks; an old opaque plan hash alone is insufficient
for inventing it. No date range or room name is an authority condition.

Replay only that proved prefix through the shared narrow three-effect adapter;
use the unchanged modern reducer after the boundary. Checkpoint loss rebuilds
from the original journal under that receipt and verifies its source root in
bounded units. It does not silently quarantine the already proved prefix or
resurrect old grants. Later modern commands remain strict. Reuse the receipt
across checkpoint replacement/restart; a privacy/source epoch change invalidates
it pending explicit requalification, without resurrecting erased content.

Backup and strict restore must preserve and validate semantics receipts and
implementation identifiers along with the existing audit/proof authority.
Unknown semantics, mismatched source root, missing referenced receipt or stale
authorization watermark are a visible recovery refusal. A backup that predates
the contract cannot gain it through self-certification. If checkpoint and
receipt are both absent, require a new explicit independently proved operator
qualification; do not infer historical permission from the rejected event's
date. Receipt retention/purge rules must not discard a referenced contract.
Test full semantic restore, lost checkpoint, post-prefix modern events,
missing/mutated receipt and source, erasure, and stale-grant reconciliation.

## Reader/writer and maintenance ownership

| Boundary | Required source owners and behavior |
| --- | --- |
| Format/cursor | `message-replay-snapshot.mjs`, `messages-store.mjs`: explicit read/write/discard dispatch; no whole decoder/publisher fallback |
| Schema/open | `writer-fence.mjs`, `store.mjs`, Worker storage adapter: atomic v45 registration, old connections rejected, no constructor room scan |
| Reducer | `src/events.js`, `message-reducers.js`, `work-item-session.js` and their real handler dependencies: shared context semantics, no fork |
| Operator | `operator-message-authority.mjs`, existing routes/actions: explicit format request, bounded plan/prepare receipts, execute remains conversion-only |
| Prospective writes | message/work proof writers, archive/restoration, projection writer and raw SQL fences: dirty/version invalidation in the same transaction |
| Privacy | `account-deletion.mjs`, `message-redaction.mjs`, `purge-registry.mjs` and their actual called store methods: erase/rewrite every candidate, parser carry and source/semantics reference; no resumable resurrection |
| Import/restore | `restore-ndjson.mjs`, import/reset/store initialization, `backup.mjs`: preserve coherent roots/cursor/receipts or explicitly discard derived progress while preserving serving authority and durable semantics |
| Packaging | runtime allowlist, candidate manifest, Worker check registry, schema docs and restore schema registry |

No page history may accumulate without ownership/accounting. Keep only active
and current candidate roots; bounded maintenance removes superseded pages and
orphan candidates. Targeted erasure uses owner indexes and includes parser
carry/partial event state; a room purge removes all its pages/receipts according
to the existing privacy contract. Existing full-room purge/account deletion
has separate potentially large SQL write cost: do not describe that maintenance
as a bounded prepare unit. Measure added write amplification and qualify erasure
under its existing transaction rather than hiding a new stale sensitive copy.

## Acceptance before a real room can select the format

Keep the saved prototype measurements (1k/10k/100k: four payload rows and 1,458
payload bytes versus legacy 345,553/3,459,625/34,689,626 bytes). They prove only
that edit experiment. Do not rerun or relabel them as production bootstrap,
CPU, archive parity or publication evidence.

New production controls must establish: legacy chunk/parser and manifest bounds;
leaf/index corruption and hostile scalar admission; complete event-family
coverage; no prior-prefix source mutation; independent proof and missing-row
refusals; archived full-content mismatch; byte-preserving final publication;
continuous append progress; real Worker/isolate restart; rollback/interruption
and lost receipt; v44 open-reader/writer refusal; exact old-source and strict
restore; historical semantics after cache loss; and all privacy lifecycle owners.
The codec-witness/bootstrap gate above must be proved with an executable busy-
room control before any runtime format selection is enabled.

Explicit red control command (expected exit 1 before implementation):

```
node --test scripts/controls/bounded-replay-cutover.red.mjs
```

Observed: four expected failures and one modern-command pass. Archive source
mutation is accepted by current parity; final publication materializes 40 rows
after a one-event allowance; repaired history is quarantined again after cache
loss; and the point prototype misses tampering behind the immediate anchor.
No raw production data or benchmark rerun is used in these controls.

## Graphify provenance and the first implementation order

Reuse the saved activation graph at source
`9dc769a1ed8279b1925ffd46232fc3bd1367d114`, source manifest
`a6e79269336b32f0749bb60607eaf1d2e248845ebe848e1336f7f690cd4af626`.
Its existing operator route-to-authority-to-write-integrity path is navigation,
not proof that today's owners are unchanged. Refresh only the 16 affected
replay, archive, restore, privacy, schema and reducer source files at the exact
red checkpoint using the already pinned Graphify 0.9.96 extractor. The refresh
contains 946 nodes and 1,664 structural edges; source manifest
`8fc2ff1bd671425e0289c752889eddbca881943f925c3bac8e61a2f642ec320f`.
The extraction materializes exact Git blobs into an isolated temporary tree,
uses an empty HOME, disables network and clustering, and makes zero model calls.
It does not rebuild or overwrite a hosted/full-repository map.

Artifacts are in the established audit `evidence/` directory:

- `graphify-bounded-cutover-cff4-subset.json`: current scoped graph and per-file
  source-manifest provenance, plus the prior artifact's SHA-256.
- `graphify-bounded-cutover-cff4-queries.json`: reused prior navigation and
  affected-file queries against the current subset.
- `graphify-bounded-cutover-cff4-build.log`: actual extractor output.

Graph import/call targets are advisory and may be truncated. Public reducer
handler registries, SQL triggers, storage adapters, import/restore callbacks and
format dispatch are dynamic edges that the graph cannot establish. Verify
those with source and executable controls before claiming complete ownership.

Implement in this order after root approves the boundary:

1. Prove the serving-codec witness and source authority prerequisite first.
   Extract a shared resumable encoder from existing at-rest codec semantics,
   compare its byte stream against the existing full encoder on inline,
   referenced, archived and restored fixtures, and test captured-head metadata
   verification while later appends occur. Archive/storage control provenance
   is part of this proof. If this cannot pass, revise the writer cutover before
   adding format tables; no permanently ineligible large-room format is shipped.
2. Implement fenced typed pages, bounded legacy transcode and complete
   checkpoint/source binding, with the historical semantics receipt lifecycle.
   Keep runtime format selection unavailable until the end-to-end path passes.
3. Qualify and share every encountered reducer family's context/write-set
   semantics, then independent leaf/membership/archive validation and small
   final publication. Register all privacy, backup, restore and package owners.
4. Wire explicit operator plan/prepare and existing backfill dispatch together,
   qualify actual Workers and old-reader/writer rejection, and only then allow
   a selected room to enter the format. No new default or production selection
   is authorized by this plan.

These are implementation dependencies inside one production objective. Step 2
alone is not a shippable substitute for the bootstrap/publication path.
