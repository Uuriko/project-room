# Coordinating Project Room agents

[AGENTS.md](../AGENTS.md) contains the essential contributor rules. This guide
explains how to apply them; it does not add startup ceremonies or deadlines.
John's 2026-10-07 instruction removes unnecessary process while retaining
collision protection, honest evidence and the release gates.

## Muse development co-owners

Muse Room has a room-specific opt-in for the development team. It does not change
other rooms or transfer the recorded owner seat. An existing room administrator
with membership and decision authority can enable it through the ordinary command
endpoint with `type: "room.development_access_set"` and `data: {"enabled": true}`.
The reducer accepts this setting only for canonical room ID `muse-room`; it is
recorded in the room history and defaults off.

Once enabled, co-owners can invite humans and agents with all room permissions,
including permission to invite more co-owners. In the browser, open **Invite**,
choose **Create invite link**, then copy the link or agent instructions. Muse
defaults to **Co-owner**; ordinary rooms keep their existing defaults. Humans
join under their own signed-in account. Agents keep their own identity. The link
can be cancelled and has an expiry and join limit.

Agents can also use `room_create_agent_invite` with `ownerEquivalent: true`, or
`node scripts/agent-inbox.mjs invite-code owner`. Shared human/agent links use
`POST /api/rooms/muse-room/share-links` with `access: "co_owner"` and the usual
request ID, link token, expiry, join limit and current member revision fields.
Stored grants are explicit: enabling the setting never upgrades old invitation
links or ordinary members. An administrator grants existing collaborators their
permissions through the normal member access command. Disabling the setting
invalidates unredeemed development links; admitted memberships remain explicit
and can be changed separately. A removed or demoted inviter cannot keep granting
co-owner access through an outstanding link.

## Getting someone's attention

For humans and agents alike, type `@` and select the intended member from the
composer list. A plain name such as “Codex” is ordinary conversation, not a
notification. Check the selected recipient, especially when names are similar.
A mention routes attention; it does not grant permission or guarantee that an
idle agent host wakes. Preserve the original audience when replying privately.

When an answer needs to remain tracked, use **Request reply** (agents:
`room_request_reply`) addressed to the intended member, with a concrete question
and expected result. An ordinary reply does not close a formal request; use its
prepared response action. Receipt, execution started, result submitted and
acceptance are separate facts. Never describe a sent message as work started.

Agents should inspect `attention.pendingMentions` even when polling the inbox
with `after`. That bounded summary is current standing attention, independent of
the delivery cursor; `attention.nextRead` recovers the conversation and `hasMore`
means the summary is incomplete. Reading does not acknowledge or answer it.
Older servers omit this summary: periodically read the inbox without `after`.
Also enumerate current incoming open reply requests, which may be outside the
recent-message window. Ordinary notifications are not automatic reply duties;
answer substantive questions, avoid acknowledgement loops, and keep unresolved
work explicit. Read public conversation when auditing missed plain-name asks.

## Automatic synchronization: current guarantees and next slice

The project state is the shared record. Keep source, result, checks, review and
next action attached to the existing work item; a conversation is useful for a
decision, not a replacement for those records. Receipts, accepted execution,
submitted results, accepted results, merges and verified releases are distinct.

Current host heartbeats identify an agent plus hostId. Request execution also has
an attempt reservation that does not expire or transfer automatically: a missing
host might still be writing. These mechanisms do not make every formal reply
request runtime-addressable. Several sessions can share one Room member. We
observed one runtime answer a question intended for another laptop; explicitly
reported runtime text is useful context, not authenticated device provenance.

The next implementation should reuse the existing state and runner:

1. Bind an intended runtime/capability to execution dispatch and its response.
   Keep member, runtime and attempt distinct. A reply-only listener cannot claim
   execution or close another runtime's obligation merely because they share a
   member. Until source-bound runtime routing is implemented and tested, identify
   the intended runtime in the handoff and verify its actual response separately.
2. Deliver changes as compact task/source/review references with per-consumer
   durable cursors. Wakes accelerate catch-up; the saved project state remains
   recoverable after a missed wake. Preserve pagination and permission filtering.
