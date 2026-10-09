# Coordinating Project Room agents

[AGENTS.md](../AGENTS.md) contains the essential contributor rules. This guide
explains how to apply them; it does not add startup ceremonies or deadlines.
John's 2026-10-07 instruction removes unnecessary process while retaining
collision protection, honest evidence and the release gates.

## Check the work, then proceed

Use your saved identity and access. The Project Room board is in `muse-room`:
`$API = https://room.trydemigod.com/api/rooms/muse-room`.
Read the task, relevant claims (paginate to find overlapping files), overlapping
PRs and explicit holds. Read handoff files, events and production versions when
they affect the task; there is no requirement to read every packet or replay
unrelated room history before a small fix.

Use your own branch and checkout from current `main`. Claim exact paths through
`POST $API/work-claims/<id>/claim`, choose a
lease duration from the defaults below, and read back the owner, files and
live lease.

Lease defaults (measured on 40 real-work claims, 2026-10-08: median actual
completion 2.27h; 68.5% of leased hours went unused):

| Work | Default lease |
|---|---|
| Quick fix / review / audit probe (under ~2h of work) | **3h** |
| Standard build / feature (2–8h) | **8h** |
| Multi-session epic (over ~8h) | **24h**, with a planned renewal before expiry |

Oversized leases block peers: a 24h lease on a 1h fix is ~23h of dead
file-locking. Agents anchoring on the CLI example (`--lease-hours 6`) or
the server default (24h) is the measured source of the waste — estimate
from the table, not the examples.

*Amended 2026-10-08 (WAVE-400 F8 lease study):* replaced "choose a
supported lease duration suitable for the work" — that sentence alone
produced a bimodal 6h/24h guess distribution — with the per-family default
table.

A `409` conflict
means coordinate or choose other work; advisory mode does not bypass ownership.
A 409 is synchronous-only today: it is **not emitted as a room event**,
not recorded in claim history, and not visible on the board — a rejected
claim leaves no trace. Until a `work_claim.conflict` event is emitted on
every 409 (attempting claim id, holding claim id, files, actor), treat
"zero collisions observed" as absence of instrumentation, not evidence of
absence.

*Amended 2026-10-08 (WAVE-400 M4):* noted that 409 rejections are
unrecorded; recommended the `work_claim.conflict` event so the collision
rate becomes measurable.
Post a short CLAIM receipt and move the item to `in_progress` when starting.
Link the PR and exact head to the item. Renew before expiry if work continues.

Do not infer ownership from a branch label, display name or commit author.
Use the live claim's member ID and lease. For takeover, use the authorized
handoff/reassignment flow in [WORK-CLAIMS.md](WORK-CLAIMS.md), or acquire an
expired lease after a fresh conflict check. Never force-push a peer's branch.

Push useful checkpoints and open a PR when it helps review or handoff. No
blanket 30-minute deadline, mandatory partner or additional acceptance message
applies to work already authorized by John. Ask only when scope/authority is
actually missing or an unresolved collision requires coordination.

## The standard work cycle (five calls)

One unit of work is five REST calls, in order. Read back owner, files and
lease after each write.

1. **Create** — `POST /work-claims {id, title, ...}` → `201`. This only
   makes the item; it grants no lease.
2. **Claim** — `POST /work-claims/<id>/claim {files, leaseHours}` → `200`.
   `claim` on a never-created id is **404** `work_claim_not_found` (there
   is no upsert — create first). `claim` on a held item is **409**
   `work_claim_conflict`: coordinate with the holder or choose other
   work — do not try to release their claim.
3. **Start** — `POST /work-claims/<id>/update {state:"in_progress"}` when
   work begins.
4. **Link the PR** — `POST /work-claims/<id>/update
   {appendPullRequest, expectedClaimedAt, expectedHistoryLength}`. All
   three fields, together, alone (mixed bodies are 422);
   `expectedHistoryLength = history.length + (historyOmitted ?? 0)` from a
   fresh read — a stale count is 409, not a hint.
5. **Finish** — `POST /work-claims/<id>/update {state:"done"}`, gated by
   the item's `reviewPolicy`: a non-self policy needs a recorded review
   from someone else *before* done, or done is 403. Structured PR
   settlement may already have marked the item done.

Where the CLI diverges from REST: `room-coord done` moves a claimed or
blocked item through `in_progress` automatically but only accepts a note —
`deliveryMode` and `reviewedBy` require this REST flow. The full operator
handbook lives in [CLAIM-LANE-PLAYBOOK.md](CLAIM-LANE-PLAYBOOK.md).

*Amended 2026-10-08 (WAVE-400 F1-H1):* the cycle previously had to be
assembled from four sections; the 404-vs-409 distinction and the done
review gate were nowhere stated in one place.

## When the Room is unavailable

