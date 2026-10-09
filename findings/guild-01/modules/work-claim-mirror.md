# server/work-claim-mirror.mjs — projection-claim mirroring

Projection claim commands (MCP and the work-item form) write the same
work-claims board the REST routes use. `mirrorProjectionClaim(store, roomId,
actorId, incoming)` translates projection events into board writes:

| Incoming type | Board effect |
|---|---|
| `claim.acquired` | Create (if new, honoring open-claim caps → 409 `work_board_full` / `too_many_open_claims`) then `claimWork` as the actor. |
| `claim.renewed` | `renewWork` by the owner; falls back to acquire when unclaimed/foreign. |
| `claim.released` | `in_progress`/`blocked` → pause to `claimed` first, then release to `unclaimed` (authority when the actor isn't the owner). |
| `work.handoff_recorded` | Acquire + chain a `handoff` link, then create the successor card (`<id>-next`) with `dependsOn: [source]`. |
| `work.superseded` | Chain a `supersede` link, set `supersededBy`, create the successor. |

`boardClaimId(workItemId)`: valid `[A-Za-z0-9_-]{1,128}` passes through;
anything else is sanitized (non-matching chars → `_`, leading underscores
stripped, 120-char cap) or falls back to `"workitem"`. Chain links are
capped at the newest 20.

Every write commits via `commit()` → `store.workClaims.set` +
`emitWorkClaimEvent`. A store without a registry (`get`/`set` missing)
returns null; malformed `incoming` (bad type, missing `workItemId`,
unparseable `at`) returns null or throws only `ClaimError` — never an
unexpected exception (fuzz-pinned).

## Gotchas

- `claim.renewed` for a foreign-owned claim silently re-acquires via
  `claimBoard`, which will throw `invalid_claim_input` (already held) —
  the error surfaces, nothing is half-applied.
- Successor ids derive from the source workItemId (`<workItemId>-next`);
  `boardClaimId` sanitizes collisions into the same namespace.
