# Bounded legacy message repair

This Operator-only action repairs indexed message records whose fresh, complete
parity diagnostic proves that their only differences are retired `reactions` or
missing/null receipt IDs. It is not a general projection repair or an integrity
sweep. Never select a room whose diagnosis is `unknown`.

Use the existing Operator authentication scheme, without room/account cookies.
Do not paste the Operator credential into logs, transcripts, or saved requests.

1. Read `GET /api/operator/status`. Review `messageParityDiagnostics` and select
   at most three explicit outstanding `messages_parity` rooms. Every selected
   entry must be complete and `exactLegacyShapeOnly: true`.
2. Send `POST /api/operator/messages/legacy-repair/plan` with this shape:
   ```json
   {"rooms":[{"roomId":"reviewed-room","expectedHead":23}],"reason":"Reviewed legacy record-shape mismatch"}
   ```
   The response contains only room IDs, heads, counts, and a `planHash`. Planning
   records an Operator audit entry; it does not repair messages.
3. After reviewing those counts, send the same rooms and reason to
   `POST /api/operator/messages/legacy-repair/execute`, adding the returned
   `planHash` and a unique `requestId` (1–64 letters, digits, underscores, or
   hyphens). A retry must use exactly the same input and request ID. A completed
   duplicate returns the saved result without another repair or audit row.
4. Read fresh Operator status and `/api/health/jobs`. Successful execution
   verifies each target with the canonical checker and clears only its matching
   failure record. It does not run the whole integrity job or reset its failure
   streak. Confirm a later normal integrity tick has a new successful timestamp
   and no remaining fatal failure; do not call a targeted repair a full sweep.

The plan is bound to current source evidence and heads. Execute rechecks it in
one writer transaction. Only `messages.record_json` changes; when that record's
retired reactions are removed, `reactions_json` also becomes NULL to match the
canonical writer and incremental certificate checks. Bodies, indexes, events,
projections, checkpoints, and other rooms are preserved. Each proposed record
must equal the complete canonical expected record before writing, and the
canonical room parity check must pass afterward. A late failure rolls content,
failure-ledger changes, and completion audit back, then invalidates certificates
only for the validated targets in that attempted write.

Limits remain explicit: up to 2,000 message rows and 2,000 events per room,
4 MiB per bounded source class, and a 150 ms cooperative preflight budget.
Canonical work-entity hydration additionally requires no more than 2,000 rows
and 4 MiB. The clock budget is checked between synchronous operations; the row
and byte limits bound individual reads. Limit exhaustion is refusal, never
partial repair. No automatic fleet migration is added.
