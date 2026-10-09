# Claim-board reconciliation (GUILD-03, COORD-300)

Offline, read-only diagnostic for the work-claim board. Given a JSON snapshot
of the board plus its surroundings, it reports coordination failures that are
otherwise invisible: stale READY cards, unrecorded state transitions, role
ownership that does not match any claim card, and claim/PR/branch drift.

It changes nothing. It is not imported by any server module, route, or test
besides its own. It never touches a live system.

## Running it

```sh
node scripts/claim-board-reconcile.mjs --snapshot path/to/snapshot.json [--pretty]
```

Exit codes: `0` = no findings, `2` = findings on stdout (JSON), `1` = bad input.

```sh
node --test tests/claim-board-reconcile.test.js
```

## Building a snapshot (read-only)

Export, never write. The three read paths that feed a snapshot:

1. **Board rows** — `GET /api/rooms/{roomId}/work-claims` (paginate; each item
   in its stored `workOf` shape: id, title, state, owner, history,
   historyOmitted, leaseExpiresAt, dependsOn, supersededBy, pullRequest,
   pullRequests, branch, repo, kind, updatedAt).
2. **Room events** — the room event tail, `work_claim.updated` envelopes
   (`data.workClaim`, `data.action`, `data.claimState`, `data.ownerId`).
3. **Role reports** — whatever announced a role as owned (room message, deploy
   log, MCP tool output): `{ role, reportedOwner, reportedAt, source }`.
4. **PR / branch context** — the PR list and branch list for the repo the
   claims reference (GitHub read API, or a local `git branch -a`).

Snapshot schema: `claim-board-snapshot/v1` (see the validator in
`scripts/claim-board-reconcile.mjs`). `now` anchors lease and staleness math;
`stalenessHorizonHours` defaults to 72.

## The checks

| Code | Severity | Meaning |
|---|---|---|
| `STALE_READY` | warn | Board lists the item `queue=ready`, but the linked PR is merged/closed, the card was superseded, or it sat untouched past the horizon. |
| `MISSING_LEDGER_ROW` | error | The item's state implies transitions (claim/start/finish/close…) that its history ledger never recorded, with no truncation to blame. |
| `LEDGER_TRUNCATED` | info | History rows were dropped by the SEC-2 cap (`historyOmitted > 0`); ledger proof is not verifiable, so no missing-row verdict is drawn. |
| `ROLE_OWNERSHIP_MISMATCH` | error | A role (e.g. `ROLE-DEPLOYER`) is reported as owned but the board has no live matching card — missing, lapsed, or held by someone else. |
| `ROLE_UNREPORTED` | info | A live role card exists with no matching role report in the snapshot. |
| `MISSING_PR_ROW` | warn | The claim links a PR URL the PR snapshot has no row for (or an unparseable URL). |
| `CLAIM_PR_STATE_DRIFT` | warn | The linked PR is merged/closed but the claim is still live (claimed/in_progress/blocked). |
| `ORPHAN_BRANCH` | warn | A non-terminal claim names a branch present in neither the branch list nor any PR row. |
| `EVENT_BOARD_DIVERGENCE` | error | The latest `work_claim.updated` event for a claim disagrees with its board row (state or owner), or the row is missing entirely. |

## Integration dependencies

Borrowed, never forked — semantics stay identical to the live board:

- `readyClaims` from `server/claim-coordination.mjs` — the exact ready-queue
  predicate the `queue=ready` route uses. "Ready" here means what the board means.
- `parsePullRequestUrl` from `server/claim-coordination.mjs` — canonical PR URL
  form for matching claim links against PR rows.
- Mirrored (not imported): the history-stamp shape `{at, agentId, action, note}`
  from `server/work-claims.mjs`; the `work_claim.updated` action vocabulary from
  `src/events.js` (`WORK_CLAIM_EVENT_ACTIONS`); the 24-hour `ROLE-DEPLOYER`
  convention from `docs/DEPLOY-LANE.md`.

Nothing in `server/` imports this script. The HTTP layer, routes, state
machine, and board protocol are untouched.

## What is NOT proven

- **Fixture-backed only.** Every finding is proven against snapshots, not
  against the live board. A green run proves the snapshot is internally
  consistent, not that the room is healthy.
- **Snapshot completeness is assumed.** A truncated export (missing events,
  partial PR list, stale `now`) produces false negatives, and can produce
  `MISSING_PR_ROW`/`ORPHAN_BRANCH` false positives. Each check documents which
  snapshot sections it needs.
- **The staleness horizon is a heuristic.** 72 hours is a guess, not a protocol
  rule; legitimately parked ready work will be flagged.
- **Lease math trusts the snapshot clock.** `now` comes from the exporter;
  skew between exporter and checker is not validated.
- **Reports are taken at face value.** The checker cannot authenticate who
  reported a role as owned, or whether the report is current.
- **Diagnostic only.** It does not repair, reconcile, or replace the board or
  the claim protocol. Findings are input for a human or a lane with write
  authority — this guild was explicitly ordered not to alter live state.
