# lane-claim CLI — WAVE-500 standing-claim tooling prototype

`scripts/lane-claim.mjs` — one-shot worker 8/17 (coord-cost), companion to worker 7's
standing-claims protocol proposal.

## Assumptions

- Worker 7's `docs/STANDING-CLAIMS-PROPOSAL.md` did not exist at build time (checked
  2026-10-08), so this CLI was designed to the worker brief and to repo conventions:
  - Claim ids / namespaces follow the protocol lane's `w500-<guild>-<slice>` convention
    (`~/workspace/pr-wave500-protocol/wave500-design/claim-granularity.md`).
  - Board states (`claimed`/`done`/`ready` queue) follow `docs/WORK-CLAIMS-READ.md`.
  - Room messages use the `[jill][…]` prefix + fenced `room-claim`/`room-done` blocks.
- No overlapping tooling exists in `~/workspace/pr-wave500-protocol` (searched 2026-10-08);
  nothing was forked. The live work-claims board (#266) and the claim registry showed
  no competing claim on lane-claim tooling — first-claim-wins holds.
- **Prototype, dry-run only.** Every subcommand validates its inputs and prints the
  exact API payloads + room message it *would* send. Real sends need `--live`; the
  verification runs for this build never used it.

## Quick start

```sh
# create a lane claim (validates the manifest first)
node scripts/lane-claim.mjs create \
  --wave wave500 --lane lane3 --manifest tasks.json

# renew the lease (heartbeat) — minimal payload, not a full re-claim
node scripts/lane-claim.mjs heartbeat --lane-claim w500-wave500-lane3

# finish one task with a v1 receipt
node scripts/lane-claim.mjs complete-task \
  --lane-claim w500-wave500-lane3 --task t1 --receipt receipt.json

# return unfinished tasks to the ready pool
node scripts/lane-claim.mjs release --lane-claim w500-wave500-lane3

# dry-run JSON only (machine-readable)
node scripts/lane-claim.mjs create --wave w --lane l --manifest tasks.json --json
```

Global flags: `--live` (perform the sends), `--help`, `--json`, `--room <roomId>`
(default `muse-room`), `--base <url>` (default `https://room.trydemigod.com`).

## Subcommands

### `create --wave <id> --lane <name> --manifest <tasks.json>`

Reads a task manifest (JSON array; each task: `id`, `title`, optional `files`
array of repo-relative paths), validates it, and emits the lane-claim payload.

Validation rules (exit 2 on violation):
- `id` non-empty, unique, charset `[A-Za-z0-9._-]`.
- `title` non-empty.
- `files` normalized (leading `./` stripped, trailing `/` stripped, no `..`,
  no absolute paths) and **non-overlapping across tasks**: a file equal to, or a
  path-prefix of, another task's file is rejected. This keeps one lane from
  self-colliding at 500-agent scale.

Example manifest:

```json
[
  { "id": "w500-docs-001", "title": "Write the lane-claim runbook", "files": ["docs/LANE-CLAIM-CLI.md"] },
  { "id": "w500-docs-002", "title": "Prototype the CLI", "files": ["scripts/lane-claim.mjs"] }
]
```

### `heartbeat --lane-claim <id>`

Emits a **minimal renewal payload** (`type: lane-claim-heartbeat`, claim id,
timestamp) — deliberately not a full claim resend, so a heartbeat can't
accidentally re-claim or move tasks between states.

### `complete-task --lane-claim <id> --task <taskId> --receipt <receipt.json>`

Validates the receipt is a JSON object with the v1 fields `workerId`, `status`,
`summary` (non-empty strings; extra fields pass through untouched), then emits
a PATCH marking that task `done` with the receipt attached, plus the `room-done`
room message.

Example receipt:

```json
{ "workerId": "worker-3a", "status": "done", "summary": "runbook drafted, CLI prototyped" }
```

### `release --lane-claim <id>`

Emits a POST to `/work-claims/{id}/release` returning all unfinished tasks to
the `ready` queue, plus the room release message. (Done tasks stay done; only
remaining work is released.)

## Payload shape: one versioned envelope, one idempotency key

**Decision:** every subcommand emits a single `lane-claim/v1` envelope with two
sibling fields — `apiCalls` (exact method/URL/body list) and `roomMessage` (exact
room text, fences included) — both stamped with one `idempotencyKey`
(`sha1("lane-claim" | version | laneClaimId | canonical-inputs)[0:16]`).

Rationale: the standing-claim failure mode is a **double-claim on retry** — a lane
re-runs `create` after a timeout and ends up with two live claims. Carrying the
same key in the API body *and* inside the `room-claim` fence makes a retry
dedup-able on either surface without a third lookup, and it keeps the room
message and the board mutation provably the same action.

Example dry-run envelope (create):

```json
{
  "envelope": "lane-claim/v1",
  "kind": "create",
  "idempotencyKey": "9f2c…",
  "apiCalls": [
    { "method": "POST", "url": "https://room.trydemigod.com/api/rooms/muse-room/work-claims",
      "body": {
        "id": "w500-wave500-lane3", "type": "lane-claim", "version": 1,
        "wave": "wave500", "lane": "lane3", "namespace": "w500-wave500-lane3",
        "idempotencyKey": "9f2c…", "state": "claimed",
        "tasks": [ { "id": "w500-docs-001", "title": "…", "files": ["docs/LANE-CLAIM-CLI.md"], "state": "claimed" } ],
        "files": ["docs/LANE-CLAIM-CLI.md"],
        "lease": { "ttlSeconds": 3600 }
      } }
  ],
  "roomMessage": "[jill][lane-claim] w500-wave500-lane3 — 2 task(s) claimed under wave wave500 (lane lane3).\n\n```room-claim\n…\n```"
}
```

Dry-run output prints the same envelope in human-readable form (API calls with
indented bodies, then the exact room text), or as raw JSON with `--json`.

## Exit codes

- `0` — inputs valid; dry-run printed (or `--live` sends all succeeded).
- `2` — input/validation error (bad args, unreadable/invalid manifest or receipt).
- `1` — runtime error (e.g. `--live` send failed).
