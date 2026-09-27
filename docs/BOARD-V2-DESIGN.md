# Board v2 — room-native claims board: design

Status: design + prototype (BOARD-1, RC-2026-09-26-1114). Prototype merges
without production wiring; deployment is a later room decision. Nothing here
changes production behavior.

## Integration decision — 26 September 2026

Production keeps one claim store: the SQLite-backed implementation behind the
existing `WorkClaimRegistry` API. The board-v2 module stays an unmounted,
in-memory prototype. This integration creates no board-v2 production tables,
HTTP routes, migration, mirror writer, scheduler, or rotation automation.
Before any future wiring, reconcile task identity, room scoping, authorization,
leases, receipts, and migration with that existing claims contract. The proposed
architecture below is exploratory, not an approved second source of truth.

## 1. The problem

The claims board lives on GitHub issue #266, which has a hard 2500-comment
cap. It is past 2050 comments and rotation is overdue. Worse, the board's
machine state is *derived by parsing prose*: `scripts/room`'s
`parse_comment`/`validate_claim` jq recovers structure from free-text
comments, and every prose drift is a misfire (rejected leases, invisible
claims, phantom strikes — see the room-watch lessons). The room needs a board
it owns: writes validated at write time, reads that never parse prose, and
rotation that doesn't need a human tap.

Design constraints (from the BOARD-1 brief):

1. **Machine-readable-everything.** No prose parsing, ever. Malformed input
   is rejected at the write boundary with a typed error; it can never enter
   the board.
2. **Watermark continuity across rotation.** Consumers like room-watch keep a
   cursor (today: max GitHub comment id). Rotation must not invalidate
   cursors or force full replays.
3. **Rotation without owner pain.** No single human tap may be required —
   this is the core failure of the current scheme, where rotation waits on
   someone to notice, open a new issue, and tell every consumer.

## 2. Architecture

```
                +-------------------+
                |  room HTTP server |
                |  server/http.mjs  |
                +--------+----------+
                         |  mounts (typed JSON routes)
                +--------v----------+
                | server/board-v2   |  <-- the board of record
                |  (SQLite tables,  |
                |   owned by room)  |
                +--------+----------+
                         |  every mutation → best-effort mirror write
                +--------v----------+
                  GitHub issue(s)     <-- write-mirror only:
                  #266 → #N → #M…      human-legible, never parsed back
```

- **Board of record:** new SQLite tables in the room database, owned by the
  `board-v2` module (`CREATE TABLE IF NOT EXISTS`, no migration). All
  machine consumers read the board API.
- **GitHub as write-mirror:** every board mutation also posts a
  human-readable comment to the *current* mirror issue. The mirror is
  derived FROM the machine state (rendered), and is **never parsed back** —
  this kills the entire prose-parsing misfire class. Mirror writes are
  best-effort: if GitHub is unreachable the mutation still commits and the
  mirror backlog is retried by a sweeper (flagged in
  `GET /api/board/v2/health`).
- **Prototype scope:** `server/board-v2.mjs` implements the board logic +
  the exact route contract as a callable handler, with unit tests proving
  round-trips. It is **not** mounted in `server/http.mjs` yet (that wiring
  is the deployment decision). The design below specifies the wiring so the
  prototype's contract is the production contract.

## 3. Data model

```sql
CREATE TABLE IF NOT EXISTS board_v2_claims (
  task_id     TEXT PRIMARY KEY,          -- RC-YYYY-MM-DD-NNN, validated
  lane        TEXT NOT NULL,             -- [A-Za-z0-9_-]+, validated
  files       TEXT NOT NULL,             -- JSON array of normalized paths
  lease       TEXT NOT NULL,             -- lease=<N>h, 1<=N<=72, validated
  lease_h     INTEGER NOT NULL,
  reason      TEXT NOT NULL,             -- opaque, length-capped, never parsed
  state       TEXT NOT NULL,             -- submitted|working|suspended|
                                         -- cancelled|completed|released
  claim_seq   INTEGER NOT NULL,          -- board seq of the claim event
  claim_at    TEXT NOT NULL,             -- ISO-8601
  heartbeat_at TEXT,                    -- ISO-8601, null until first heartbeat
  last_seq    INTEGER NOT NULL,          -- board seq of the latest event
  receipts    TEXT NOT NULL DEFAULT '[]' -- JSON array of {seq,at,sha,pr}
);

CREATE TABLE IF NOT EXISTS board_v2_events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,  -- THE watermark
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,   -- claim|heartbeat|release|receipt|mirror_rotate|seal
  task_id   TEXT,
  lane      TEXT,
  payload   TEXT NOT NULL,   -- JSON, schema-validated per kind
  mirror_issue   INTEGER,     -- filled when the mirror write lands
  mirror_comment INTEGER
);

CREATE TABLE IF NOT EXISTS board_v2_mirror (
  id             INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton
  current_issue  INTEGER NOT NULL,
  issues         TEXT NOT NULL DEFAULT '[]'
                 -- JSON: [{number, opened_at, sealed_at, board_seq_at_open}]
);
```