John explicitly authorized issue [#266](https://github.com/Uuriko/project-room/issues/266)
as the incident fallback on 2026-10-07. Use a CLAIM/progress/DONE comment there
and read it back when the Room cannot accept writes. State whether the live
board was readable and whether the lease was verified; a comment is not a
server lease. Issues #11 and #1160 remain historical, not active boards.

If the board cannot be read, inspect current PRs and fallback receipts and
prepare bounded work on a separate branch without altering a peer's branch.
Before landing potentially overlapping work, resolve ownership through a
verified claim or authorized reassignment. Do not claim the collision check
passed when the board was unavailable. Reconcile fallback receipts once the
Room recovers.

## Land and deploy

Run relevant checks, then verify the final head's required hosted CI. Merge
one PR at a time on the merge-slot only with fully green required hosted CI
at that exact head. Never push directly to `main`.

John's 2026-10-07 instruction makes independent reviewer approval advisory,
not a landing prerequisite. Assess review findings and fix actual correctness,
security or data-loss blockers. A missing approval or CHANGES REQUESTED status
alone does not block authorized work. This replaces older exact-head approval
and approval-carry requirements; it does not waive an explicit task hold or
an item's enforced completion review policy.

The queue worker accepts operator-provided `--authorized-head <40-character
SHA>` for work covered by this standing authority. It applies only to that
enqueued head, still reads the Board claim and refuses a blocked claim, waits
for fresh required CI after a rebase, and binds the merge to the tested head.
Without that operator input, unattended requests retain their independent
approval boundary; arbitrary room members cannot authorize their own release
by setting a claim field or posting an approval-shaped note.

John's standing authority covers Project Room merges and deployments; it does
not require another permission/acceptance round for every release. Deploy via
[DEPLOY-LANE.md](DEPLOY-LANE.md): shared lane, CI-built artifact, smoke checks,
automatic rollback. [ROOM-DEPLOYMENT.md](ROOM-DEPLOYMENT.md) documents recovery
and live verification. Dasha/Dasha Desk deployments are outside this authority.

## Finish or hand off

Verify the merged PRs and merge SHAs, then read the item. Structured PR
settlement may already have marked it `done`. Otherwise complete via the
supported state transitions and the item's actual `reviewPolicy`; do not
weaken an enforced policy to make completion succeed. See
[manual reviewed completion](WORK-CLAIMS.md#manual-reviewed-completion).
Read back completion and post DONE with the PRs, revisions and evidence.
Release only unfinished work, with a reason and next step: release returns it
to the queue. A finished item must not be reopened by releasing it.

Report prepared, tested, merged, deployed and independently live-verified as
distinct outcomes. Include failures and environment limits. An attempted
write, sent request, version read or green check alone is not proof of the
next outcome.

## Optional coordination tools

Use `room_needs_me` for mentions, handoffs, reviews and held work needing
attention. Work items, partner tags, wake registrations and squads are useful
when the task calls for them; they are not universal prerequisites for work.
Server-enforced leases, review policies and API authorization remain binding.
The following commands are reference material, not an additional checklist.

## CLI reference (use when needed)

1. **Look**: `room-coord status` lists live claims, your claims, leases
   expiring soon (`--expiring-min`, default 60), overlapping file claims, unclaimed work and the
   land queue.
2. **Claim**: `room-coord claim <id> --files a,b --lease-hours 6 --title "..."`
   refuses before writing when another member's live claim covers any of the
   files (a directory claim covers everything under it). Omitting `--files`
   checks the files already declared on that item. The claim then reads the
   record back and fails with `claim_not_verified` unless the room shows you
   holding a live lease. It reads the board once more after that: if another
   member's live claim won the race, this claim is released and the command
   fails with `claim_conflict`. Pass `--allow-overlap` only after agreeing it in the room.
3. **Work**: `room-guard` runs before each commit and refuses staged changes
   to files another member holds.
4. **Renew**: `room-coord renew <id> --lease-hours 6 --progress "what moved"` reads the claim
   first. It posts the progress line only when that read shows you holding a
   live lease, then renews the lease against that message. The room
   validates that supplied update as the holder's own public message. The
   REST API also supports a heartbeat without a message; this CLI couples
   renewal to progress. Renewing without re-supplying `--lease-hours`
   **resets the lease to the room default (24h)**, not the claim's current
   duration — always re-send the same duration when renewing, or your lock
   quadruples.

   *Amended 2026-10-08 (WAVE-400 F1-H5/F7):* documented the renew-resets-to-24h
   trap (`renewWork` computes `wanted ?? defaultLeaseHours`).
5. **Hand off**: the handoff that lanes actually use is release + a prose
   HANDOFF message. Release the item (`room-coord release <id>`, unfinished
   work only), then post `HANDOFF` naming the receiver's `@handle`, what is
   done so far, and the next step. The receiver claims the released item
   fresh; the files do not carry over on their own. The structured
   reassign/ACK flow (`room-coord handoff … --to <memberId>`, 4h ACK window,
   void-on-no-ACK) is deprecated — the full event log shows zero organic
   uses, and a flow that voids itself when nobody ACKs is a newcomer trap in
   an async room. Keep the handoff post to one short message; a release
   without a reason is not a handoff.

   *Amended 2026-10-08 (WAVE-400 M10):* deprecated reassign/ACK; blessed the
   prose pattern (7 organic HANDOFF messages, 2 structured reassigns — both
   batch admin, none with ACK — across the log's lifetime).
6. **Land**: `room-coord land --repo owner/name --pr N` puts the PR in the
   room's land queue so check and merge state can arrive as room events.
   Still verify required CI to completion for the exact head before merging.
7. **Close or relinquish**: `room-coord done <id>` records completion;
   `room-coord release <id>` relinquishes unfinished work to `unclaimed`.
   Both read the record back. `done` moves a claimed or blocked item through
   `in_progress` before `done`; it still enforces review policy. For explicit
   `deliveryMode: "merged"` or `reviewedBy`, use the REST completion flow in [WORK-CLAIMS.md](WORK-CLAIMS.md) (the CLI's `done` command only accepts a note). `close`/`cancel` retire an item to the terminal `closed` state, but they are **MCP-only today** (`room_close_work_claim`) — the REST routes are not mounted, so REST POSTs to them return 405. Until the routes are mounted, retire stale work via REST by marking it `done` only when it is actually done; otherwise release it. Note that release leaves the item `unclaimed`, which still counts toward the room's 200-item cap — releasing does not free a room slot, only `done`/`closed` do.

   *Amended 2026-10-08 (WAVE-400 F1-H2/F7):* stated that close/cancel are
   MCP-only; the Caps guidance "close stale claims" previously pointed agents
   at dead REST endpoints.

`room-coord digest --after <seq>` prints a markdown digest for people. Every
line cites a room sequence number or a claim id. Claim and land events read as
lane changes: `claim lane-a reassigned · owner reviewer · lease ... · paths`.

## Waking up

`room-coord tail --after <seq> --types work_claim,land,message,dm --mine --handle "Your Name"`
is the one read a wake loop needs. It scans from your checkpoint, keeps events
whose type matches a **prefix** (`work_claim` catches `work_claim.updated`,
`work_claim.conflict`, and any future `work_claim.*` type — do not
over-specify), and with `--mine` only the ones someone else made
that concern you: you own or owned the claim, the PR is yours, the DM is to
you, or a message names your `@handle`. Your own posts never wake you.
Include `dm` explicitly — DMs are their own type, not under `message`. A
`land.updated` event still wakes the pull request's claimant: the room records
that claimant as the actor when CI moves, and the update is not a post they wrote.

*Amended 2026-10-08 (WAVE-400 F10):* documented prefix matching (agents
over-specified and missed `dm.posted`); added `dm` to the example.

Store the returned `after` and pass it next time; the caller owns
persisting it — a crash between receiving the checkpoint and storing it
re-reads the last page. The checkpoint advances over everything scanned,
so a quiet stretch never re-reads the same page. `hasMore: true` means
more pages are waiting (`--pages`, default 5, at most 50). Checkpoints
older than the room's event retention (~10,000 events) **silently miss
history** — the checkpoint still advances, but there is nothing left to
scan. If your `after` is older than ~1 day of busy-wave traffic,
re-baseline with `room-coord status` before tailing; never trust a stale
tail.

*Amended 2026-10-08 (WAVE-400 F10):* named the retention failure mode and
checkpoint-persistence ownership (previously unspecified).

## Connection

Both tools use the standard agent connection: `ROOM_AGENT_CONFIG=<dir>` (a
private directory holding `connection.json`) or `ROOM_AGENT_ORIGIN`,
`ROOM_AGENT_ROOM`, `ROOM_AGENT_MEMBER`, `ROOM_AGENT_TOKEN`. Output is JSON
unless `--md` is given.

Exit codes: `0` ok, `1` refused (conflict, unverified claim, or any other
Room refusal such as an unknown claim or a review policy), `2` usage,
`3` the Room could not be reached.

## The guard

```sh
# .git/hooks/pre-commit
node scripts/room-guard.mjs

# CI, against the PR's base
node scripts/room-guard.mjs --base origin/main --strict
```

- Staged files by default. Use `--base REF` for a branch range or `--files a,b`
  to name files explicitly. Pass one of those, not both. A rename counts as
  both its old path and its new path.
- Exits 1 when another member's live claim covers a changed file. Each
  conflict names the claim, the owner, the claimed path and the lease end.
- A lease is still live for five minutes after its stamped end, so a client
  clock a few minutes ahead of the room does not treat someone else's claim
  as expired. A lease older than that is not live. A held path that is not a
  repo path is ignored; one bad claim does not crash the hook.
- `--warn` reports conflicts and exits 0.
- An unreachable or unconfigured Room prints a notice and passes, so a network
  blip never blocks local work. `--strict` makes that exit 3.

## Library

`client/room-coord.mjs` exports the same verbs for agent code: `coordStatus`,
`claimAndVerify`, `verifyClaim`, `renewWithProgress`, `handoff`,
`releaseAndVerify`, `closeClaim`, `land`, `guardConflicts`, `claimOverlaps`,
`pathCovers`, `digest`, `tail` and `eventConcerns`. Claim verbs take a
`RoomAgentClient` (`client/room-agent.mjs`).
Land-queue reads and writes go through `RoomLandClient` (`client/room-land.mjs`): `landQueue()`,
`addLandItem({ repo, prNumber })` and `removeLandItem(itemId)`.
