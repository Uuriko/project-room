# Decision rows: the auditor export (decision-rows/1)

Accountability R-5/R-11 (#3616). A room's verdicts — who decided what,
under which rubric, with what outcome — are exportable to customer custody
as a stable, documented schema, and reads/exports of the evidence are
themselves logged.

## The export

`GET /api/rooms/{roomId}/export?format=decision-rows`

- Owner-only, exactly like the other export formats on the same route
  (403 `owner_required` for every other member, 401 unauthenticated).
- The body is NDJSON, materialised in full before the response starts and
  framed by `Content-Length`: a failure while reading the records is a
  JSON error, never a truncated 200. The download name is
  `room-{roomId}-decision-rows.ndjson`.
- The first line is a header:
  `{"kind":"decision-rows","schema":"decision-rows/1","version":1,"roomId":…,"exportedAt":…,"requester":…,"rows":N}`
  where `requester` is the exporting member's id and `rows` is the number
  of decision rows that follow.
- Each later line is one decision row: **one row per verdict, never
  pre-aggregated**. Rows are a projection over the stored per-verdict
  records (public-work reviews, bounty records, board claim items); the
  export does not change how verdicts are stored.
- Every export of a live room appends a `room.exported` audit event — the
  same audit record as the event-log export — whose data names the format
  (`decision-rows`), the schema, the row count, and the requester. An
  archived room records nothing new.

## decision-rows/1 fields

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | Always `"decision-rows/1"` in this version. |
| `rowId` | string | Stable per-verdict row id, unique within a room. Repeated-verdict sources (board claim reviews) suffix verifier + timestamp. |
| `roomId` | string | Room the verdict belongs to. |
| `source` | string | `public-work`, `bounty`, or `board-claim`. |
| `decisionKind` | string | `verification`, `decision`, `acceptance`, `rejection`, `dispute`, `settlement`, or `review`. |
| `subjectId` | string | Deployer-controlled id of the decided subject: public-work receipt id, bounty id, or board claim id. |
| `rubricVersion` | string \| null | Rubric/policy version the verdict ran under: the pinned bounty rubric version, the public-work receipt terms version, or the board claim review policy. Null when the record carries none. |
| `rubricHash` | string \| null | Hash of the pinned rubric the verdict cited (bounty verdicts); otherwise null. |
| `outcome` | string | The verdict's own outcome vocabulary, unmodified (`PASS`/`FAIL`, `accepted`/`rejected`/`revision_requested`, settlement kinds, dispute outcomes, `approve`/`changes_requested`/`comment`, `verified`/`self_attested`, …). |
| `accepted` | boolean \| null | Normalised acceptance: `true` accepting, `false` rejecting, `null` for verdicts that are neither (revision requested, comment, self-attested, split/partial settlement). |
| `criteriaSummary` | string \| null | Per-criterion citations (`criterionId:verdict`), executed-check results, or the recorded reason. Truncated to 500 characters. |
| `decidedAt` | string | ISO timestamp of the verdict. |
| `verifierId` | string \| null | Member/lane id of the verifier, reviewer, acceptor, decider, or settler, as recorded. Null when the record names none. |

The field set is pinned by tests (`tests/decision-rows.test.js`). A new
field is a new schema version (`decision-rows/2`), never a silent widening
of `decision-rows/1`.

### Never-collect (R-5)

The schema carries **no demographic or protected-class attribute**, and the
platform does not collect or store any. An auditor who needs selection
rates by demographic group joins the export against their own records on
`subjectId` — that join, and the demographic data behind it, belong to the
deployer/auditor, never to this export.

## Auditor recipe

Acceptance rates by rubric/policy version, from the export alone:

1. Parse each line after the header as JSON.
2. Group rows by `rubricVersion` (rows with `null` are "unversioned").
3. In each group, the acceptance rate is
   `count(accepted = true) / count(accepted != null)`.

`acceptanceRatesByRubricVersion(rows)` in `server/decision-rows.mjs` is
exactly this computation, exported for auditor scripts and pinned by the
test suite. Selection rates by subject over time need nothing else: each
row carries `subjectId`, `outcome`, and `decidedAt`.

## Evidence-read logging (R-11)

Exports are audit-recorded; so are member-side reads of verdict/evidence
surfaces. A successful read appends an `evidence.read` event to the same
room event log, carrying `{surface, subjectId}` and the reading member as
the event actor — never the evidence content. Logged surfaces:

- `public-work-review` — GET one public-work receipt's review inspection;
- `public-work-results` — GET the owner public-work results list;
- `board-claim` — GET one board claim (its reviews, verification, and
  delivery evidence);
- `bounty-review-packets` / `bounty-reputation-packets` — GET the arbiter
  review-packet surfaces, optionally for one bounty.

Granularity, deliberately: list/board/status reads and non-evidence reads
are **not** logged — those are hot paths polled by clients, and a write per
poll would flood the event log. The logged set is the verdict/evidence
inspection surfaces an investigator actually reads. An archived room
records nothing new, so its reads leave no event (the same rule as
exports).