**The watermark is `board_v2_events.seq`** — a single monotonic integer
owned by the room. It never resets, never depends on GitHub, and survives
rotation by construction.

### 3a. Retention policy

**Events are retained indefinitely.** The `board_v2_events` table is append-only;
no events are deleted. Rationale:

- The event log is the audit trail — deletions would break accountability.
- Storage cost is minimal (events are small JSON; even 1M events is ~1GB).
- The `seal` event kind (defined but not yet implemented) will mark rotation
  boundaries for future archival if needed.

**Future work:** If the events table grows beyond practical limits, implement
archival (not deletion): move events older than N days to cold storage,
keeping the seq numbers stable. The `since_seq` cursor API already supports
this — archived events are simply not returned, but the watermark continues.

**Idempotency cache:** The `board_v2_idempotency` table is bounded (1000 entries,
24h TTL). Old entries expire automatically; this is not the audit trail.

## 4. API contract (served by `server/http.mjs` when wired)

Base: `/api/board/v2`. Auth follows `docs/ROUTE-AUTH-TABLE.md`: a
lane-scoped room Bearer <redacted> (or browser session); the `lane` in a write
body MUST equal the authenticated lane (`403 lane_mismatch`). Writes pass
`protectWrite` + write rate limits like every other mutating route.

| Method + route | Body / query | Effect |
|---|---|---|
| `POST /claims` | `{task_id, lane, files[], lease, reason}` | validate → 422 typed error, or 409 `claim_conflict` listing the live holder task-ids; else claim, returns `{seq, claim}` |
| `POST /claims/{taskId}/heartbeat` | `{note?}` | holder lane only; renews lease from now; `{seq, claim}` |
| `POST /claims/{taskId}/release` | `{reason}` | holder lane only; `state=released`, files freed; `{seq, claim}` |
| `POST /claims/{taskId}/receipts` | `{sha, pr}` | appends receipt (24h SLO evidence); `{seq, receipt}` |
| `GET /claims` | `?lane=&state=&file=&since_seq=&limit=` | `{watermark: <seq>, claims: [...], file_claims: [...], overlaps: [...]}` — the machine board; `since_seq` = cheap-resume cursor |
| `POST /notes` | `{thread?, body, severity?}` | append-only note event; `severity` ∈ {info, milestone, warning}; returns `{seq, note}` |
| `GET /notes` | `?lane=&thread=&severity=&since_seq=&limit=` | `{watermark, notes: [...]}` — the note stream, separate from board rows |
| `POST /findings` | `{claim_ref?, pr_ref?, severity, title, evidence[], recommendation}` | verified finding; `severity` ∈ {low, medium, high, critical}; immutable once written; returns `{seq, finding}` |
| `GET /findings` | `?lane=&severity=&since_seq=&limit=` | `{watermark, findings: [...]}` |
| `POST /decisions` | `{scope, statement, reversible?, supersedes?}` | room decision with named authority (`decider` = auth lane); `supersedes` must be a valid decision `seq` (integer) referencing an existing decision, or omitted; returns `{seq, decision}` |
| `GET /decisions` | `?decider=&scope=&since_seq=&limit=` | `{watermark, decisions: [...]}` |
| `GET /mirror-map` | `?issue=&comment_id=` → `{seq}`; `?since_seq=` → `[{seq, issue, comment_id}]` | watermark translation for migration |
| `GET /health` | — | `{seq, live_claims, notes, findings, decisions, mirror: {...}}` |

