# Native45 restore body ingestion

This is one offline source-ingestion increment on root012395c4d, preserving protocol7 and native-work-3. It is not a bounded whole-recovery or release certificate.

The initial direct-stream prototype was unsafe: an invalid late trailer failed after immutable operator audit rows had landed. Existing cleanup correctly refused their deletion and left the target pending. Its independent controls are49fed912f; transport counterexample07b812723 must never be adopted alone. The original buffered preparse rejected the same source before importing it.

The safe implementation first stages a native45 strict upload in the existing private KV multipart format, using the existing writeKvBackup implementation and binding. A random room-restore-sources prefix never overwrites a daily backup; parts are1MiB and expire in1hour, with best-effort deletion on normal success/refusal. Source parsing is extracted from parseNdjsonExport into one shared implementation: compatibility retains complete rows, preflight retains only event tuples needed by the same verifyTrailer. Original row shape, watermark, sanitize/source basis, v2 table digests, trailer shape and event hash checks run before replay session creation. There is no new source certificate, grant or backup provider.

After complete source preflight, the existing byte/hash/UTF8 feeding loop is shared with restore-from-backup, and the same createBackupReplaySession imports it. All required target coverage, independent census, engine, strict replay and final full oracle remain mandatory. Partial/lost source uploads cannot import unsealed source data. Once a target is sealed, a repeated original body is drained/hashed and returns the existing progress without staging or importing again.

Missing KV retains the original buffered64MiB path. Historical sources and explicit new audit=report compatibility retain their original buffered behavior; report does not acquire a new mandatory v2 requirement. No source is silently labeled more strongly verified. Input admission remains64MiB of received bytes. The staged body is re-encoded from the same UTF8 decoder basis as the old body door: BOM and missing-final-newline equality are executable controls. Ordinary canonical UTF8 export source SHA matches the original bytes; this is not a new raw-wire hash claim for malformed encodings.

## Qualification

Ten Node controls pass: staged preflight before any canonical rows, byte-at-a-time split UTF8 and exact row/source hash equality, the original negative content/trailer corpus, partial upload and resumed upload failure, sealed hash-only retry, missing KV, part substitution, over64MiB chunk cancellation and private source cleanup, BOM/no-final-newline parity, and historical report behavior.

Actual production Native ProjectRoom with a real Miniflare KV namespace passes:650messages plus a1MiB stored file produce a3,150,297-byte source whose legal BLOB JSON row is larger than one part. The source uses5puts,4gets and5deletes; maximum put1,048,576bytes; source writes3,151,259bytes including manifest and reads3,150,297bytes. Every source put occurs while canonical rooms remain0. Invalid complete trailer and interrupted80percent upload both produce no manifest/no source reads/no canonical rows; the interrupted target reopens cold and ready. Valid import returns202, cold readiness stays503, original body retry incurs0KV I/O,221 existing continuation steps including the required full oracle finish, cold readiness is200, original command retry is duplicate and exact, and the restored1MiB file downloads with the original SHA.

The current broad older KV/legacy neighborhood was41pass/13fail: inherited tests still expect one-shot200 rather than staged202, and schema44 rather than45. Representative failures reproduce on untouched root and are not waived or counted green. The focused historical proof file is32pass/1fail: all genuine v42/v43 cold-write and historical-proof controls pass; the attempted name pattern did not exclude its inherited schema44 assertion. That failure is retained, not waived or counted green.

## Cost and limits

This replaces whole-upload application accumulation, joined byte copies and full byTable payload retention with KV I/O. It is not a blanket speed improvement. The1MiB storage part limit and64KiB derived decoder slices are enforced; the largest JSON record, first watermark and event tuple arrays remain independent memory costs. The existing KV writer also retains event tuples, so a complete process-memory or CPU bound is not claimed. A platform may supply a large raw transport chunk before application slicing.

The source is still loaded in one request after preflight; restartable per-part source ingestion is not implemented. Existing per-table500row/4MiB buffers, self-reference holds and full recovery checks remain. A source whose digest is valid but SQL/FK semantics are invalid may still fail during the old insertion checks and retain a pending target; immutable audit is never deleted to conceal that. The original KV backup door keeps its existing import/validation ordering; this change extracts its byte feeder without claiming its separate late-invalid limitation solved.

Commands and receipts are in audit/evidence/restore-body-safe-20261101.json. No schema45 activation, push or deployment was performed.
