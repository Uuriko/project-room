# Suspected bugs — server core (WAVE-400 docs-core)

Flagged by the docs workers, not fixed. Ranked by severity (data-loss /
corruption and auth first). Each item: file:line, one-line reason, source
module doc. Line numbers pinned to origin/main `c5d1c313a`.

## Top 5 — show an owner first

1. `server/work-claims.mjs` (`appendWorkPullRequest` / `registry.set`) — the
   compare-and-release guards *stale* callers only; `registry.set` is a blind
   upsert, so two concurrent *fresh* writers are still last-write-wins.
   (bugs/work-claims.md)
2. `server/room-context.mjs` (via `canonical()`) — `hash.update(undefined)`
   TypeError on malformed work-item fields; 500s every context read. Highest
   blast radius in the room-lifecycle set. (bugs/room-lifecycle-set.md)
3. `server/public-work-claims.mjs` (`apply`, release path) — release is two
   sequential `updateWork` calls (`claimed` → `unclaimed`); if the second
   throws, the claim sits `claimed`-by-nobody. Not atomic.
   (bugs/public-work-claims.md)
4. `server/work-claim-mirror.mjs:96` — unparseable `incoming.at` returns null
   *after* store.mjs INSERTed the event row: projection holds the event, the
   board never mirrors it. Silent split-brain. (bugs/work-claim-mirror.md)
5. `server/work-claim-routes.mjs:742` — the lease sweep runs on `receipts`
   search and single-claim reads, so read-only GETs can write
   `lease_expired` events. (bugs/work-claim-routes-b.md)

## The rest

- `server/work-claims.mjs` — `claimWork` doesn't check `supersededBy` while
  `appendWorkPullRequest` does; release/retire never clear `claimedAt`;
  release clears files/reviews/attestations but keeps PR links + CI,
  contradicting the "starts clean" comment; the no-op PR-link path returns
  raw un-normalized input. (bugs/work-claims.md)
- `server/work-claim-routes.mjs:1036` — `update` is strictly owner-only while
  release/reassign/close admit `manage_claims` via `authorityOver`.
  Asymmetric. (bugs/work-claim-routes-b.md)
- `server/work-claim-routes.mjs:799-807` — GET status/list run
  `closeLiveClaims`, emitting `state_changed` events from a GET.
  (bugs/work-claim-routes-b.md)
- `server/work-claim-routes.mjs:592-603` — REST `update` + `appendPullRequest`
  early-return skips the content-trust stamping the read route applies.
  (bugs/work-claim-routes-a.md)
- `server/work-claim-routes.mjs:609` — `?refresh=1` evaluated on the stale
  `options.auth` snapshot while core uses the reauthorized identity.
  (bugs/work-claim-routes-a.md)
- `server/work-claim-sqlite.mjs:125` — `configure()` read-modify-write isn't
  atomic; concurrent configures can lose a merge (low severity: rare,
  operator-initiated). (bugs/work-claim-sqlite.md)
- `server/work-claim-sqlite.mjs:108` — `delete()` waive-loop + DELETE
  non-atomic at this layer; safe today (land-queue wraps in a transaction),
  hazardous for future direct callers. (bugs/work-claim-sqlite.md)
- `server/work-claim-mirror.mjs:66` — `claim.acquired` on a non-`unclaimed`
  card returns the existing item silently; projection accepted, board
  unchanged, no board event. (bugs/work-claim-mirror.md)
- `server/work-claim-mirror.mjs:125` — missing `supersededByWorkItemId`
  collapses to literal id `"workitem"`. (bugs/work-claim-mirror.md)
- `server/work-claim-mirror.mjs:114-120` — handoff's `claimBoard` throws
  `too_many_open_claims` for an actor at cap, though handoff hands work
  *away*; the throw rolls back the projection event too.
  (bugs/work-claim-mirror.md)
- `server/public-work-claim-fence.mjs:37` — misleading "must be closed before
  entry" error when the permit table is absent; `withPublicWorkClaimWriter`
  can't nest, so `act()` + `autoClaim:true` throws the entry error.
  (bugs/public-work-claim-fence.md)
- `server/public-work-claims.mjs` (`match`) — sort comparator gets
  `undefined` ages for tasks missing from `public_work_tasks`; NaN
  comparisons make ordering nondeterministic. (bugs/public-work-claims.md)
- `server/public-work-claims.mjs` (`finish`) — receipt is inserted before the
  `done` claim write; a crash between them leaves a receipt with no `done`
  claim. (bugs/public-work-claims.md)
- `server/mcp-room-profile.mjs` — `mcpRoomAllowlist` returns `[]` (silently
  zero rooms) instead of erroring on key-verify failure (currently
  unreachable); pre-auth dispatch matches raw tool names while the authed
  path canonicalizes aliases. (bugs/mcp-room-profile.md)
- `server/mcp-http.mjs` — Fetch and Node adapters are hand-synced
  duplicates; a header change to one must be mirrored by hand.
  (bugs/mcp-http.md)
- `server/room-export-html.mjs:167-172` — `WORK_BLOCKER_RESOLVED` only
  appends a note; the work item stays `blocked` forever (one-way state
  machine). (bugs/room-export-set.md)
- `server/room-attachment-bytes.mjs:47` — `validAttachmentData("")` returns
  true; `stage` silently stores a 0-byte file. (bugs/room-export-set.md)
- `server/room-assistant.mjs:206` — ops-insert lacks `ON CONFLICT`;
  concurrent same-requestId retries 500 instead of replaying idempotently.
  (bugs/room-aux-set.md)
- `server/room-key-presence.mjs:54` — `lastSeenAt` uses `hosts[0]` of an
  unsorted filter, not the max. (bugs/room-aux-set.md)
- `server/http.mjs:3572/4611` — the `route` ternary fall-through names
  matchmaking/feedback/bounty/credits/boardV2 as `"ownership-transfer"`;
  safe today (all dispatch blocks return) but fragile.
  (bugs/http-c.md)
- `server/work-claim-events.mjs` (`wakeNamedReviewers`) — head fallback chain
  ends at `"none"`; two headless heads share a message id and coalesce into
  one wake. (bugs/work-claim-events.md)
- `server/messages-store.mjs` (`certifyMessagesParity`) — `sequences` covers
  only `message.posted` events; a message whose earliest write came from
  another row type fails parity on a correct row (likely unreachable).
  (bugs/messages-store.md)
- `server/store.mjs` (`eventsAfter`, ~line 4303) — calls `flipExpiredMentions(roomId)` BEFORE `authenticate()`; an invalid token commits a DB write before the 401, so unauthenticated SSE pumps can keep triggering writes. (bugs/store-c.md)
- `server/store.mjs` (`backfillReferralDepth`) — NULL `max_depth` invite
  rows "update" member rows to NULL and count as progress; the tick may
  report progress forever on a NULL chain. (bugs/store-b.md)
- `server/claim-coordination.mjs` (`rollupClaimCi`) — `neutral` conflates "no
  CI ran" with "CI passed"; callers treating neutral as pass approve claims
  with no CI. (bugs/claim-coordination.md)

## Per-module bug reports

Detail per module: [docs/wave400-core/bugs/](wave400-core/bugs/). Checked
and clear of SQL injection (all parameterized), auth-skipping MCP tools
(none found), and documented-but-unimplemented tools (all 107 resolve).
