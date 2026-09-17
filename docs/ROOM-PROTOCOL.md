# Room Protocol (v0)

> Portions adapted from [rowboatlabs/rowboat](https://github.com/rowboatlabs/rowboat),
> © rowboatlabs, licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)
> (Rowboat sources: `apps/harbor/CONTRACT.md`, `packages/protocol/src/mentions.ts`,
> `packages/protocol/src/changeset.ts`, `packages/server/src/mcp.ts`,
> `apps/x/packages/core/src/runtime/assembly/skills/spaces/procedures.ts`).
> Adapted to the substrate: GitHub issue comments, not websockets; GitHub is the
> durable log, and this doc is the protocol's only editable surface.

**Purpose.** Issue #266 ("Claims board") is a coordination surface, not a
chat room. This protocol defines the exact machine-readable and
human-readable shapes every lane (quill, quill-s2, instinct, grokbot,
codex, Jillian — see `docs/AGENT-LANES.md`) must use to claim work, report
state, hand off, and receipt. The rule that underwrites every rule below:
**stamp at write, never parse at read** — tooling reads the fenced blocks
and reason suffixes, and (for `[lane][claim]` comments only, see §1a) a
conservative parse of the prose around them.

**Posture: v0, deliberately unstable.** Breaking changes are expected and
fine while we dogfood. The one rule: every protocol change lands as a PR
touching this doc (see META-RULE).

---

## 1. The claim block

A claim is a machine-readable fenced block posted as a comment. Every
claim comment carries exactly one block; prose around it is context only —
except for the conservative `[lane][claim]` prose parse in §1a.

```room-claim
task-id:    RC-2026-09-16-003
lane:       quill-s2
files:      docs/ROOM-PROTOCOL.md
lease:      lease=12h
state:      submitted
reason:     write the room protocol spec from the wave brief
```

| Field     | Required | Rules                                                                               |
|-----------|----------|-------------------------------------------------------------------------------------|
| `task-id` | yes      | Unique per task, format `RC-YYYY-MM-DD-NNN`. Never reused after a terminal state.    |
| `lane`    | yes      | One of the registered lanes in `docs/AGENT-LANES.md`. Exactly one lane per claim.    |
| `files`   | yes      | Exact file paths, comma-separated, relative to repo root. `*` is forbidden.         |
| `lease`   | yes      | `lease=<N>h` (1–72). The TTL the claiming lane asserts it can hold.                  |
| `state`   | yes      | One of the A2A-lite words in §4, lowercase.                                         |
| `reason`  | yes      | One line: why this claim exists.                                                    |

- **One block per comment.** Two blocks in one comment = the first is the
  claim, the rest are prose (and are ignored by tooling).
- **Stamp at write, never parse at read.** A consumer of the board reads the
  fenced block's fields only. Ambiguity between prose and block resolves to
  the block, always. If the block is malformed (missing field, unknown
  state word), the claim is **rejected**: a RECLAIM-style comment says so,
  and the task stays unclaimed.

### 1a. Prose `[lane][claim]` (conservative parse)

A `[lane][claim]` comment *without* a fenced block is no longer invisible:
tooling parses it conservatively. Backtick-quoted path-shaped tokens (plus
`files:` / `claim:` lines) and a recognizable task-id become a
lease-bearing claim with the standard `lease=12h`, state `submitted`, and
the usual task-id reuse guard. Prose that yields no files (or no task-id)
is recorded as `unleased-prose-claim` — visible on the board as **needs
fencing**, never silently ignored. A fenced block, when present, always
wins; fenced-claim behavior is unchanged. (Docs lane may refine this
wording; the behavior lives in `scripts/room`.)

## 2. Status-line grammar

Every board comment opens with exactly one of these prefixes, which says
what the comment *is* before any reading is required:

- `[claim]` — asserts a new claim. Must contain a claim block (§1).
- `STATUS:` — a state transition for an existing task-id. Must restate the
  claim block with the new `state` (fields may otherwise stay identical).
  No new task is created; the comment's task-id must already be live.
- `DONE:` — terminal success. `state: completed` in the block; SHOULD carry
  a receipt per §7 in the same comment.
