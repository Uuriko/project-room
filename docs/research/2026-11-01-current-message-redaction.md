# Normalized message erasure

Base: root `997eb09ede48546a79480ab679907becf81f11ab`. Initial real owner-command refusal: `345bf8f25`, log `/tmp/current-message-redaction-first-red.log`. Runnable runtime: `7e17b3a36`; qualified corrections/tests: `a115104e7`.

The existing `message.deleted` command now uses the normalized authority. Its dependency context loads the protected selected message, optional channel copy, complete bounded reply ancestry and the message's linked canonical work. Native text evidence is valid only for that same work ID, so current and historical cited receipts are covered without scanning all work. Existing reducers enforce authorization, message revision, deletion, evidence withdrawal and redaction. No new command, grant or raw mutation API is added.

The command appends the same deletion → optional evidence-withdrawal → redaction events. Its saved command receipt still points to the original deletion sequence. One protected transition publishes the final canonical messages, their independent witnesses, updated work bodies/refs/summaries and head. Original event identities, sequences and immutable operator receipts remain. Prior posted/edited event body and attachments are rewritten by the existing privacy protocol. The target's attachments/code drops/checks and raw cutover generations are erased in the same transaction. Normalized privacy erasure discards obsolete full message replay snapshots without parsing the whole room. Legacy service behavior is untouched.

Offline `native-work-4` binds two code-owned exact indices: target event identity/sequence and message-bound code drops. These participate in the existing serving admission/restore inventory. Previous native-work-3 warm/cold readers and precompiled writers refuse; equal-count index substitution refuses. No live format upgrade happened.

Qualification:

- 6 new Node controls plus 7 existing privacy/snapshot controls pass: authorized erasure, edits, private messages, source/channel copy, attachments, rollback, exact retry, revoked credential, native text current/history receipt withdrawal, omitted historical message ID, exact index tamper, old-format readers/writers, full export/restore oracle and historical-prefix boundaries.
- Actual production Native HTTP passes at 32, 1,000 and 5,000 unrelated messages. A real author/owner command succeeds; bystander mutation is 422. An injected event-rewrite save failure leaves complete business/proof/audit snapshots unchanged. Lost response after commit → cold restart → identical command returns its original receipt. The party's HTTP selected read returns redacted content; a bystander gets 404.
- The 32-message erased source exports, enters actual operator restore, survives a pending cold restart, completes 61 existing continuation steps including the independent full oracle, then cold readiness and the original saved command retry succeed.
- Targeted lint has zero errors; inherited raw-members warnings remain. Secret diff is clean, without checker/allowlist changes.

Actual instrumented cold Native command cost:

| Unrelated messages | Adapter statements | Adapter physical reads | Adapter writes | Target event rows / bytes |
|---|---:|---:|---:|---:|
| 32 | 189 | 7,015 | 44 | 5 / 936 |
| 1,000 | 199 | 7,077 | 44 | 5 / 936 |
| 5,000 | 199 | 7,077 | 44 | 5 / 936 |

Both target queries have actual `SEARCH events USING INDEX current_redaction_message_events` plans. The five examined rows are two before deletion and three during rewrite (the original delete event is already inserted). Separately observed raw Native runtime-permit maintenance adds two writes/two reads. Cold exact retry has zero adapter writes and the same two raw permit maintenance writes. All observed counters are known. Native instrumentation wraps storage after construction, so its own new storage identity can cause fixed cold runtime-catalog rediscovery; these are measured instrumented costs, not a claim of uninstrumented production latency. Other raw adapter maintenance is outside these counters; do not call the sum a complete SQL total. Worker elapsed samples are clock-only, not CPU.

Important limits:

- A selected message may have arbitrarily many old edit events. Addressed source iteration bounds live memory and removes unrelated-room scans; the atomic erasure transaction is not strictly bounded in total CPU, rows or duration. Existing raw cutover/snapshot/checkpoint privacy purges also have variable total cost.
- A message inside a previously proved immutable historical replay prefix cannot be rewritten without invalidating that prefix's exact-byte proof. The new command explicitly refuses with `current_redaction_historical_prefix` before changing data. A real repaired historical source, actual H migration and modern suffix deletion pass the full oracle; attempted prefix deletion preserves all rows and receipts. This remains a real product gap requiring an explicit historical privacy transition, not permission to replace receipts or certify history.
- Retained opaque message snapshots are discarded for normalized rooms. No claim is made that legacy message-backfill jobs become normalized-compatible, or that every historically aged log can replay without its old snapshots. Existing legacy snapshot-preservation controls remain green.
- This erases the selected representation's live storage cells and linked artifacts. It does not remove independently authored quotations from unrelated messages, guarantee filesystem/WAL forensic erasure, enable account deletion, or qualify a production deployment.

Commands: Node 24 with the installed `MINIFLARE_WORKERD_PATH`.

- `node --test tests/current-message-redaction.test.mjs tests/message-redaction.test.js tests/r35-redaction-keeps-replay-snapshot.test.js tests/r35-redaction-purges-snapshot-parts.test.js`
- `node --test cloudflare/current-message-redaction-native.check.mjs`

Logs: `/tmp/current-message-redaction-neighborhood-final.log` (13/13), `/tmp/current-message-redaction-native-final.log` (1/1), `/tmp/current-message-redaction-historical-red.log` (counterexample), `/tmp/current-message-redaction-historical-green.log`, `/tmp/current-message-redaction-lint.log`, `/tmp/current-message-redaction-secret-final.log`. Measurements: `audit/evidence/current-message-redaction-20261101.json`.
