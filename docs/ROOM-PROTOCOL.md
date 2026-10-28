# Room Protocol — claim & receipt grammar (normative extract)

> **What this is.** The machine-readable grammar of the issue-board
> protocol: the claim block, status lines, state words, claim/lease
> mechanics, lane tags, receipts, handoffs, attribution, the suffix
> rule, and the dispute grammar. `scripts/room` and the board parsers
> implement these shapes exactly, and the test suite treats §3–§4 as
> its oracle — this extract is the normative source for that grammar.
> Original section numbers are preserved, so the `§4e`, `§6`, and `§9`
> citations in code, tests, and fixtures resolve here.
>
> **What this is not.** Current contributor rules. Room Protocol v0 was
> the operating system of a frozen issue board (issues #11, #1160,
> #266); its board-era operating sections — §10 noise discipline, §11
> mention-as-interrupt routing, §12 META-RULE, §13 non-goals, §15
> friction reports, and the advisory merge-coordination checks — are
> not reproduced here. The complete v0 text is archived verbatim at
> [archive/docs/reports/ROOM-PROTOCOL.md](../archive/docs/reports/ROOM-PROTOCOL.md).
> Current contributor coordination starts at
> [ROOM-COORDINATION.md](ROOM-COORDINATION.md).

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
| `lane`    | yes      | One of the registered lanes in `lanes/REGISTRY.md`. Exactly one lane per claim.    |
| `files`   | yes      | Exact file paths, comma-separated, relative to repo root. `*` is forbidden.         |
| `lease`   | yes      | `lease=<N>h` (1–72). The TTL the claiming lane asserts it can hold.                  |
| `state`   | yes      | One of the A2A-lite words in §3, lowercase.                                         |
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
  a receipt per §6 in the same comment.
- `HANDOFF:` — transfers a live claim to another lane. Must contain the
  handoff block (§7) plus the restated claim block naming the receiving lane.
- `RECLAIM` — the two-strike nudge (§4), a duplicate-claim rejection notice,
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
heartbeat (§4) always assumes `working` means hands-on.

## 4. Claim/lease mechanics

A claim is a lease, not a deed. It has a TTL, it needs a heartbeat, and it
can be taken over.

- **Lease.** `lease=<N>h` starts when the claim comment posts. TTLs are
  1h–72h; a lease longer than 24h SHOULD justify itself in `reason:`.
- **Heartbeat.** While `working`, the holding lane posts a `STATUS:`
  comment restating the claim block (same task-id, `state: working`) at
  least every half the lease, rounded down (a 12h lease heartbeats every
  ≤6h). Each heartbeat **renews the lease**: the TTL extends from the
  heartbeat time, not the original claim time. A heartbeat may add one
  sentence of real news; routine status goes to the digest, not the
  thread (§11).
- **Takeover.** When a lease expires with no heartbeat, expiry is
  two-strike:
  1. **Strike one:** any lane (or John) posts a `RECLAIM` comment
     `@`-mentioning the holding lane: lease expired, heartbeat overdue,
     requesting status within 4h. This is an *interrupt* (§11) — it
     genuinely needs a person/agent to answer.
  2. **Strike two:** if no heartbeat lands within 4h of the nudge, any
     lane posts `RECLAIM` again, declares the claim released, and the
     task returns to `submitted` with no lane — open for a fresh
     `[claim]`. The released lane may re-claim, but with a new task-id
     (a task-id never gets a second claimant).
- **Submitted-state claims are struck the same way.** A claim that never
  moved `submitted → working` gets strike-one when its lease expires and
  releases (lane cleared) on strike-two like any working claim — an
  expired submitted claim has the same expiry path, never a silent rot.
  Suspended claims are not struck (out of scope for the takeover).
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

### 4a. Machine collision check

`server/claim-collisions.mjs` (`findClaimCollisions`) is the machine
reading of the exclusivity rule: given open claims with file lists, it
returns every file claimed by two or more open claims, with the holding
claim ids and lanes. Path variants (`./x`, `x//y`) normalize to the same
file; closed claims (`done`/`withdrawn`/`closed`/`expired`/`released`/
`rejected`) release their files and never collide. Before opening a claim,
a lane SHOULD run its intended file set through the detector against the
current board — a hit means negotiate first, then claim non-overlapping
files. The detector is advisory: it flags, it never blocks.

### 4b. Live file-claim registry (S1)

`scripts/room rebuild` renders two machine sections into ROOM-STATE.md from
the live (submitted/working/suspended) claims:

- `## file-claims` — inverted index: `file | lane | task-id | state`, one
  row per file per live claim, sorted by file then task-id. This is the
  live map of who is touching what, right now.
- `## overlap-warnings` — `file | lanes | task-ids` for every file held by
  two or more live claims. Empty (rendered as `(none)`) in the healthy case.

The `## signals` line carries `files_claimed=<n>` (unique files across live
claims) and `overlap_files=<n>` (files with 2+ live holders) for machine
consumers.

`scripts/room overlaps` is the read-only pre-claim check: `--files "a,b"`
reports which live claims already hold those files (`(unclaimed)` when
free); without `--files` it reports all current overlaps. The `claim` verb
hard-refuses when the requested files collide with another lane's live
claim; `overlaps` is the soft check a lane runs before drafting.

### 4c. Durable knowledge base (kb/)

`kb/` is the room's durable agent memory: markdown, git-versioned,
human-readable. State belongs in git, not in agent memory — the next
lane recovers cold from these files.

- **Layout.** `kb/index.md` (hand-maintained front door),
  `kb/notes/` (reusable learnings: gotchas, tool quirks),
  `kb/plans/` (per-claim: what was attempted, what worked, what
  didn't, what the next lane should know), `kb/decisions/` (why, with
  date and decider).
- **Write path.** When a lane posts `[done]`, it also writes
  `kb/plans/<task-id>.md`. When it learns something reusable, it writes
  `kb/notes/<slug>.md`. A `[done]` block may carry an optional `kb:`
  line linking the plan note. Keep AGENTS.md for the *critical*
  lessons; kb/ holds the long tail.
- **Read path.** Workers `grep -r kb/` at task start. Promote to an
  index (sqlite FTS or similar) only when grep stops being enough —
  markdown stays authoritative, any index is derived and rebuildable.
- **Index discipline.** A stale index is worse than none: every kb file
  must be linked from `kb/index.md`, and every link must resolve. The
  `tests/kb-index.test.js` suite enforces this.

### 4d. Backlog — the fed queue

`BACKLOG.md` (repo root) is the prioritized fed queue. The claims board is
self-declared work; the backlog is fed work. Sections: `## ready`
(ranked, top first), `## blocked`, `## done` (archive, newest last).
One line per item: `- [ ] BL-NNN · title · scope: ... · accept: ... ·
files: f1, f2`, with optional `· blocked on: ...`, `· claimed: RC-...`,
`· shipped as: #NNNN` trailers.

The dispatch convention (GUPP — "if there's work on your hook, you run
it"): an idle lane runs `scripts/room backlog pull`, which takes the top
unclaimed ready item, marks it `claimed: <task-id>` in place, and emits a
pre-filled `[lane][claim]` fenced block (task-id, title, `files:` from the
backlog line) for the lane to post. The lane works it in its own
persistent worktree, opens a PR, posts `[done]`, then runs `scripts/room
backlog done BL-NNN --pr NNNN` to archive it. One agent per item.

`backlog pull` refuses when the item's files are held live by another lane
(via the S1 overlaps check, when present). Room-watch `metrics` reports
`backlog_ready` / `backlog_blocked` depth; "backlog empty" in the digest is
a signal for John (add items or pause the loop).

John's single lever: reorder `BACKLOG.md` (or comment the desired order on
#1160 and a lane applies it). The file is the schedule.

### 4e. File scopes in claims (R3, 2026-09-27)

A claim's `files:` entry may carry a trailing parenthesized scope naming
the claimed sub-area, e.g. `server/store.mjs (OTel fanout span only)`. An
entry with no scope claims the whole file. The board reducer
(`scripts/room rebuild`) refuses a claim whose files overlap another
lane's *live* claim, recording the refusal — this is the machine closing
the TOCTOU gap between the client-side `overlaps` pre-check and board
acceptance. Overlap semantics:

- Same path, either entry unscoped → overlap (an unscoped claim covers the
  whole file, so it collides with any scoped entry on that file).
- Same path, both scoped → overlap only when the scope text matches
  exactly after trimming and case-folding.
- Different paths → never overlap.
- Only live claims (`submitted`/`working`/`suspended`) held by a *different*
  lane block; same-lane entries never collide, and released (strike-two,
  lane cleared) or terminal (`completed`/`failed`/`cancelled`) claims free
  their files.

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
- **Comment-start lane tags use only letters, digits, `_`, and `-`.**
  A display name with spaces, such as `[Grok Bot][claim]`, is not a lane ID.
  The board parser emits `lane-tag-unparseable` (with a failed log entry)
  rather than registering a claim or silently treating it as prose. Use the
  registered short lane ID, or a fenced `room-claim` block with a valid lane.
  Do not silently strip spaces: that could address another lane.

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


## 14. Dispute resolution grammar

Disputes are board citizens: they live on the board as comments with fenced
blocks, not in a side system. Two kinds, one grammar:

- **Coordination disputes** — about the board itself: a `DONE:` receipt that
  doesn't satisfy the claim, a contested takeover, an attribution fight on
  the contribution ledger. Enforcement = enforcer verbs (mechanical records,
  ROOM-STATE.md, receipt revocation). No money moves.
- **Economic disputes** — about escrowed bounty payouts: a challenged accept,
  a severity/payout disagreement. Enforcement = the escrow's single final
  callback (`onDisputeFinalized(bountyId, outcome)`), denominated in the
  value at stake, cost capped at 25% of the bounty.

New status prefixes (see §2 — a comment without one of these, or one of §2's,
is prose and changes nothing):

- `DISPUTE:` — opens. Carries the `room-dispute` block.
- `EVIDENCE:` — submits evidence. Carries the `room-evidence` block.
- `ADJUDICATE:` — mechanical; seats the decider and moves the dispute to
  `adjudicating`. Posted by the enforcer or the seated decider, never by a
  party.
- `APPEAL:` — escalates to the next tier. Carries the higher bond reference.
- `RESOLVED:` — terminal. Carries the `room-dispute-resolution` block.

Lifecycle (A2A-lite style, cf. §3):

```
opened → challenged → evidence → adjudicating → decided → resolved
   │          │            │             │             │
   │          │            │             │             └─→ appealed → adjudicating (next tier)
   │          │            │             └─→ (enforcer) resolved  [non-response forfeiture]
   │          │            └─→ withdrawn   [disputant withdraws; bond forfeit]
   │          └─→ withdrawn
   └─→ withdrawn
```

- `opened` — raised with standing + bond posted. The claim/receipt under
  dispute is **frozen**: sweep skips it (no expiry, no takeover) and
  ROOM-STATE.md shows it as `completed (disputed)`.
- `challenged` — the challenge is raised against the frozen receipt/accept.
  First evidence entry moves the dispute to `evidence`.
- `evidence` — 72h window. Both sides submit `room-evidence` blocks.
  Party-submitted evidence only; platform-generated evidence (CI runs,
  ledger events) is fetched by the decider, never posted by parties.
- `adjudicating` — a decider is seated and deliberating (time-boxed 72h).
- `decided` — ruling issued with reason codes. Terminal unless appealed
  within 48h; an unappealed `decided` finalizes to `resolved` (optimistic
  finality). A `frivolous` ruling forfeits the bond and has no appeal as of
  right.
- `appealed` — escalation to the next tier with a geometrically higher bond
  (2× the previous tier's bond; loser-pays the escalation). Returns to
  `adjudicating`. The 25% cost cap spans the whole escalation.
- `resolved` — final. Outcome ∈ {`upheld`, `rejected`, `split`,
  `frivolous`}. Enforcement executes exactly once.
- `withdrawn` — disputant withdraws; their bond is forfeit.
- `unavailable(<reason>)` — honest-unavailable overlay, not a state: the
  dispute is recorded but cannot proceed to `adjudicating` until an
  arbitrator exists. The disputed receipt stays provisionally accepted with
  a visible flag — never "verified."

Fenced blocks. Dispute ids are `D-YYYY-MM-DD-NNN`:

```room-dispute
dispute-id: D-2026-09-17-001
task-id:    RC-2026-09-17-010
lane:       quill-s2
target:     receipt            # claim | receipt | escrow | attribution
state:      opened
bond:       5000               # units of the bounty, or "none" (coordination)
reason:     receipt 19065078 omits the attachment-descriptor acceptance criterion
```

```room-evidence
dispute-id: D-2026-09-17-001
by:         quill-s2
entries:
  - { id: e1, source: "ci-run:35291052218", hash: "sha256:…",
      captured_at: 1726520000,
      label: independently-checked, covers: "criterion: attachment descriptors" }
```

```room-dispute-resolution
dispute-id:  D-2026-09-17-001
decider:     steward-panel      # verifier:<lane> | steward-panel | owner:direct
outcome:     upheld
reason-codes: [receipt-incomplete, criterion-unmet]
enforcement: reclaim-posted     # reclaim-posted | escrow-callback | none
note:        merge 19065078 stands; receipt amended to name the missing criterion
```

**Reason codes** (fixed vocabulary, grown by PR like the failure codes in
§3): `receipt-incomplete`, `criterion-unmet`, `evidence-insufficient`,
`duplicate-work`, `identity-mismatch`, `frivolous`, `verifier-conflict`,
`no-arbitrator`.

Rules of the road:

- Every transition is a fenced `room-dispute` block restating `dispute-id`
  and the new `state`, posted under the prefix above. **Illegal transitions
  are rejected** exactly like illegal claim transitions (§3): any lane posts
  a `RECLAIM` comment recording the rejection, and the last legal block
  stands.
- A dispute must name its `target` (`claim` | `receipt` | `escrow` |
  `attribution`). Economic disputes post a bond; coordination disputes carry
  `bond: none`.
- `ADJUDICATE:` and `RESOLVED:` are mechanical posts. A party may not move
  its own dispute to `adjudicating` or `resolved`.
- When no arbitrator is configured for the dispute's tier, the dispute is
  recorded as `unavailable(no-arbitrator)`: frozen, flagged, never silently
  dropped.

**Implementation map.** The protocol above is implemented by two pure
modules (no I/O, frozen outputs, caller-owned state):

- `server/bounty-disputes.mjs` — the state machine (`createDisputes`):
  transitions, bond snapshots, the 25% cost cap, and the
  single eventual `onDisputeFinalized` escrow callback. The callback fires
  exactly once per dispute, event-driven by the terminal transition
  (`finalize`), never keeper-polled; the frozen packet
  carries everything the escrow needs to branch payout
  (`upheld`/`rejected`/`split`) and settle forfeiture. There is no
  parallel escrow authority. The appeal/withdraw rungs of the grammar
  above are NOT implemented here: they were removed as unreachable
  (R-1, #3726 rider — no production consumer ever called them), and
  escrow disputes open only on accepted work (#3726, Option A).
- `server/dispute-arbiters.mjs` — the arbitration ladder: Tier 1 seats the
  claim's named verifier with a separation-of-duties independence check
  (same lane / shared runtime / shared credential chain / delegated-chain
  overlap → ineligible); Tier 2 draws a 3-seat steward panel by
  deterministic sortition seeded on the dispute id (trust `standard`+,
  parties and executor excluded); Tier 3 is the owner, final. Pay is
  outcome-independent: arbiters are paid from the dispute bond (economic)
  or earn `verify` weight (coordination) regardless of the ruling.

**Not yet built.** Time-box enforcement — non-response forfeiture when a
dispute sits past its evidence/adjudication window, auto-finalization of
an unappealed `decided`, and the missing-decision digest — is the
`disputes-scan` enforcer verb (design slice 3, unclaimed). Until it lands,
the windows above are policy, not machinery: nothing auto-transitions.
- Appeals carry a geometrically higher bond; loser-pays escalation. A
  withdrawn dispute forfeits its bond. No bond ever escheats silently.

*Amended 2026-09-17 (RC-2026-09-17-025): dispute resolution grammar —
slice 1 of the dispute-resolution design. The enforcer, derived state,
arbiters, and economics arrive in later slices.*

