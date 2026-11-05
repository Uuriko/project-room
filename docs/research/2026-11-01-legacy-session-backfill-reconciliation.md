# Explicit historical-session backfill reconciliation

Design checkpoint from main `0f83478a9d7646f8297547723b06802cedc1167b`.
This is an operator action on one admitted room, not a new global replay rule.
No production mutation or proof baseline is authorized by this document.

## Source boundary

PR749 introduced three session-to-work lifecycle assignments after the known
historical journal was written. The current exported journal is independently
captured and unchanged from the private reference. Reverting exactly those
assignments in a forensic counterfactual replays its 25 events successfully.
Production code must instead reuse public `applyEvent` and restore only those
three exact coupled state effects in an explicit historical adapter. Public
reducers, command timestamps, permissions and modern transitions remain strict.

The private older serving snapshot is not current serving authority: it lacks
independent metadata/message proofs. Its historical output differs only in
messages and known receipt/work-control shape fields. This observation does
not permit normalizing arbitrary live differences or minting new proofs.

## Existing operator boundary

Add `repairKind: pre749-session-backfill` to the existing legacy-repair
plan/execute input. Ordinary message-index repair behavior remains unchanged.
The historical mode accepts exactly one room and an expected head, plans from
current source and independent serving proofs, and uses a phase-namespaced
receipt in the existing `operator_actions` transaction. No table, flag or new
endpoint is needed.

Before parsing variable data, admit the complete selected unit: at most 64
events and 256 KiB aggregate UTF-8 bytes across event source, projection,
referenced work/message/body rows, target snapshot, detached anchor parts and
all variable headers/control/receipt input. Numeric-affinity SQLite columns
need CASE/typeof/range guards before materializing them. Every row family is
individually count-bounded. Archive markers always refuse. No fleet scan,
bootstrap, global backfill, opaque repair helper or fallback hydration runs.

Inventory must prove all of the following inside an exact-head transaction:

- Healthy independent current metadata proof and complete work/message
  membership/proofs, including missing references. Canonical message authority and archives refuse in this initial mode.
- Current replay's first rejection is the recorded board quarantine caused by
  the named pre749 coupling; the explicit historical adapter strictly replays
  all admitted events without weakening any other reducer check.
- Historical output equals full current hydrated metadata, work records,
  message records/index fields/posting sequences and current grants. No shape/default normalization is performed; a missing proof or any mismatch refuses.
- All source, serving proof, cursor, quarantine and snapshot bytes are bound in
  the plan hash. A changed head, source or current proof invalidates the plan.

If these checks pass, the action may rebuild only the derived replay snapshot
at the already-proved current head, remove the admitted obsolete detached
anchor/quarantine and reconcile the target cursor/certificate through a narrow
messages-store helper and existing parity checks. This transition is explicit
in the receipt, never a silent cursor reset. Every serving row/proof byte,
projection, event, grant and retained projection checkpoint is preserved.

Any output overflow, storage error, interruption, parity mismatch or failed
audit insert must roll back the complete slice and its receipt. Retrying an
identical request ID returns its original receipt without additional work;
changed intent conflicts. Future events use the ordinary current reducer from
the corrected exact-head snapshot. Dates alone never grant repair authority.

## First regression

`tests/legacy-session-backfill-repair.test.mjs` contains a wholly synthetic
historical session/lifecycle sequence seeded by a trusted historical-writer
fixture, then quarantined by the actual modern backfill. Existing repair
refuses the explicit mode (red); the modern direct-command rejection is green.
No private room/event/member identifiers or payloads are present.

## Explicit absent-proof adoption

The default mode above remains strict: its input fingerprint and plan hash do
not change, and an old saved execute receipt remains an exact retry without
inventing new evidence. Missing versus present-invalid message proofs now have
separate fixed `repairCheck` values.

A separate operator opt-in, `messageProofMode: adopt-absent-inline-v1`, may
justify only SQL `NULL` message hashes. It never accepts an empty, malformed or
mismatched present hash. It requires independently protected full inline or
verified body-reference messages; any `_entity` message reference refuses.
Metadata/content/work/body witnesses, complete row membership, every original
posting position and the full historical replay must still agree.

For older read representations, clone the independently protected state and
use only the existing `ensureWorkControlDefaults` and `messageChannelId`
semantics. Every existing value and array length must survive unchanged;
explicit null or malformed values cannot be washed into a default. The complete
read view must equal the historical replay. Every persisted message proof field
then matches the shared current writer codec, including exact scalar fields,
null reactions and complete structured record/extras JSON with no ignored keys.
JSON key order and whitespace may differ, but the original row bytes remain.
The exact original row bytes, not a rewritten record, receive the justified
hash. Existing global message parity accepts either the complete literal old
channel representation or the complete reader-defaulted representation, never
a mixture of independently chosen fields.

Plans bind the explicit mode and all source bytes but write no proof. The
prospective hash bytes share the original 256 KiB input/output/receipt unit.
Execute repeats the inventory, stamps only still-NULL hashes, verifies the
persisted write proof, reconciles derived state and saves the receipt in one
transaction. Any storage, parity or audit failure rolls back all of it. The
opt-in response reports `derivedOnly: false`, explicit planned/adopted proof
counts and `servingContentChanged: false`; projection, work/message content,
events, grants and existing non-NULL hashes remain untouched.

Successful new execute receipts also carry `replayContract` version 1, kind
`pre749-sessions`, adapter version 1, the room, exact prefix boundary and event
ID, the independently matched snapshot hash and an exact event-prefix digest.
The shared `historical-replay-contract.mjs` frames the versioned domain, room,
and each contiguous sequence/ID/raw-body value by UTF-8 byte length. An ordinary replay
consumer must revalidate that exact prefix, apply the named historical adapter
only through that boundary, then use modern rules. The receipt is evidence,
not a global replay override. Old receipts do not acquire a contract on retry;
backup/export and recovery consumers must preserve and validate the contract
before claiming historical recovery after checkpoint loss.

The private backup rehearsal uses a read-only Oct31 backup and captured matching
25-event source in a prospective in-memory test fixture. It is a feasibility
check with newly staged test-writer witnesses, not proof that the original
backup or current production serving state is eligible. No production repair
was executed while implementing or qualifying this mode.

Prefix evidence requires raw SQLite BLOB reads for IDs and bodies after the
existing count, octet-length and SQL type admission. Shared fatal UTF-8 decoding
and exact roundtrip validation refuse invalid TEXT bytes; driver-decoded TEXT
cannot supply provenance. Valid UTF-8 keeps the same version-1 digest framing.
The 256 KiB bound is the admitted input/output/receipt unit, not a total heap
ceiling: raw buffers and decoded strings coexist during this bounded check.

Ordinary saved-contract recovery and its bounded room/head receipt discovery are
documented in [the existing operator runbook](../OPERATOR-LEGACY-MESSAGE-REPAIR.md#saved-contract-recovery-after-checkpoint-loss).