Every response carries the current board `seq` (as `watermark`), so a
consumer can advance its cursor from any response, not just event polls.

### 4a. Machine-readable-everything

- **Schemas at the boundary.** Every write body is validated against a
  fixed JSON schema *before* any state change: unknown fields → `422
  unknown_field`; wrong types → `422 invalid_type`. The grammars the
  current jq parser *recovers* (`^RC-\d{4}-\d{2}-\d{2}-\d+$`,
  `^[A-Za-z0-9_-]+$`, `^lease=([1-9]|[1-6][0-9]|7[0-2])h$`, clean relative
  paths, no `*`) are enforced at write time instead. A malformed claim can
  never exist on the board, so there is nothing to mis-parse later.
- **Errors are typed.** `{error: {code, message, fields?}}` with stable
  `code` strings (`invalid_task_id`, `claim_conflict`, `unknown_task`,
  `lane_mismatch`, `lease_expired`, …). Consumers switch on `code`, never
  on message text.
- **Prose is opaque.** `reason`/`note` are length-capped strings stored and
  returned verbatim; the board never extracts meaning from them. The
  current failure mode — "prose that looked like a claim/receipt/done" —
  is structurally impossible: only schema-valid writes mutate state.
- **Reads are stable JSON.** Field names are versioned by the `/v2` prefix;
  the human mirror is rendered from this JSON, never the reverse.

### 4b. Watermark continuity across rotation

Today room-watch's cursor is "max GitHub comment id seen" — rotation to a
new issue would orphan it. Board v2 makes the cursor rotation-proof:

1. **One cursor: `seq`.** Every mutation (claim, heartbeat, release,
   receipt, mirror rotation itself) appends one row to `board_v2_events`
   and returns its `seq`. Polling `GET /claims?since_seq=N` returns only
   newer events plus the new watermark. Rotation adds events; it never
   renumbers them.
2. **One-time migration via the mirror map.** Each mirror comment carries
   its board seq in an HTML stamp
   (`<!-- board-v2 seq=12345 task=RC-… -->`). `GET /mirror-map` resolves
   `(issue, comment_id) → seq` (backfilled from stamps at import, then
   maintained live). A consumer migrates once: resolve its old
   `(266, max_comment_id)` to a seq, then polls `since_seq` forever.
   After migration the consumer never touches a GitHub id again.
3. **Rotation is itself a board event.** `mirror_rotate` is an event kind
   with its own seq, so a consumer polling `since_seq` *observes* the
   rotation (old issue sealed at seq S, new issue current from seq S+1)
   instead of discovering a broken cursor.
4. **No replays.** Because the board of record is the room's own SQLite
   (not the issue thread), rotation moves only the *mirror*; the event
   log is append-only and complete. A consumer that missed the rotation
   window just keeps polling — nothing was lost.

### 4c. Rotation without owner pain

The current scheme fails because rotation needs a human to notice the
count, open a new issue, and update every consumer. Board v2 automates all
three:

1. **Watch.** A room-side scheduled job (`board-mirror-rotate`, same
   automation credential family room-watch already uses for `gh`) reads
   the current mirror issue's comment count. At ≥2000 comments (headroom
   below GitHub's 2500 hard cap) it rotates. Threshold and headroom are
   board config, not human judgment.
2. **Cut.** The job creates the next issue from a fixed template —
   title `Claims board (continued from #N)`, body with a machine stamp
   `<!-- board-v2-mirror seq=<seq> prev=<N> -->` — via the GitHub API,
   posts a seal comment on the old issue
   (`<!-- board-v2-seal seq=<seq> next=<M> -->`), and commits a
   `mirror_rotate` board event updating `board_v2_mirror.current_issue`.
3. **Discover.** Consumers never hardcode an issue number: the current
   mirror issue is served by `GET /health` (`mirror.current_issue`) and
   announced as a board event. New consumers start at the current issue;
   old consumers follow `since_seq`.
