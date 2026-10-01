# Handoff: every work-claim change is a room event

From Grok Bot (coordination lane, muse-room claim `grok-coord-claim-events`).
The box this was built on can push files through the GitHub connector but cannot
rewrite a 100 KB `src/events.js` byte-for-byte, so the commit ships here as one
`git format-patch` file. It applies cleanly on main `02409a17`.

## Apply

```
git checkout grok/work-claim-events-20261001
git am .handoff/work-claim-events/0001-work-claim-events.patch
git rm -r .handoff && git commit -m "Drop handoff patch"
npm run check && node --test tests/work-claim-events.test.js
```

Then open the PR against main with the body below.

## PR: Work claims: every claim change is a room event with the real actor

**Problem.** A claim, renewal, handoff or release changed only the `work_claims`
table. Nobody saw it in the room timeline, the `/events` tail, digests or an
agent's wake feed, so agents re-announced every claim in chat and a stale claim
was invisible until someone read the board. Created claims were attributed to
`system`.

**Behavior.** Each committed change through `/api/rooms/:id/work-claims` appends
one `work_claim.updated` event in the same transaction: `created`, `claimed`,
`state_changed`, `reviewed`, `released`, `reassigned`, `renewed`, and
`lease_expired` from the sweep. The event names the member who acted and carries
`workClaim`, `action`, `claimState`, `ownerId`, `previousOwnerId?`,
`leaseExpiresAt`, `title`, `paths`. A refused change appends nothing. The type is
server-only (not a command shape), so a member cannot forge one. The reducer
validates and never copies it into the projection, matching `land.updated`; no
schema bump. `createWork` records the creating member.

**Files.** new `server/work-claim-events.mjs`; `server/work-claim-routes.mjs`
(one `commit()` helper replaces each `registry.set`); `server/work-claims.mjs`
(creator attribution); `src/events.js` (type + validator); new
`tests/work-claim-events.test.js`. None are in an open PR.

**Verification (Node 24.21, repo ESLint config).** New test 6/6. Unchanged and
green: work-claims, work-claim-{duplicates,files,leases,qa-fixes,sqlite,store,
sweep,client,durable-http,schema}, claim-{overlaps,collisions,scopes,validate,post},
claims-index, events, event-audit, events-after-sequence, events-cursor-paging,
state-machine-invariants, land-queue, mcp-core-profile, next-actions,
public-work-* (8 files), recovery, room-export, room-context, return-brief and
30 more that touch claims or event types (66 files). The only failure,
`room-sweep-dry-run`, fails identically on main without the bash `scripts/room`
runtime. ESLint and `check-no-shadow-imports` clean.
