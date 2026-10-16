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
  for that PR. A file's content is replaced as the record advances
  (claim → heartbeat → landing-note / release); the full history is the
  git history of this branch, never the file alone.
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

JSON form of the `COORD-CLAIM v1` block (the same fields are posted on
issue #3299 at claim time):

```json
{
  "version": 1,
  "actor": "jill",
  "requestId": "<unique idempotency id, e.g. claim-2026-10-16T20-00-00Z-jill-xxxx>",
  "kind": "merge-slot",
  "prs": [3299],
  "claimed-at": "2026-10-16T20:00:00Z",
  "heartbeat": "2026-10-16T20:00:00Z",
  "expires": "2026-10-16T20:45:00Z",
  "note": "one line"
}
```

Fields: `actor` (string, required), `requestId` (string, required —
idempotency key, the runOnce pattern), `kind` (one of `merge-slot`,
`landing-note`, `hold`, `release`), `prs` (non-empty array of PR numbers;
the filename's PR must be in it), `claimed-at` / `heartbeat` / `expires`
(ISO-8601 timestamps; `expires` after `claimed-at`; default window 45 min,
renewable by heartbeat), `note` (optional one-line string).

Rules: a claim whose `expires` passes without a heartbeat is void — any
actor may treat the slot as released. A `landing-note` (or a `release`)
record for the same PR set closes the slot. One landing owner per PR,
recorded as a claim **before** merge.

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

Fields: `actor` + `requestId` (as above), `at` (ISO-8601), `wave`
(string or null), `next-landings` (array of PR numbers or `{pr, owner}`
objects), `holds` (string or null), `main-tip-verified` (string or null).
Updated on every state change and at least every 2 h while active.
A beacon older than 6 h = that actor is considered OFFLINE.

## Validation

`.github/workflows/validate.yml` **on this branch** runs on
`push: branches: [coordination], paths: ['ledger/**']` and executes
`node ledger/validate.mjs`, which schema-checks every ledger JSON file
(the fields above; every entry must carry `actor` + `requestId`).
Readers (the detector, mirror tooling) re-validate on every read anyway —
the workflow is the visible gate, the read-side check is the un-skippable
one.