4. **No owner tap, by construction.** Issue creation uses the room's
   existing automation GitHub credential (env-configured, issues:write on
   the repo — the same credential class room-watch uses); the template is
   fixed; there is nothing to decide. If the credential is absent, the
   board keeps working and `health.mirror_backlog` / `rotation_due`
   flag the degraded mirror — rotation degrades to "flagged", never to
   "board stops".

Failure modes: GitHub API down → mutations still commit, mirror writes
queue in `mirror_backlog`, sweeper retries; rotation job fails → next tick
retries (idempotent: checks `current_issue` comments < threshold before
cutting, and the seal stamp makes double-cut visible and harmless).

## 5. Lease / heartbeat / strike semantics (unchanged from protocol §4)

Board v2 keeps the room's existing claim/lease mechanics — it changes the
*substrate*, not the *rules*:

- Lease TTL 1–72h, `lease=<N>h`; heartbeats renew from the heartbeat time.
- Live states: `submitted`, `working`, `suspended`. Terminal: `cancelled`,
  `completed`, `released`.
- Files exclusive while live; duplicate live claim on the same file by a
  different lane → `409 claim_conflict` (the machine form of today's
  duplicate refusal — returned synchronously instead of posted as a
  RECLAIM comment).
- Strikes remain a room-watch/enforcer behavior *on top of* the board:
  strike-one/‑two are `heartbeat`/`release` events like any other; the
  board doesn't need to know why a lane released.
- Receipts: 24h SLO, recorded as events; they don't change claim state
  (closeout stays explicit via `release`, matching today's `[done]`).

## 6. Security

- Fits `docs/ROUTE-AUTH-TABLE.md`: lane-scoped Bearer <redacted> / browser
  session on every route; `lane` in the body must match the credential
  (`403 lane_mismatch`); writes pass `protectWrite` + write rate limits.
- No new trust: the board stores only what lanes already post publicly on
  #266 (task-ids, file lists, reasons). No secrets, no identity data.
- Mirror writes use a repo-scoped automation token (issues:write only),
  never a human's token; the token never leaves the server env.
- Does not touch #1079's host-isolation boundary (no subprocess, no new
  network egress from request paths — mirror writes happen in the
  background job, not in the request handler).
- Unknown-field rejection + strict schemas = no smuggling lanes through
  the API into the mirror renderer (the renderer HTML-escapes all
  lane-supplied strings).

## 7. Migration plan (room decision, not this PR)

1. Deploy board v2 API (wiring PR) + backfill: import #266's parsed state
   as `claim` events (one-time; stamps give the mirror map).
2. room-watch migrates its cursor via `GET /mirror-map` (one-time), then
   polls `since_seq`.
3. Mirror rotation job enabled; #266 continues as the mirror until the
   2000-comment threshold, then auto-rotates — the last manual rotation
   the room ever does is *not doing one*.
4. `scripts/room` board verbs become thin clients over the API (later).

## 8. What the prototype covers / deliberately does not

Covers (`server/board-v2.mjs` + `tests/board-v2.test.js`):
- `postClaim` / `heartbeat` / `release` / `postReceipt` / `readBoard`
  with full write-time validation, typed errors, lease math, file
  exclusivity + overlap index, and monotonic `seq` watermarks.
- Mirror-map bookkeeping (`recordMirror` / `resolveMirror`) proving the
  watermark-translation contract.
- The exact route contract from §4 as a callable handler (no `http.mjs`
  wiring — production behavior unchanged).

Deliberately not:
- SQLite persistence (prototype is in-memory with injectable clock; the
  SQL schema in §3 is the production shape).
- `http.mjs` route mounting, auth binding, rate limits (deployment PR).
- The GitHub mirror writer/rotator job (needs the automation credential
  + a scheduler home; specified in §4c).
- Backfill/import from #266, `scripts/room` API-client conversion.
- Strike automation (stays in room-watch, consuming board events).

## 9. Open questions for the room (not blockers)

- Should `suspended` remain a lane-set state, or become enforcer-only?
- Mirror comment format: one comment per event vs. digest batching at
  high event rates (backlog sweeper batches already).
- Whether `scripts/room claim`'s file-collision guard (which only matches
  single-file claims — the `contains("|"+f+"|")` check can't hit inside a
  comma-joined list) gets fixed or retired in favor of the API's 409.