- `HANDOFF:` — transfers a live claim to another lane. Must contain the
  handoff block (§8) plus the restated claim block naming the receiving lane.
- `RECLAIM` — the two-strike nudge (§5), a duplicate-claim rejection notice,
  or an illegal-transition notice. May be posted by any lane.

A comment without one of these prefixes is prose and changes nothing. Board
tooling (and John's eyes) scan prefixes, not paragraphs.

## 3. A2A-lite state words

Every task moves through exactly this vocabulary. No other state words may
appear in a claim block.

```
submitted → working → completed | failed(code) | cancelled | suspended
```

Legal transitions:

| From        | May go to                                        |
|-------------|--------------------------------------------------|
| `submitted` | `working`, `cancelled`                           |
| `working`   | `completed`, `failed`, `suspended`, `cancelled`  |
| `suspended` | `working`, `cancelled`                           |
| `completed` | — (terminal)                                     |
| `failed`    | — (terminal)                                     |
| `cancelled` | — (terminal)                                     |

**Failure codes** (parenthesized after `failed`): `failed(BUDGET_EXHAUSTED)`,
`failed(BLOCKED_ON_HUMAN)`, `failed(INFRA)`. A failure code is mandatory on
the `failed` transition — "it failed" without a code is an illegal
transition and is rejected like a malformed block.

**Illegal state transitions are rejected.** A STATUS comment moving
`completed → working`, or skipping `submitted → completed`, changes nothing;
any lane posts a `RECLAIM` comment recording the rejection, and the task's
state stays whatever the last legal block said. Tooling must treat the
rejection comment as ground truth that the attempted transition never
happened.

**`submitted → working` is the claim.** Posting `[claim]` with
`state: submitted` followed by a `STATUS:` moving it to `working` is the
normal two-step: announce, then pick up. A lane may collapse both into one
comment (`[claim]` with `state: working`) only when starting immediately;
heartbeat (§5) always assumes `working` means hands-on.

## 4. Claim/lease mechanics

A claim is a lease, not a deed. It has a TTL, it needs a heartbeat, and it
can be taken over.

- **Lease.** `lease=<N>h` starts when the claim comment posts. TTLs are
  1h–72h; a lease longer than 24h SHOULD justify itself in `reason:`.
- **Heartbeat.** While `working`, the holding lane posts a `STATUS:`
  comment restating the claim block (same task-id, `state: working`) at
  least every half the lease, rounded down (a 12h lease heartbeats every
  ≤6h). A heartbeat may add one sentence of real news; routine status goes
  to the digest, not the thread (§12).
- **Takeover.** When a lease expires with no heartbeat, expiry is
  two-strike:
  1. **Strike one:** any lane (or John) posts a `RECLAIM` comment
     `@`-mentioning the holding lane: lease expired, heartbeat overdue,
     requesting status within 4h. This is an *interrupt* (§12) — it
     genuinely needs a person/agent to answer.
  2. **Strike two:** if no heartbeat lands within 4h of the nudge, any
     lane posts `RECLAIM` again, declares the claim released, and the
     task returns to `submitted` with no lane — open for a fresh
     `[claim]`. The released lane may re-claim, but with a new task-id
     (a task-id never gets a second claimant).
- **Duplicate live claim is REJECTED and recorded, never silent.** If a
  `[claim]` names a task-id that is already live (`submitted`/`working`/
  `suspended`) under another lane, the claim is refused: the first lane
  (or any lane) posts `RECLAIM` naming both task-ids and the colliding
  files. The duplicate claim block is void. No silent overwrite, no
  "I didn't see your claim."
- **Same-lane re-claim after expiry** is legal (new task-id, § above). The
  new claim's `reason:` must reference the expired task-id.
- **Files are exclusive for the life of the claim.** While a claim is live,
  no other lane edits the claimed files — do-not-collide beats merge.
  Overlap found *before* claiming means negotiating in prose first, then
  claiming non-overlapping file sets.

## 5. Lane-tag rules: address vs reference

Lane tags are deliberate tokens, never prose accidents:

- **A lane tag in a comment's structured claim block ADDRESSES that lane.**
  `lane: quill-s2` in a fenced block is addressed to quill-s2 — it stamps
  who owns the work and who the board holds responsible.
- **A lane name in prose is a REFERENCE only.** "quill-s2's doc" names a
  lane the way `#general` names a space (Rowboat's space token is a
  reference that notifies nobody): it reaches nobody, assigns nobody, and
  stamps nothing.
- **Only comment-start structured tags count as addressing.** A tag like
  `[quill-s2]` at the start of a comment (the existing room convention from
  #11) addresses that lane. A `[quill-s2]` appearing mid-prose is a
  reference. Tooling scans the block and the prefix, never the paragraph.

A bare lane name, a bare `@lane`, or a guess at a lane id addresses nobody —
exactly like Rowboat's mention grammar, where the href key (the token) is
what stamps, and prose names reach no one.

## 6. Receipts (24h SLO)

A receipt closes the loop. Every task that reaches `completed` SHOULD carry
a receipt; any merge that lands a PR to John's repos MUST carry one, posted
within 24h of the merge — the **receipt SLO**.

```room-receipt
task-id:  RC-2026-09-16-003
merged:   a1b2c3d
attribution: (quill-s2, agent, quill)
```

Receipt rules:

- **Outcome first, one or two sentences, no cheering.** "Merged: protocol
  spec adds claim/lease mechanics; board comments now machine-readable."
  Not "Awesome, just shipped an amazing update!!!"
- **Receipts say what was done, not what was read.** Never paste or
  summarize what the lane read while working — files, DMs, emails, notes —
  unless that content *is* the deliverable.
- **Carries the merge SHA.** `merged:` names the commit. If the work never
  merged (docs-only wave, failed deploy), `merged: none` and one line on
  where the output lives.
- **Any member may receipt, not just John.** The lane that did the work
  receipts its own merge; another lane that verified the merge may receipt
  that too. One receipt per task per lane.
- Privacy posture (Rowboat `PRIVACY_RULES`): everything posted lands in
  front of the whole room; read only what the task needs, answer only what
  was asked.
- *Amended 2026-09-16 (CI-as-evidence):* "done" = green hosted checks + a
  receipt naming **verifiable evidence** — the merge SHA, a check-run id, or
  a REST-verified comment id. Agent testimony alone ("I ran it, it looked
  fine") is not evidence. CI is the neutral witness: when a lane and the
  room disagree about whether something worked, the checks settle it.

## 7. Handoffs

A handoff moves a live claim between lanes. Format:

```room-handoff
task-id:     RC-2026-09-16-003
from:        quill-s2
to:          instinct
state-at-handoff: working
context:     protocol doc drafted; remaining: examples dir + digest rules
```

- The handing lane posts `HANDOFF:` with the handoff block and a restated
  claim block naming the receiving lane. The receiving lane ACKs with a
  `STATUS:` restating the block (same task-id) within 4h — the claim, and
  its lease clock, transfer on ACK, not on post.
- If the receiving lane does not ACK within 4h, the claim stays with the
  handing lane; the handoff attempt is void. No silent transfers.
- Handoffs reset the heartbeat clock but not the task-id. History stays
  one line: one task-id, two lanes, one handoff block between them.

## 8. Attribution

Every room mutation — claim, status, handoff, reclaim, receipt, merge —
carries attribution in three parts: **(lane, acting-mode, agent-name)**,
rendered as a trailing parenthetical, e.g. `(via quill-s2)` at minimum and
`(quill-s2, agent, quill)` in full. Acting modes: `direct` (John himself),
`agent` (an agent acting on its lane's own initiative), `scheduled`
(automation/cron).

- **Every mutation carries a `reason:` line.** A claim block has `reason:`;
  a handoff block has it; a merge comment adds `reason: <one line>` even
  when GitHub already shows the commit message. Rowboat's MCP face requires
  `reason` on every namespace op for exactly this cause: agents always
  attach a why.
- **No privileged path.** John's own comments follow the same grammar as
  any lane's. An agent's vote/reaction/edit/merge is the lane's act,
  attributed by mode — how it happened, never who else.

## 9. The suffix rule

When the fenced block can't travel — commit messages, PR titles, merge
comments, reason lines in other tools — provenance rides a suffix:

```
· claim:RC-2026-09-16-003 · lane:quill-s2
```

(Rowboat's `threadRootFromReason`: a reason ending in
`· thread:<rootId>` files the change under the thread; here the suffix
files the mutation under the task and the lane.) The suffix is read by
tooling with the same regex everywhere — one grammar, one parser:

```
/\s*·\s*claim:([0-9A-Za-z_-]+)\s*·\s*lane:([0-9A-Za-z_-]+)\s*$/
```

A suffix that doesn't match this grammar matches nothing; a malformed
suffix is not a half-match.

## 10. Noise discipline

The claims board (#266) is for **claims, handoffs, and receipts** — not
play-by-play. The room-wide reactions carry the lightweight channel:

- 👀 — **picked up.** Posted (as a reaction, not a comment) when work
  starts. That is the whole "on it" — never post a comment to say so.
- ✅ — **done.** Swaps the 👀 when the outcome is posted. Post nothing
  when the outcome speaks for itself — the merged file, the titled thread,
  the receipt.
- ❗ — **a person is needed.** A blocker, a choice only John can make, a
  confirmation that can't come from the room. Say nothing in the thread
  beyond the marker and the one-sentence ask; move the discussion to where
  John actually is.

Reaction etiquette: react to the invoking comment; don't thread under it.
Status that wants words but isn't a claim/handoff/receipt belongs in the
digest (§12), not the board.

## 11. Mention-as-interrupt routing

`@`-mentions are interrupts. Use them sparingly, and only when a response
is genuinely needed:

- **Interrupt-worthy:** strike-one expiry nudges (§4), handoff ACK
  requests (§7), `BLOCKED_ON_HUMAN` failures, John's decisions.
- **Not interrupt-worthy:** heartbeats, receipts, routine status, "nice
  work." Those go to the digest.

**The digest** is the periodic rollup (per run / per day) summarizing
state changes since the last one — task-ids, transitions, receipts — with
no @-mentions except for items that need John's call. If it doesn't need
an answer, it doesn't get a mention.

## 12. META-RULE

**Protocol changes are PRs touching this doc plus `docs/examples/`, never
room comments.** A protocol change that isn't such a PR didn't happen.

- Verbal agreements in the room ("let's do leases differently") change
  nothing. File the PR.
- Amendments carry dates: `Amended 2026-09-16 (…)` under the changed
  section, dated-amendment style, so the doc reads as its own changelog.
- `docs/examples/` carries a passing and a failing example for every
  machine-readable block (§1, §7, §9) — fixtures are the conformance
  harness: add a fixture with every grammar dispute, and the dispute stays
  settled.
- Breaking changes are legal (v0 posture) but must say so in the PR body:
  "BREAKING: …" plus the migration (e.g. "old task-ids grandfathered,
  new claims use RC-…" ).

## 13. Non-goals

What this protocol deliberately is not, and will not grow into:

- **No servers, daemons, or sockets.** GitHub is the log; comments are the
  events. There is no harbor process to run, no websocket to subscribe to.
- **No A2A wire protocol.** §3's state words are a vocabulary for
  comments, not a schema for machines to negotiate over HTTP. Agent-to-
  agent happens in prose + fenced blocks, through the issue.
- **No content-merge engine.** Do-not-collide beats merge, always. Claims
  are exclusive on files; there is no three-way anything, by decision.
- **No stale-bot mass-close.** Expired claims are *reclaimed*, not closed
  (§4). A task that mattered stays open under a new task-id; a task nobody
  re-claims was never important.
- **The protocol never lives in chat.** If the rule isn't in this doc (as
  amended by a META-RULE PR), it isn't a rule — including rules proposed
  in DMs, threads, or "quick syncs."

---

*Amended 2026-09-16: initial port from rowboatlabs/rowboat patterns to the
GitHub-issues substrate (claim blocks, reason suffixes, receipt grammar,
mention tokens → lane-tag addressing, no-privileged-path attribution).*
