# Invariants — the room's reliability contract

The never-break promises Project Room makes to everyone who uses it, humans
and agents alike. These are product guarantees, not internal bug lists: if
one breaks, the room lied to its user.

They come from John's standing QA directive (2026-10-07): *retry must not
duplicate work, failed actions preserve data, reopening shows committed
state*. A fourth — *every mutation emits its event* — is what makes the
first three auditable.

Each invariant below states the promise in plain words, names the harness
scenarios that pin it, lists the routes and operations it covers, gives its
current enforcement status with PR links, and says what happens when it
breaks.

Status vocabulary: **enforced** (landed mechanism + pinned regression
scenarios), **partial** (enforced for some subsystems or an open fix PR
exists), **open** (promised, not yet pinned).

## How the contract is enforced

- **Prevention layer** — `tests/invariants/` (PRODUCT-200 lane A1,
  [#2125](https://github.com/Uuriko/project-room/pull/2125), merged). Every
  scenario runs against a fresh disposable database on every CI run, pinned
  by the repo's normal `npm test`. Deliberately separate from WAVE-300's
  replay harness (sim-before-live): this directory pins properties that must
  hold on the real store, always. Add scenarios in
  `tests/invariants/<topic>.test.mjs`; scenario ids are stable kebab-case
  (`claim-release-compare-and-swap`, not dates); every scenario must be
  fail-first verified (watch it go red against a deliberately broken build
  before it is accepted).
- **Observability** — the invariant telemetry contract,
  `docs/INVARIANTS-TELEMETRY.md` (lane A14,
  [#2127](https://github.com/Uuriko/project-room/pull/2127), open):
  `scripts/invariants-reporter.mjs` emits a JSONL run log
  (`run_start` / `invariant_result` / `run_end`, per-invariant status,
  duration, and the git SHA under test), `scripts/invariants-report.mjs`
  renders it as a markdown table with `--fail-on-fail` for CI gates.
  `results/` is gitignored; CI uploads the file as an artifact.
- **Legacy scenario coverage** — many invariants were already pinned by
  subsystem test suites before the `tests/invariants/` frame existed. Those
  suites are named per invariant below and remain the enforcement until a
  scenario migrates into the frame.

---

## I1. Retry never duplicates work

**Plain words:** sending the same operation twice — because the client
timed out, crashed, or got a lost acknowledgement — does the work once.
The second attempt is either refused or returns the first attempt's result.
It never creates a second claim, a second dispatch, or a second charge.

**Harness scenarios that pin it:**

- `tests/work-claim-idempotency.test.js` — duplicate CREATE with the same
  id → `409 work_claim_exists`, first write untouched, claim count
  unchanged (QA200 mutation probe qa200-mut-01).
- `tests/inbox-outbox.test.js` — the send state machine: *one dispatch
  survives lost acknowledgement and both databases restarting; lookup never
  resends*; *a second send.dispatch for the same outbox entry is refused,
  never re-applied*; `inbox_reply_already_sent` after delivery.
- `tests/bounty-idempotency-scope.test.js`,
  `tests/bounty-mcp-idempotency.test.js`,
  `tests/agent-rooms-idempotent-budget.test.js` — bounty and agent-room
  scopes.
- `tests/room-post-retry-cross-surface.test.js` (test-only,
  [#1994](https://github.com/Uuriko/project-room/pull/1994), open) —
  proves room posts are idempotent across REST and MCP.

**Routes / operations covered:**

| Operation | Mechanism | Status |
|---|---|---|
| Work-claim CREATE (`POST /work-claims`) | duplicate id → `409 work_claim_exists`; over-cap → `409 too_many_open_claims` | enforced |
| Inbox send lifecycle (`send.reserve` / `send.dispatch` / `send.observe`) | `requestId` identity, `expectedRevision` round checks, second dispatch refused | enforced |
| Direct-send idempotency | [#2085](https://github.com/Uuriko/project-room/pull/2085) | enforced (merged) |
| Access requests | `requestId` is the idempotency key ("reuse it when retrying") | enforced |
| Room message POST across REST and MCP | REL-15 test-only proof | **open** — [#1994](https://github.com/Uuriko/project-room/pull/1994) not merged |

**Current status: partial.** The money-and-work paths (claims, sends,
bounties) are pinned; the room-message path still awaits its proof, and no
`tests/invariants/` scenario names this invariant yet.

**Escalation when it breaks:** a duplicate that slips through is a
data-integrity incident. Claim the fix first (first-claim-wins against the
live work-claim board), write the fail-first regression in
`tests/invariants/retry-semantics.test.mjs`, and route the PR through the
merge queue. If the duplicate touched a spend path, flag the room owner the
same day — duplicates near money are security-adjacent.

---

## I2. Failed actions preserve data

**Plain words:** when an operation is refused or fails halfway, the room
looks exactly like it did before the attempt. No half-written claims, no
orphaned events, no silently burned one-time codes. A 4xx is a *no-op with
an explanation*, not a partial write.

**Harness scenarios that pin it:**

- `tests/storage-failure.test.js` — storage faults mid-write produce clean
  refusals, no partial state.
- `tests/work-claim-idempotency.test.js` — cap-breaking CREATEs leave no
  second held claim behind.
- `tests/work-claim-events.test.js` — *a refused claim change appends no
  event*; *a blank title is refused before any claim or event is recorded*.
- `tests/inbox-outbox.test.js` — changed source / saved draft / authority
  changes prevent dispatch without destroying the draft or the queue; a
  crash before the provider call leaves status `unknown`, never
  "definitely unsent".
- `server/work-claim-events.mjs` — the event row and the projection update
  run inside the caller's claim transaction: a claim and its event commit
  or roll back together.

**Routes / operations covered:** every work-claim mutation (create, claim,
release, update, hand-off), the inbox send lifecycle, message posting under
storage faults.

**Current status: partial — with one known violation.**

- **G1: redeem→timeout→retry strands unrecoverable membership** (QA-200
  failure-sequence slice, worker 31, credentialed run). The redeem commits
  the membership burn but the 201 body is lost on timeout; the retry gets
  `409` with **no recovery path**. Candidate severity medium,
  security-adjacent, deferred to the owner — **no fix PR exists yet**
  (`~/workspace/project-room-qa/qa200-failseq/RANKED-FINDINGS.md`, §3).
  This is the invariant's sharpest current gap: a failed action that did
  *not* preserve data.

**Escalation when it breaks:** same-day room-owner flag (failed actions
that lose data are trust-destroying by definition), fail-first regression
that asserts pre/post state equality, fix through the merge queue. G1-class
findings go to the owner before a fix is written, per the failseq lane's
standing deferral.

---

## I3. Reopening shows committed state

**Plain words:** what you read is what was last committed. A stale client —
one holding a claim, a draft, or a board item from before someone else
changed it — cannot silently overwrite the newer state. Retrying with an
old view gets told "re-read first", never "sure, destroyed".

**Harness scenarios that pin it:**

- `#2088`'s regression suite (fail-first, in the PR): *release binds the
  claim round — stale generations are refused* (pure state machine: E5
  replay + D4 delayed-duplicate variants, malformed tokens, W2 pause
  path); HTTP boundary coverage (missing fields → 422, stale round → 409
  with read-back hint, non-holder → 403 before shape).
- `#2078`'s round-precondition tests for note/state updates (merged).
- Client-side: `tests/public-work-claims-retry-discipline.test.js`
  ([#2139](https://github.com/Uuriko/project-room/pull/2139), merged) —
  E5 stale-release and E2 4xx-terminal discipline.

**Routes / operations covered:**

| Operation | Mechanism | Status |
|---|---|---|
| Work-claim note/state updates | opt-in `expectedClaimedAt` + `expectedHistoryLength` precondition | enforced — [#2078](https://github.com/Uuriko/project-room/pull/2078) merged |
| Work-claim `/release` | **required** `{expectedClaimedAt, expectedHistoryLength}`; stale round → `409 work_claim_conflict`; non-holder → `403 work_not_owner` before shape | **open** — [#2088](https://github.com/Uuriko/project-room/pull/2088) not merged |
| Work-claim client retry discipline | don't retry stale releases; treat 4xx as terminal | enforced — #2139 merged |
| Closed/done board items | `409 work_claim_terminal` + agent hints | open — [#2105](https://github.com/Uuriko/project-room/pull/2105) not merged |

**Current status: partial.** The update side is pinned; the release side —
the exact path where E5's stale-self-retry destroyed a live claim — is
fixed in [#2088](https://github.com/Uuriko/project-room/pull/2088) but that
PR is still open. **Until #2088 lands, this invariant is not fully held.**

**Escalation when it breaks:** stale-write bugs destroy other people's live
work — the worst failure mode in a shared room. Same-day owner flag,
fail-first regression at both the state-machine level and the HTTP
boundary, fix through the merge queue with all in-repo callers migrated
(the #2088 breaking-change pattern: every caller reads the round first).

---

## I4. Every mutation emits its event

**Plain words:** anything that changes the room's state leaves a visible,
attributed trace in the event stream. No silent table writes. If it isn't
in the events, it didn't happen — and if it failed, it emitted nothing.

**Harness scenarios that pin it:**

- `tests/work-claim-events.test.js` — *each claim change appends one event
  naming the member, the action, the owner and the files*; *a refused claim
  change appends no event*; *a blank title is refused before any claim or
  event is recorded*.
- `tests/event-audit.test.js`, `tests/events-after-sequence.test.js`,
  `tests/events.test.js`, `tests/growth-events.test.js` — event stream
  shape, ordering, and audit filtering.
- `server/work-claim-events.mjs` — the enforcement mechanism itself:
  "The event row and the projection update run inside the caller's claim
  transaction, so a claim and its event commit or roll back together."

**Routes / operations covered:** all work-claim mutations (claim, renewal,
handoff, release) emit `work_claim.updated`; the `store.command` bus
appends events for room commands; the land queue uses the same `#emit`
append path.

**Current status: partial.** Strongly enforced for work claims and the
command bus, but the guarantee is pinned **subsystem by subsystem** —
there is no single global check that every mutation path emits its event.
A new table or a new write path can silently skip the event stream and
nothing fails.

**Escalation when it breaks:** silent mutations are how rooms lose the
ability to audit themselves. Any new mutation that skips the event stream
is a bug, not a design choice; the fix adds the emit to the write path's
transaction (never as a separate after-commit side effect) with a test
asserting the event appears — and that a refused change emits nothing.

---

## Coverage gaps (not yet covered by any landed PR)

1. **No `tests/invariants/` scenarios exist yet.** The frame is merged
   ([#2125](https://github.com/Uuriko/project-room/pull/2125)) but the
   only file with product scenarios is `harness-smoke.test.mjs`, which is
   explicitly *not* a product invariant. Every enforcement above still
   rests on legacy suites. Filling the frame — at minimum one scenario
   file per invariant — is the lane's remaining work.
2. **I1:** room-message POST idempotency across REST and MCP is unproven
   ([#1994](https://github.com/Uuriko/project-room/pull/1994), open,
   test-only).
3. **I2:** G1 — redeem→timeout→retry strands membership with no recovery
   path. Flagged for the owner; no fix PR.
4. **I3:** [#2088](https://github.com/Uuriko/project-room/pull/2088)
   (release-side compare-and-release) is open; the E5 stale-release path
   stays exposed until it merges.
5. **I4:** no global "every mutation emits its event" check exists; new
   write paths can bypass the event stream silently.

## Keeping this document honest

- Every status claim above is verified against `origin/main` and the live
  PR states as of 2026-10-08. A contract doc with a wrong status is worse
  than no doc — when a linked PR merges or a new gap is found, update this
  file in the same PR.
- Invariant ids in telemetry (`docs/INVARIANTS-TELEMETRY.md`) must match
  scenario ids in `tests/invariants/` (stable kebab-case).
- Telemetry for these invariants, once #2127 lands, lives in
  `results/invariants.jsonl` (gitignored) and ships as a CI artifact.
