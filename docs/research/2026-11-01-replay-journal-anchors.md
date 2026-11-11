# Journal provenance boundary for bounded replay

Current source checkpoint: 1264d5ca6e2ffacfe18b0f3d5ef5a25970029dee. Product activation and publication remain off.

## Preserved causal refusal

Run `/Users/johnpotter/.local/bin/node scripts/controls/replay-journal-gap.red.mjs` from this worktree. It currently exits 1 with the intended missing-refusal assertion. The fixture is synthetic: a posted body at sequence 3 is hidden by deletion at sequence 4. An absent-trigger interval allows sequence 3 to change; recreating the exact original catalog rows leaves every tuple identical, the source epoch zero, and both serving and rebuilt final state unchanged. Witness hash and codec partition complete but are explicitly uncertified. Existing recovery accepts the mutated journal. This red must remain separate from the completed projection-witness inclusion controls. It demonstrates why current schema equality, projection hashes, and final state equality cannot authorize historical source bytes.

## Existing anchors and their actual coverage

| Existing contract | Coverage | Journal admission consequence |
| --- | --- | --- |
| integrity_room_state metadata/projection hashes and integrity_snapshot content digest | Current projection metadata, current independently proved entities, room ID and sequence; store.mjs and write-integrity.mjs | Does not authenticate hidden deleted historical bodies. |
| projection_checkpoints | Stored projection and checkpoint sequence; recovery checks room ID and bounds | No exact raw journal prefix digest. |
| messages replay cursor/staging anchors | Checkpoint state, sequence and event ID | Matching event ID does not prove unchanged body. |
| Current message entity hashes and archive membership checks | Existing independently proved complete current row fields and archived membership/count | Required serving parity, but not an authority for all old journal bytes. Missing old entity proof must refuse. |
| Whole-store export trailer v1 eventsHash | Room ID, sequence and event ID tuples | Does not include body. Cannot anchor exact event content. |
| Whole-store export trailer v2 table digests | Complete sanitized exported cells and row counts | Valid retained acquisition proves those exact export bytes; neither a fresh current export nor its self-generated digest proves first trust in raw source. |
| Approved historical replay receipt contract v1 | Exact raw UTF-8 room-scoped prefix sequence/ID/body bytes, bounded by throughSequence/headEventId, emitted after independent serving equality and successful parity | Eligible only when the original independently retained successful receipt exists and its exact raw prefix matches. No date-only exception and no extension beyond its prefix. |
| Independently acquired physical SQLite artifact digest | Exact complete raw file bytes, including selected event cells, if acquisition identity and immutable artifact are independently retained | May qualify an offline raw-prefix anchor after exact file verification and bounded selected-row extraction. An unknown, normalized or transformed file refuses. |

The shared historical prefix source is root-approved 5946fc31a67b33f2f489db277dbf7a83dcdbaeea (final adoption candidate 4ca61c2d61782e31ae1f801e455a6617a8de3c77). Its raw API requires Uint8Array/ArrayBuffer from CAST AS BLOB, fatal UTF-8 and exact roundtrip, including BOM preservation. A consumer must reuse this codec rather than driver-decoded TEXT or another normalizer. The existing strict reducer remains the default; only the exact proved prefix may use the approved historical adapter. Grants are not reconstructed as authority.

## Available Oct31 artifact

The retained original acquisition manifest is room-backup-manifest version 2 with thirteen parts. The 216,980,488-byte backup exactly matches acquisition SHA-256 e4e113ee3d1d712840c3187fb4ae5d196e331f3cafdefeb3be2cce4b061e6867. Its watermark explicitly declares sanitizePolicy 2 and has no sourceSchemaVersion. Thus its acquisition identity is verified, but it is refused as raw journal authority under this slice. The normalized SQLite derivative used for previous Muse shape measurements is additionally transformed and also refuses. Neither refusal is evidence of source corruption. No new live calls were made. No private rows, room IDs or bodies are published here.

## Next bounded implementation contract

The explicit offline boundary will accept only an independently retained acquisition identity for an immutable raw physical artifact, or an existing successful exact historical-prefix receipt. It will refuse unknown acquisition, transformed/sanitized inputs and missing anchors before reducer invocation. A newly computed prefix digest is a derivative of admitted independent evidence, not a first-trust baseline from current rows.

Within the existing typed sidecar and immutable operator phase receipts, the admitted anchor will bind artifact/receipt identity, room, captured H/head ID, exact contiguous sequence/ID/raw-body prefix digest, event count and byte totals. Bounded event chunks will be staged with byte/row admission before BLOB materialization. Completed chunk commitments and continuation must be atomically bound to the independently expected full prefix root/digest before any chunk is eligible for semantic replay; local self-hashes alone are insufficient. Subsequent reads verify inclusion and receipt identity before invoking the existing reducer. Changed source, pointers, receipt index, invalid UTF-8 and interrupted partial state refuse or roll back. Historical receipt retry stays historical after later progress.

The first passing source controls will use independently pinned raw synthetic artifacts; the real sanitized backup remains an explicit refusal control. Later controls must cover prefix loss/restart, prior hidden event mutation, later modern events, interrupted writes, archive full-field parity and complete membership, continuous appends, physical/whole-store recovery, and explicit derived-unit abandonment before old-writer rollback. Legacy cursor/snapshot and all current serving rows/proofs remain byte-identical until a separate bounded independent parity and exact-head final barrier succeeds. There is currently no eligible live Muse conversion claim and no completed semantic/publication consumer.