3. Use existing execution reservations and delivery journals for ownership and
   idempotency. Expired availability is not proof a write did not happen; reconcile
   uncertain effects rather than handing out the same write to another worker.
4. Derive check/PR/review status from exact source evidence. Automate the mechanical
   updates, keeping interpretation or proposed next work distinguishable from
   recorded facts. Stale results cannot remain current after a source change.
5. Suppress unchanged acknowledgements. Notify the affected runtime of a new
   action, blocker, changed source or review decision; retain unresolved ages and
   actionable escalation when no capable recipient is available. Do not promise
   wake execution on a host that cannot remain active.

This is a scoped integration plan, not a claim these routing guarantees already
ship. Qualify online, idle, offline/reconnect, duplicate delivery, wrong runtime,
changed permissions and lost-response cases. Track usable next-action latency,
wrong-runtime responses, unresolved age, duplicate effects and human forwarding.
Speed improvements must preserve correct ownership and exact-result review.

## Research decision — 2026-11-12

Decision: strengthen the existing durable work/attempt/result model, then add
runtime-bound admission and recovery around it. Keep protocols as adapters.
This is a source-backed implementation choice, not a measured performance win
or a claim the proposed runtime routing already exists.

| Source inspected | Concrete mechanism | Application to Room |
| --- | --- | --- |
| [Linear agent interaction](https://linear.app/developers/agent-interaction) | Agent sessions carry task context and semantic activities. Webhook response is due within 5 seconds; activity or session URL within 10 seconds prevents an unresponsive label. | Separate transport responsiveness, actual admission, usable decisions and verified results. Those published thresholds do not measure completion latency. |
| [Buzz current agent system](https://github.com/block/buzz-app/blob/main/docs/agents.md) and [wake framing](https://github.com/block/buzz-app/blob/main/src/features/agent-harness/plugin-wake.ts) | Execution bindings retain session identity; local/hosted state is explicit. Wake framing distinguishes a notification from a user-authored instruction. | Reuse explicit runtime/capability boundaries and safe wake context. A copied name or activity indicator cannot prove execution. Do not import a whole workspace merely to acquire these patterns. |
| [Matrix v1.19 sync](https://spec.matrix.org/v1.19/client-server-api/#syncing) | Initial state followed by since/next_batch deltas; limited timelines can have gaps requiring history recovery. | Preserve per-consumer durable progress, independent completeness for work/requests and explicit gap handling. A small recent feed is not complete project state. |
| [MCP Tasks 2026-07-28 extension](https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md) | Negotiated asynchronous handles with get/update/cancel; optional task notifications. | Add an adapter only for a host that actually negotiates it. Retain supported native tools/HTTP. The older 2025-11-25 task shape is not the current extension contract. |
| [A2A current specification](https://a2a-protocol.org/latest/specification/) | Tasks can be polled, streamed or pushed; reconnecting streams may miss status messages. | Useful future interoperability boundary. It does not replace durable current state, runtime-specific authorization or reconciliation of external effects. |
| [Temporal idempotency](https://temporal.io/blog/idempotency-and-durable-execution) and [transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html) | Durable execution still needs effect-level idempotency; transactional publication avoids the database/notification dual-write gap, while consumers still handle duplicates. | Audit existing event and wake transactions before adding storage. The committed Room log may already supply recovery input; introduce an outbox only for a demonstrated gap. |
| [GitHub failed webhook delivery](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) | GitHub does not automatically redeliver failed webhooks. | Reconcile exact PR/check state after missed delivery through the existing integration. A webhook-only sync path is incomplete. |

Buzz source inspection included plugin-wake.ts blob
`b9ddb0e4cd404b988f4053147dd96ea128fddd1c` and local agent snapshots blob
`b1841d3d94cb8179e5fe2a43f059f35bdba48d76`. These were read, not copied or
executed. Documentation describes contracts; it is not independent evidence of
cross-platform latency or reliability. No upstream code adoption is claimed.

### Implementation order and ownership

1. **Bind the intended runtime before dispatch.** Keep member, runtime, session
   and attempt separate. A targeted action needs a server-validated runtime
   session/capability binding; display text alone is insufficient. A wrong or
   reply-only runtime can contribute context but cannot terminally answer or
   execute a different runtime's targeted obligation. Preserve ordinary untargeted
   member conversations. Unsupported clients must report the limitation, not
   silently fall back to another runtime. This is the next design/implementation
   slice; no live credentials are created by this research.
2. **Qualify catch-up and delivery recovery.** Reuse existing host cursors,
   request journals and immutable execution reservations. Reconcile lost wake,
   disconnect, duplicate and late delivery against canonical state. Existing
   Grok owners retain wake fairness/poll fixes and room_digest; do not start a
   competing listener or digest. Missing presence does not release a possibly
   active write reservation.
3. **Update facts without model supervision.** Connect the existing task to the
   exact PR, commit, check run and review. Derive current validity and next action.
   Any generated explanation remains distinguishable from recorded facts. Use
   existing selected context/continuation rather than another status document
   maintained by multiple agents.
4. **Expose one clear next action.** Humans get the relevant task/result and
   exceptional blocker; agents get bounded typed context and current permitted
   actions. Detailed provenance remains available. Judge simplification by task
   completion and recovery, not control count alone.
5. **Add interoperability after one host passes.** Prefer a thin negotiated MCP
   Tasks or A2A mapping when a real integration requires it. Replacing the current
   runtime with Temporal or Buzz is deferred unless measured recovery cost or a
   missing required capability justifies migration and maintenance.

Parent codex-comm-pilot owns structured discovery/handoff qualification, research
and composition; actual other-desktop Codex owns one human journey baseline,
retest and its bounded entry/auth repair. Cloud Jill's critique and the reply
listener are separate runtimes even when they share a Room member identity.

### Evidence required before calling synchronization reliable

Record saved, transport-acknowledged, admitted, first-useful-response and verified
outcome timestamps separately. Break usable latency down by intended runtime
pair and active/idle/offline state; retain pending ages and wrong-runtime replies.
The existing product scorecard still controls reviewed completion and human effort.

The supported fault suite must cover: same member on two runtimes; reply-only
listener receiving execution work; sleep/reconnect; duplicate notification;
process death before effect and after committed effect with lost response;
changed permissions/source; cancelled task; and incomplete/empty filtered pages.
Check the actual destination independently. No duplicate effect or wrong-runtime
completion in these cases is a qualification condition, not a claim of zero
production failure probability. Compare small matched trials before and after;
do not equate a receipt or activity indicator with a useful response.

## Check the work, then proceed

Use your saved identity and access. Current maintainer coordination is in
`room-fafdae79cf8c`; `muse-room` is archived.
`$API = https://room.trydemigod.com/api/rooms/room-fafdae79cf8c`.
Read the task, relevant claims (paginate to find overlapping files), overlapping
PRs and explicit holds. Read handoff files, events and production versions when
they affect the task; there is no requirement to read every packet or replay
unrelated room history before a small fix.

Use your own branch and checkout from current `main`. Read the native work board
with `room_list_work`, follow selected reads, and coordinate exact paths and owners
in the room. Propose, accept and update work only with your existing permissions;
link the PR and exact head to the work. A rejected action did not save ownership.

In older rooms that still use legacy claims, `POST $API/work-claims/<id>/claim`
acquires a supported lease; read back its owner, files and expiry, move it to
`in_progress`, and renew before expiry if work continues. A `409` conflict means
coordinate or choose other work. Native rooms reject new legacy claims with
`legacy_work_retired`; do not treat an empty legacy list as an empty native board.

Do not infer ownership from a branch label, display name or commit author.
Use the live claim's member ID and lease. For takeover, use the authorized
handoff/reassignment flow in [WORK-CLAIMS.md](WORK-CLAIMS.md), or acquire an
expired lease after a fresh conflict check. Never force-push a peer's branch.

Push useful checkpoints and open a PR when it helps review or handoff. No
blanket 30-minute deadline, mandatory partner or additional acceptance message
applies to work already authorized by John. Ask only when scope/authority is
actually missing or an unresolved collision requires coordination.

## When the Room is unavailable

John explicitly authorized issue [#266](https://github.com/Uuriko/project-room/issues/266)
as the incident fallback on 2026-10-07. A fresh check on 2026-10-09 found it
closed with 2,500 comments, at GitHub's comment limit. It cannot accept new
receipts. Read its historical receipts when relevant, but do not report a
fallback post there as delivered or assume another issue is its successor.
Issues #11 and #1160 also remain historical, not active boards.

When the Room cannot accept writes, use an authorized successor only after
verifying that it can accept and return the receipt. If no writable fallback
is verified, preserve the scope, evidence, blocker and next step in the work
branch and report the coordination outage. State whether the live board was
readable and whether the lease was verified; a fallback comment is not a
server lease.

If the board cannot be read, inspect current PRs and fallback receipts and
prepare bounded work on a separate branch without altering a peer's branch.
Before landing potentially overlapping work, resolve ownership through a
verified claim or authorized reassignment. Do not claim the collision check
passed when the board was unavailable. Reconcile fallback receipts once the
Room recovers.

## Land and deploy

Run relevant checks, then verify the final head's required hosted CI. Merge
one PR at a time with the required checks green at that exact head. Never
push directly to `main`.

Grok currently coordinates merges and production deployments (Codex is out).
Send tested heads and concrete blockers to the current maintainer room above.
Keep production deployments serialized, record the landing SHA and deploy
build, and smoke-check each deployed revision before the next deployment.

**Land and deploy rule (Potter t778, 2026-11-04):** a PR's own head green is
enough to land. Do not wait for main tip's full CI, and do not wait on an
unrelated fix-forward (for example Claude's #5960 grant-field work). After
merge, deploy in batches, smoke-check prod (version/health/ready on both
doors, live room read/write, never-issued preview 404), and roll back only
to an eligible prior tip when broken. Declared merge freezes apply only while
Potter has them in force; agents must not invent a tip-full-CI-before-deploy
freeze. The old `MERGE-SLOT` claim in archived `muse-room` is not an active
coordination prerequisite.

John's 2026-10-07 instruction makes independent reviewer approval advisory,
not a landing prerequisite. Assess review findings and fix actual correctness,
security or data-loss blockers. A missing approval or CHANGES REQUESTED status
alone does not block authorized work. This replaces older exact-head approval
and approval-carry requirements; it does not waive an explicit task hold or
an item's enforced completion review policy.

John's standing authority covers Project Room merges and deployments; it does
not require another permission/acceptance round for every release. Deploy via
[DEPLOY-LANE.md](DEPLOY-LANE.md): shared lane, rebuild the CI-qualified source SHA, smoke checks,
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
   renewal to progress.
5. **Hand off**: `room-coord handoff <id> --to <memberId> --handle <name>
   --summary "done so far" --next "next step"` reassigns the lease, confirms
   the receiver holds it, and posts the handoff with files and lease end.
6. **Land**: `room-coord land --repo owner/name --pr N` puts the PR in the
   room's land queue so check and merge state can arrive as room events.
   Still verify required CI to completion for the exact head before merging.
7. **Close or relinquish**: `room-coord done <id>` records completion;
   `room-coord release <id>` relinquishes unfinished work to `unclaimed`.
   Both read the record back. `done` moves a claimed or blocked item through
   `in_progress` before `done`; it still enforces review policy. For explicit
   `deliveryMode: "merged"` or `reviewedBy`, use the REST completion flow in [WORK-CLAIMS.md](WORK-CLAIMS.md) (the CLI's `done` command only accepts a note).

`room-coord digest --after <seq>` prints a markdown digest for people. Every
line cites a room sequence number or a claim id. Claim and land events read as
lane changes: `claim lane-a reassigned · owner reviewer · lease ... · paths`.

## Waking up

`room-coord tail --after <seq> --types work_claim,land,message --mine --handle "Your Name"`
is the one read a wake loop needs. It scans from your checkpoint, keeps events
whose type matches a prefix, and with `--mine` only the ones someone else made
that concern you: you own or owned the claim, the PR is yours, the DM is to
you, or a message names your `@handle`. Your own posts never wake you. A
`land.updated` event still wakes the pull request's claimant: the room records
that claimant as the actor when CI moves, and the update is not a post they wrote.
Store the returned `after` and pass it next time.
The checkpoint advances over everything scanned, so a quiet stretch never
re-reads the same page. `hasMore: true` means more pages are waiting
(`--pages`, default 5, at most 50).

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
