# The fleet coordination layer is already in the event model

16 September 2026. Claude (Cowork) growth lane. Proposal, not a claim. New file.

## The short version

[MARKET-POSITION](MARKET-POSITION-2026-09-16.md) named the beachhead as the
multi-agent operator. That person's current workaround is sitting in this repo's
parent directory, and it is a worse version of something Project Room already
models. `claim.acquired` is a distributed write lock with an expiry, and the fleet
is doing the same job by appending rows to a markdown file by hand.

Nothing here needs a new primitive. It needs the existing ones pointed at the
operator's own problem.

## Evidence from one session, first hand

This is not a survey. Over three days of working alongside Codex, Grok Build and
Claude in Slack on this repo, these are failures that actually happened to me.

| What happened | What it costs |
| --- | --- |
| I posted a coordination message to the shared channel. The script reported success. It reached nobody, because `dg-bus.py` resolves `Path.home()`, which inside a different mount is not `/Users/johnpotter`. I only noticed because I grepped the file afterwards. | Silent message loss between agents. The worst possible failure, because everyone believes they coordinated. |
| Occupancy is `AGENT-BOARD.md`, an append-only markdown table, plus `collision-check.rb` reading mtimes. Nothing enforces it. Two agents can claim the same path and both be told yes. | Advisory locking only. It works because everyone is polite. |
| I published two wrong recommendations to the fleet and had to retract both on the channel. There is no mechanism that marks an earlier statement withdrawn. A retraction is just a newer message that people may or may not read. | Wrong instructions stay live and actionable in the log. |
| I could not tell whether anyone had read anything I sent. | No delivery or read state at all. |
| Four tests hardcode absolute paths into sibling worktrees and pass only on one Mac. | Parallel worktrees with no shared contract between them. |

Outside sources describe the same hole. One 2026 write-up on parallel agent
sessions concludes that "the full stack, agent orchestration, window management,
and resource isolation in a single integrated product, doesn't exist", and notes
that Cursor has "no inter-agent messaging primitive". The nearest tool, Sidecar,
normalises session history across Claude Code, Cursor, Codex and Gemini, which
reads what agents did rather than coordinating what they are about to do.

## The mapping nobody has connected

Every column on the left is improvised in markdown today. Every column on the
right already exists in `src/events.js` and is tested.

| Fleet does this by hand | Room already has |
| --- | --- |
| `AGENT-BOARD.md` append-only claim rows | `work.proposed` with `accountableMemberId`, one owner per item |
| "One writer per path", enforced by politeness | `claim.acquired` with `repository`, `ref`, `paths[]`, `expiresAt`, which **refuses a second active claim** and expires on its own |
| `collision-check.rb` reading mtimes | the claim is the lock; no filesystem guessing |
| `AGENT-CHANNEL.md` plus `channel.jsonl` | the Room conversation, with agents as members |
| "Codex has authority, yield if contested" | permissions: `manage_claims`, `steer`, `decide` |
| Retraction by shouting a newer message | `work.superseded`, `verification.recorded` with a fail result, `owner.decision_recorded` |
| "Did anyone read this" | membership and event log, per member |
| Receipts pasted into chat | `Receipt` objects with evidence versions and exact-completion checks |

The write-claim is the striking one, and it is stronger than the first version of
this document claimed. **Verified 16 September, against the code and by running it.**

`acquireClaim` in `src/events.js` requires a `write` work item, restricts
acquisition to the accountable member, demands `write_external`, and demands
explicit `paths` with a future `expiresAt`. On its own that only refuses a second
claim on the *same* work item, which I confirmed by driving the pure engine
directly: two members took simultaneous active claims on the identical path.

The cross-item exclusion lives one layer up, in `server/claim-scopes.mjs`.
`conflictingClaim()` scans every other work item with a live claim, matches on
declared `repository` and `ref`, and compares path scopes with segment-aware glob
support (`folder/**`, `**`), treating an unparseable legacy scope as a conflict
rather than waving it through. `server/store.mjs` calls it inside the same
transaction as actor and revision validation, and refuses with `409 claim_conflict`
and a message naming the work item holding the scope.

So it really is a path mutex with expiry, enforced at write time, and it is already
covered by seven tests in `tests/claim-scopes.test.js` plus separate-process
serialization tests in `tests/mcp-lifecycle.test.js`. That is considerably better
than the honour system the fleet runs on, and it has been sitting there while three
agents coordinate through a markdown table.

One property worth knowing before anyone builds on it: the exclusion is
**deliberately live-only**. The comment at the call site says so, and the reason is
sound, since replaying history must never retroactively reject a reservation that
was legitimately accepted at the time. The consequence is that a plain `replay()`
of the event log does not re-check overlap, so any alternative writer has to import
`conflictingClaim` or it silently loses the guarantee.

## First slice, deliberately small

Do not build a fleet product. Use the Room for one real job and see whether it
holds.

1. One Room, one work item per lane, the accountable member being the agent in
   that lane. This replaces the board rows.
2. Agents acquire a write claim naming the actual paths before editing, and
   release on finish. This replaces `collision-check.rb` and turns the honour
   system into a refusal.
3. Coordination talk happens in the Room conversation rather than
   `AGENT-CHANNEL.md`, which removes the silent-loss failure, because a Room post
   either lands or errors.
4. A withdrawn recommendation is superseded rather than shouted over.

The operator running this is the same person who owns the repo, which makes it the
cheapest possible pilot: one user, already in pain, already improvising, and able
to say precisely where it breaks.

## What blocks it

**Correction, 16 September.** This section previously said the proposal was blocked
because persistence is `none` and nothing survives a restart, and told the fleet not
to start before persistence landed. That was wrong, and it parked a workable idea.

`persistence: "none"` is a field in `openJoinContract()` describing the **anonymous
self-join preview**, not the Room. The companion `publicMcpCard()` says it in plain
words: "Self-join is not persisted." The Room itself persists. `server/store.mjs`
opens a real SQLite database, and the live Worker binds a SQLite-backed Durable
Object (`durable_objects` binding `ROOM`, migration `new_sqlite_classes:
["ProjectRoom"]`), with `cloudflare/room.mjs` constructing the store over
`ctx.storage`. Members who arrive by invitation or owner enrolment are durable
today.

That removes the blocker for this proposal entirely, because fleet agents would join
as **enrolled members**, not anonymous walk-ins. The gate the contract actually
names, "no persisted self-join until abuse controls and owner decision", is about
strangers walking in off the open preview, which is not what a coordination pilot
does.

Two smaller gaps if it does go ahead. Claims need `write_external` permission and
a `write` mode work item, so an agent lane needs that permission granted
deliberately. And there is no notion of a claim on a path *outside* a repository,
which is what most of the fleet's real contention is about, since `AGENT-BOARD.md`
itself is contended.

## What this is not

A proposal with one session of first-hand evidence behind it and no user research.
It is worth testing precisely because the first test costs nothing: the pilot user
is already here, and the alternative he is using is a markdown file.

## Sources

- [Designing the Multi-Agent Development Environment](https://alexlavaee.me/blog/parallel-agent-sessions-infrastructure-gap/)
- [The Code Agent Orchestra, Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- [Parallel AI Coding with Git Worktrees](https://jsmanifest.com/parallel-ai-agents-git-worktrees)
