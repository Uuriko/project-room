# Coordination v3 — shared ledger

This orphan branch (`coordination`) is the shared, machine-readable
coordination ledger for every agent working in `Uuriko/project-room`
(Jill, Codex, Grok, …), per Coordination v3. It exists because `main` is
hard-gated (every state tick would pay a full PR + CI + merge-slot cycle),
issue bodies have no optimistic locking and no diffable history, and the
previous ledger (`release-wave-log.md`) lived only on Jill's machine.

Design evidence: `02a-feasibility.md` Q1 and `02-protocol-design.md` in
Jill's local `~/workspace/strategy-2026-10/comms-bridge/`; the protocol
handshake is the Coordination v3 comment on issue #3299:

- Handshake comment: <!-- PLACEHOLDER: insert the #3299 Coordination v3 handshake comment URL here once posted -->

## Layout — disjoint write sets, so concurrent writers conflict ~never

- `ledger/claims/pr-<n>.json` — one file per PR: the current claim record
  for that PR, in the canonical `coord-claim/v1` schema (below). A file's
  content is replaced as the record advances (claim → heartbeat →
  release); the lifecycle is also carried inside the file itself, in its
  `history[]` array, with the git history of this branch as the audit
  trail behind it.
- `ledger/status-<actor>.json` — one file per actor: that actor's current
  presence beacon (`status-jill.json`, `status-codex.json`, …). Only the
  named actor writes their own status file.
- `ledger/validate.mjs` — zero-dependency Node validator (see CI below).
- This `README.md` — the format, stated once, here.

Writers push directly to this branch (no PRs). A stale push is rejected
non-fast-forward by git — pull/rebase and retry; never force-push
(protection-lite on this branch sets `allow_force_pushes: false`, with no
required checks and no PR requirement). Entries are **claims, not proof**:
GitHub metadata cannot attribute authorship here (every fleet acts as the
same login), so every entry self-declares `actor`, and trust comes from
content + cross-checks (e.g. the unledgered-merge detector), never login.

## Claim record — `ledger/claims/pr-<n>.json`

Canonical schema: **`coord-claim/v1`**, exactly as the operational writer
`tools/coord-claim.mjs` writes it (its `ledgerRecord()` function is the
reference implementation). This schema was made canonical over the
earlier bootstrap shape on 2026-10-16 (WS-3e alignment): the tool is the
writer, and its lifecycle fields (`claimId`, `status`, `history`) are
load-bearing for `check` / `heartbeat` / `release`. The same claim is
also posted on issue #3299 as a fenced `COORD-CLAIM v1` block — note the
block is kebab-case text (`claim-id`, `claimed-at`, …) while the ledger
JSON below is camelCase; they are two renderings of one claim, and the
JSON form here is the one the validator enforces.

```json
{
  "schema": "coord-claim/v1",
  "claimId": "clm_1cfb3985cd55",
  "actor": "jill",
  "kind": "merge-slot",
  "pr": 3299,
  "prs": [3299],
  "status": "live",
  "claimedAt": "2026-10-16T20:00:00.000Z",
  "heartbeat": "2026-10-16T20:00:00.000Z",
  "expires": "2026-10-16T20:45:00.000Z",
  "note": "one line",
  "history": [
    { "action": "claim", "at": "2026-10-16T20:00:00.000Z", "requestId": "req_..." }
  ]
}
```

Fields (in the order the tool writes them):

- `schema` (string, required) — exactly `"coord-claim/v1"`.
- `claimId` (string, required) — `clm_<12 hex>`, a deterministic hash of
  the claim's request-id, so a retried claim finds its own record.
- `actor` (string, required) — self-declared actor (e.g. `jill`).
- `kind` (string, required) — one of `merge-slot`, `landing-note`,
  `hold`, `release`. (A release closes the file by flipping `status`;
  the record keeps the original claim's `kind`.)
- `pr` (integer ≥ 0, required) — the PR this file is for; must equal the
  filename's PR and be included in `prs`. PR `0` is allowed: it is the
  clearly-test record the tooling was exercised with.
- `prs` (array of integers ≥ 0, required, non-empty) — every PR the
  claim covers; a multi-PR claim writes one identical record per PR,
  differing only in `pr`.
- `status` (string, required) — `"live"` or `"closed"`.
- `claimedAt` / `heartbeat` / `expires` (ISO-8601 timestamps, required).
  For a `live` claim, `expires` is after `claimedAt` (default window
  45 min, renewed by heartbeat). On release the tool rewrites
  `heartbeat` and `expires` to the close time.
- `note` (string, required, may be empty) — one line.
- `landedSha` (string, optional) — present when a landing SHA was
  recorded at release.
- `closedAt` (ISO-8601, required when `status` is `"closed"`) — when
  the claim was released.
- `history` (array, required, non-empty) — the lifecycle, oldest first,
  always starting with a `claim` entry. Each entry:
  `{ "action": "claim" | "heartbeat" | "release", "at": <ISO-8601>,
  "requestId": "<unique idempotency id>", "landedSha": <optional> }`.
  **There is no top-level `requestId`** — idempotency ids live here,
  one per operation, which is what makes retried claims / heartbeats /
  releases detectable no-ops.

Rules: a claim whose `expires` passes without a heartbeat is void — any
actor may treat the slot as released. A release closes the slot
(`status: "closed"` + `closedAt` + a `release` history entry). One
landing owner per PR, recorded as a claim **before** merge.

## Status record — `ledger/status-<actor>.json`

JSON form of the `COORD-STATUS v1` block:

```json
{
  "version": 1,
  "actor": "jill",
  "requestId": "<unique idempotency id>",
  "at": "2026-10-16T20:00:00Z",
  "wave": "name or none",
  "next-landings": [ { "pr": 1234, "owner": "jill" } ],
  "holds": "none",
  "main-tip-verified": "<sha + run conclusion, or null>"
}
```

Fields: `actor` (string, required), `requestId` (string, required —
the status record's own idempotency id; status records keep this
top-level field even though claim records carry theirs in `history[]`),
`version` (1), `at` (ISO-8601), `wave`
(string or null), `next-landings` (array of PR numbers or `{pr, owner}`
objects), `holds` (string or null), `main-tip-verified` (string or null).
Updated on every state change and at least every 2 h while active.
A beacon older than 6 h = that actor is considered OFFLINE.

## Validation

`.github/workflows/validate.yml` **on this branch** runs on
`push: branches: [coordination], paths: ['ledger/**']` and executes
`node ledger/validate.mjs`, which schema-checks every ledger JSON file
(claim files against `coord-claim/v1` above, status files against the
COORD-STATUS shape above; it also rejects claim files carrying the
legacy bootstrap fields — top-level `requestId`, `version`, or
`claimed-at` — so the schemas cannot silently re-diverge).
Readers (the detector, mirror tooling) re-validate on every read anyway —
the workflow is the visible gate, the read-side check is the un-skippable
one.
