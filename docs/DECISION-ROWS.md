# Decision rows export (`decision-rows/1`) — #3616, R-5 + R-11

A documented, stable-schema export of **per-subject decision rows**: one
row per verdict, never aggregated away, so an independent auditor can
compute selection (acceptance) rates and impact ratios **from the export
alone** — without mining a whole-store dump or event bodies.

Implementation: `server/decision-rows.mjs`
Route: `GET /api/rooms/{roomId}/decision-rows` (owner-only, see below)
Access log: `GET /api/rooms/{roomId}/decision-rows/access-log` (owner-only)

## Surfaces covered

| Surface (`surface`) | Underlying record (`recordId`) | Subject (`subjectId`) | Rubric version (`rubricVersion`) |
| --- | --- | --- | --- |
| `public-work` | receipt id | contributor identity id on the receipt | public-work terms version |
| `bounty` | bounty id | claimant lane | pinned bounty rubric version |
| `board` | work claim id | claim owner | board review policy |

Rows are emitted for verdicts only:

- **public-work** — the review decision for a receipt (acceptance row),
  or, when no decision exists yet, its independent verification
  (verification row). A receipt with no review yields no row.
- **bounty** — the latest terminal verdict the bounty record carries:
  an acceptance attestation, a rejection resolution, or a dispute
  resolution; a terminal state with no richer verdict record falls back
  to a state-derived row. Proposed/funded/claimed/submitted bounties
  yield no row; a disputed bounty yields a non-terminal row
  (`accepted: null`).
- **board** — one `review` row per recorded reviewer verdict on the
  claim, plus, when the claim carries a verification fact, one
  `acceptance` row for the completion verdict (verified /
  self-attested accept the delivery; changes_requested sends it back).

## Schema `decision-rows/1`

Schema stability is the product: within `decision-rows/1`, field names,
types and meanings do not change. A breaking change ships as a new
schema version (`decision-rows/2`) alongside the old one; rows always
name their schema in the `schema` field, and the export envelope names
it at the top level. Every row carries **every** field below — `null`
when a field does not apply or the underlying record does not carry it,
never an absent key, never a fabricated value.

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | Always `decision-rows/1` for this version. |
| `rowId` | string | Stable id of the row, unique within the export (surface + record id + decision kind). |
| `roomId` | string | Room the verdict was recorded in. |
| `surface` | string | `public-work`, `bounty`, or `board`. |
| `recordId` | string | Id of the underlying record on its surface. |
| `subjectId` | string \| null | Deployer-controlled id of the subject of the decision (see table above). |
| `decisionKind` | string | `acceptance` (terminal accept/reject verdict), `verification` (independent PASS/FAIL check), or `review` (board reviewer verdict, not itself the completion verdict). |
| `outcome` | string | The verdict as recorded on its surface, e.g. `accepted`, `rejected`, `revision_requested`, `PASS`, `FAIL`, `approve`, `changes_requested`, `comment`, `disputed`. |
| `accepted` | boolean \| null | For `decisionKind: "acceptance"` rows only: `true` accepted, `false` rejected/sent back. `null` on verification and review rows, and on non-terminal acceptance outcomes (`revision_requested`, `disputed`). |
| `rubricVersion` | string \| null | Version of the rubric/policy that governed the verdict, as a string (see table above). |
| `criteriaSummary` | string \| null | Short summary of what the verdict cited: criterion verdicts, executed-check results, or the recorded reason. Bounded text. |
| `verifierId` | string \| null | Identity/member/lane id of whoever rendered the verdict. |
| `decidedAt` | string \| null | ISO timestamp of the verdict, as recorded. |
| `submittedAt` | string \| null | ISO timestamp of the submission / claim round judged, when the record carries one. |
| `sessionInstanceId` | string \| null | Provenance (#3612): server-derived runtime instance/session that produced the verdict record, when stamped. |
| `authorizingPrincipalId` | string \| null | Provenance (#3612): principal who authorized the work/verdict, when stamped. |
| `claimedModelVersion` | string \| null | Provenance (#3612): producing runtime's self-reported model version — a claim pinned at write time, not a platform attestation — when stamped. |

### Provenance and legacy records

Provenance fields are flattened from the nested `provenance` stamp
(#3612, `server/records-provenance.mjs`) carried by the verdict record
itself — a decision, a verification, a bounty attestation/resolution,
or a board review/verification. Records written before the stamps
existed export those fields as `null`. They are never reconstructed,
guessed, or backfilled.

### No protected-class attributes — by design

The platform collects no protected-class attributes, and this export
introduces none: there are no demographic fields and no proxies for
them in the schema. Auditors who need selection rates by a protected
class join the export, on `subjectId`, to records **they** hold under
their own authority. That join belongs to the deployer/auditor; it is
never the platform's.

## Computing acceptance rates from the export alone

Filter to `decisionKind: "acceptance"` rows with `accepted` non-null,
group by `rubricVersion`:

```
for each rubricVersion:
  decided  = count(rows in group)
  accepted = count(rows in group where accepted == true)
  rate     = accepted / decided
```

`server/decision-rows.mjs` exports `acceptanceRatesByRubricVersion(rows)`
implementing exactly this, and `tests/decision-rows.test.js` exercises it
over fixtures spanning all three surfaces. Impact ratios are ratios of
these rates between auditor-defined subject groups (see above — the
grouping attributes are the auditor's, not the export's).

## Access, custody, and logging (R-11)

- The export route is **owner-gated** (the room owner is the room's
  operator for this purpose): any other member gets `403 owner_required`,
  and nothing is recorded for a refused export.
- The export is materialised in full before the response starts, and the
  audit records are written **before** the payload is returned — a failed
  audit write fails the export rather than producing an unaudited one.
- Every successful export writes two audit records naming the schema
  version, row count, and requester:
  1. a `room.exported` event on the room's own event log, with
     `data: { format: "decision-rows", schemaVersion: "decision-rows/1",
     rowCount, requesterId }` (archived rooms record no new events, as
     with the room export), and
  2. an `export` row in the `evidence_access_log` table.
- **Member-side evidence reads are logged the same way**: an
  `evidence_read` row in `evidence_access_log` naming the reader
  (`readerId`), the surface, the record id when the read is for one
  record, and the time (`at`). The owner reads the log back through
  `GET /api/rooms/{roomId}/decision-rows/access-log`.
- The export is the customer's custody copy: NDJSON-shaped JSON
  (`{ schema, roomId, generatedAt, requestedBy, rowCount, fields, rows }`)
  the customer stores in their own store. The platform keeps only the
  audit records above, not a copy of the export.

Evidence-read surfaces wired for logging in this change (see the PR body
for the full found-vs-wired list): public-work review inspect + results,
the contributor review read, work-claim receipts search, and the bounty
arbiter review queues (review packets, sybil flags, reputation packets).
