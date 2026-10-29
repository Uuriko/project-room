# Instruction pack — Planned typed object: Lease (Primitive 5)

## 1. The piece

**Status: PLANNED, phase PAUSED — executable-at-unpause.** This pack
commissions the in-product **Lease** object from the redesign
typed-object family (Claim / Record / Verdict / Lease / Ruling). The
redesign typed-object phase is PAUSED (FOCUS-REVIEW; MEMORY.md:
redesign Phases 1+ paused). Nothing here is to be built, filed as a PR,
or landed until Jill records an explicit unpause of the typed-object
phase AND the dependency gate in §4 step 0 is met. Written so an
implementer can start within one hour of that unpause.

Target tree: a tree based on main
`aaa749065a6451321a949ddcb923f3174504fe35` **or its successor at
unpause** (re-verify the SHA then; every file claim below was verified
against `aaa749065a`, read by `git archive` into this lane's scratch,
deleted after filing). Production runs build `ca37fee4`; production is
never the target and is never written to.

### Disambiguation — read first; this is the pack's central trap

"Lease" names at least eight different things in this system. **This
pack covers exactly one: item (1).** Building or confusing any other
fails acceptance.

1. **Lease (Primitive 5) — THIS PACK.** A planned room object:
   `Lease { id, claimId, recordId, pr, headSha, holderSeat,
   destinationSeat, grantedBySeat, grantedAt, expiresAt, heartbeatAt,
   state }`, issued only against a `land-ready` Record plus the Claim
   covering the landing work, binding claim + record + exact head
   (recovered spec, `~/workspace/migration-2026-10-21/mig-primitives-recovered.md`,
   §"Primitive 5 — Lease"). **Does not exist at `aaa749065a`** —
   verified: no Lease object, no `lease.*` event type in
   `src/events.js`, no `/leases` route in `server/routes/table.mjs`.
2. **`room/release-lease` — the release lease.** A GitHub **commit
   status**, branch protection's only required context on `main`; not
   a job in any workflow (`docs/RELEASE-MERGE-GATE.md` at main:
   "`room/release-lease` is a commit status from the landing
   coordinator"). Posted only by the reviewed #4115 coordinator run
   by the Codex release seat from John's Mac. Covered by sibling pack
   `packs/deploy-release-lease.md`, **not this one**. **Untouched:**
   this pack's object does NOT post, mint, request, proxy, or treat as
   authority that status. The recovered spec imagined a later bridge
   ("the GitHub check posts the lease's state"); that bridge is a
   separate, later, seat-owned charter, out of scope here. Never run
   the #4115 installer; never mutate branch protection.
3. **The #4115 / `land.mjs` MERGE-SLOT grant.** An exact-JSON one-time
   landing authorisation (`claim-id: land-<ISO8601>-<rand>`, `fleet:`,
   explicit window) minted inside one coordinator process on one
   machine, revoked on land, invisible to the room. The Lease object
   makes this grant's existence, holder, head-binding and expiry
   visible and enumerable; it does **not** replace the grant or
   democratise minting: "only the reviewed coordinator seat mints —
   the room object makes the grant visible and checkable, it does
   not democratize minting" (recovered spec).
4. **Board `MERGE-SLOT` claim.** A work-claim on the muse-room Board
   claimed/read/released around a merge (`docs/ROOM-COORDINATION.md`
   §"Land and deploy"). Retired **as the mutex of record** only when
   Lease lands (SYNTHESIS §3 build order); until then it works
   unchanged.
5. **`server/merge-queue.mjs` slot lease.** An in-process merge-slot
   queue: 15-minute slot lease (`DEFAULT_SLOT_LEASE_MS`), heartbeat /
   adopt / release / sweep, `tests/merge-queue.test.js`. Its HTTP
   handler is **NOT MOUNTED** — `server/http.mjs` never routes to it,
   so its paths 404 in production (file header, verified at main).
   **Not a shortcut:** do not mount, extend, or present it as Lease.
6. **Work-claim lease.** Fields `claimedAt` + `leaseExpiresAt` on a
   work-claim item: `server/work-claims.mjs` (default 24 h, cap
   168 h), routes `…/work-claims/{claimId}/claim|renew|release`,
   board-v2 grammar `lease=<N>h` 1–72 h (`server/claim-validate.mjs`).
   Already live. Lease (1) is not a work-claim, carries no
   `lease=<N>h` grammar, and must not be built by extending
   work-claims. Bound PRs touching that lease (#3556 claim fencing,
   #4002 lease-never-lapses-in-review, #3734 lapsed-lease projection,
   in the bindings file) are work-claim work — do not duplicate them.
7. **Listener / wake / reserve leases.** `server/agent-heartbeats.mjs`:
   listener lease, 60 s TTL (`WAKE_LISTENER_LEASE_TTL_MS = 60000`),
   fencing token, one live lease per (agent, room); plus
   `server/wake-queue.mjs` and reserve leases in
   `server/spend-grants.mjs`. Unrelated; their fencing/expiry patterns
   are exemplars (§3), their code is untouched.
8. **CLAIM-LEASE-1.** A different planned piece (E11 Import 2,
   SYNTHESIS Phase 4, after #4496): server-enforced leases **on the
   Claim object itself** — `claim { workId, holder, epoch, expiresAt }`,
   heartbeat extension, fencing epoch, presence as by-product; 8–12 lh,
   separate charter. Primitive 5 Lease leases a *landing*;
   CLAIM-LEASE-1 leases a *claim*. If the unpause charter names
   CLAIM-LEASE-1, stop — wrong pack.

Also not this piece: SEAT-DELEGATE-1's per-batch leases and Option C's
policy-minted lease events (SYNTHESIS D-2; e15 §4.2). Automated/policy
minting changes who may mint — **John's reserved gate** (second-minter
/ lease integrity). This pack keeps the mint singular and
coordinator-issued; an implementer who believes policy minting is
required **stops at that fork** and reports it as John's needed
action, building neither branch. Neither of John's pending design
forks (verified-delivery vocabulary; sponsor human surface) is
touched by this piece.

### Where it lives — design of record and surfaces to create

Design sources, in authority order: (a) SYNTHESIS
(`~/workspace/pr-redesign-2026-10-23/SYNTHESIS.md`) D-1 — the typed
objects are "the one typed event family"; §3 build order "Record →
Verdict → Queue view → Lease/Obligation → Approval"; §2 C-7 and §3
Phase 4 place CLAIM-LEASE-1 separately, after #4496; (b) the
recovered Primitive 5 spec (`mig-primitives-recovered.md`) — fields,
states, one-live-per-PR, singular mint, wrong-seat decline;
(c) E11 Import 3 (EVENT-LEDGER-1) — Claim/Record/Verdict/Lease
transitions as one typed event family, every view a projection;
(d) E15 §2.1/§2.3 — Lease is Primitive 5 of eight, priced 5–8 lh,
"makes the grant visible, enumerable, head-bound, and
wrong-seat-declined mechanically"; (e) E3 §5/§7 — migration order
M1 land Claim #4496 + Record #4551, then Verdict, Queue view, Lease.

Verified present at `aaa749065a` (the substrate Lease must follow):
`src/events.js` — `EVENT_TYPES` already carries `claim.acquired` /
`claim.released` / `claim.renewed`, `land.updated`,
`work_claim.updated`, with projection handlers per type — the exact
pattern Lease events follow; `server/agent-webhook-subscriptions.mjs`
— `EVENT_CATALOG` derives from `EVENT_TYPES`, so new event types grow
the catalog (registration consequence, §5); `server/work-claims.mjs` +
`server/work-claim-sqlite.mjs` + `server/work-claim-routes.mjs` — the
in-product precedent for a board object whose store is the source of
truth and whose `work_claim.updated` events are receipts;
`server/routes/table.mjs`, `docs/openapi.yaml` +
`server/openapi/fragments/`, `skills/project-room/references/errors-catalog.md`
— the route/error surfaces §4 step 5 registers into.

**Surfaces to create (none exist yet):** a new server module
`server/leases.mjs` (state machine, pure where merge-queue.mjs is
pure) plus `server/routes/leases.mjs`; new event types in
`src/events.js`; routes under `/api/rooms/{roomId}/leases…`; Lease
rendering inside the Queue view (the view built by the preceding
phase — Lease creates no client surface of its own). No MCP tool in
v1 (route-parity `exempt:` note, §5). Vanilla JS only; no client
rebuild.

### The object, as specified (recovered spec + this pack's resolutions)

`Lease { id, claimId, recordId, pr, headSha, baseSha, generation,
holderSeat, destinationSeat, grantedBySeat, grantedAt, expiresAt,
heartbeatAt, state, attempts[], landedMergedSha?, endReason? }`

- Fields from the recovered spec verbatim: `id, claimId, recordId,
  pr, headSha, holderSeat, destinationSeat, grantedBySeat,
  grantedAt, expiresAt, heartbeatAt, state`.
- Pack-specified additions (flagged as such, not recovered):
  `baseSha` and `generation` (monotonic per PR, starting 1) — the
  #4115 grant contract already binds head + base + a lease
  generation (see `packs/deploy-release-lease.md` §1); `attempts[]`
  and the terminal bookkeeping fields below.
- `state ∈ { granted, landed, revoked, expired, declined }`
  (recovered). Pack resolution of the recovered spec's one ambiguity:
  `declined` is terminal **only** when the *destination seat itself*
  declines the grant. A landing **attempt by any other seat** is a
  refused attempt — recorded in `attempts[]` with seat, time, and
  refusal code, lease stays `granted` — never a state change and
  never silent: "wrong-seat decline … is a first-class outcome, not
  an error" (recovered spec).
- TTL: granted with an explicit `expiresAt`; server bounds the window
  to 5 minutes – 4 hours, default 45 minutes (the fleet claim-window
  convention). Heartbeat (holder or destination seat only) sets
  `heartbeatAt` and extends `expiresAt` to `now + granted window`,
  never past a superseded Record.
- Events (E15 Option-C naming, D-1 event discipline): `lease.granted`,
  `lease.renewed` (heartbeat), `lease.landed`, `lease.revoked`,
  `lease.expired`, `lease.declined`, `lease.attempt_declined`.
  Terminal leases leave the live projection; their events stay in
  the room's append-only log as the audit trail.

## 2. Current state

Executed evidence, cited — not re-derived:

1. **The object does not exist; its job is done by invisible
   machinery.** Fresh check by this lane at `aaa749065a` (git-archive
   tree, greps in §1): no Lease type, event, route, or table. The
   recovered spec's "job today" still describes reality exactly:
   78 leading `MERGE-SLOT` comments on #3299 (enumerated at recovery
   time), or a `land.mjs` grant with `claim-id` / `fleet:` / window;
   "nothing in the room knows a lease exists: the room's only trace
   is the `room/release-lease` branch-protection context"
   (`mig-primitives-recovered.md`, Primitive 5, "Job today").
2. **The dependencies are not landed either — this is why the gate
   in §4 step 0 exists.** Verified by this lane via `gh pr view`:
   #4496 (Claim primitive, head `67c128129816a5a97fe7fa6bfba754c4be9fba37`)
   and #4551 (Record primitive, head `41ee77151f00763fe34e42d3f2fa0f4de730d4f3`)
   are both **CLOSED, `mergedAt: null`** (closed 2026-10-25, the
   cleanup), and neither appears in the bindings file
   (`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`,
   checked by this lane: no `prs` entry for either). SYNTHESIS (Oct
   23) described them as "built and sitting unlanded"; that is no
   longer their state — any unpause plan that assumes they merely
   need landing is stale. Verdict and Queue view, which precede
   Lease in the build order, are likewise unbuilt at main
   (UNVERIFIED in detail: this lane verified Claim/Record's PR
   states, not a full-tree search for Verdict/Queue-view successors;
   §4 step 0 makes that check the implementer's first act).
3. **The seat bottleneck the object attacks is measured, current.**
   Settle pass 21 close (`~/workspace/wave-2026-10-27-settle-pass-21/SYNTHESIS.md`):
   259 bound records / 246 OPEN at bound heads, and "seat cadence,
   not fleet readiness, is the constraint." E15 §2.2 (P1) grades the
   honest ceiling: Lease removes the *knowledge* bottleneck (anyone
   can read queue, holds, lease state), **not** the execution
   bottleneck — the seat on one Mac remains. A pack or PR claiming
   Lease "fixes the seat bottleneck" overclaims and fails §5.
4. **The failure classes are named specimens, not theory.** (i)
   Prose mutex: a seat that misreads its instructions can attempt a
   land nothing mechanically declines (recovered spec, "If it stays
   outside"). (ii) Dead-holder invisibility: E5's specimen — a
   retired seat "still holds four work claims it cannot release …
   a dead seat is indistinguishable from a quiet one." (iii)
   Head-move drift: today the landing-watch cron detects a moved
   head by polling; the bindings file "drifts from GitHub between
   cron runs" (E3 §6, S7: the 2026-10-23 01:10 landing-watch run
   failed on both attempts and the file still *looked* current).
5. **Adjacent lease machinery at main is healthy — and is the
   reason confusion is likely.** `server/merge-queue.mjs` is a
   complete, tested slot-lease state machine that is deliberately
   unmounted; work-claim leases carry live bound cures (§1 item 6);
   the listener lease already implements fencing in production.
   Nothing in this item is broken; it is evidence that "lease"
   without a qualifier is an ambiguous instruction in this repo.
6. **Storage is a live constraint on any room object.** MEMORY.md
   gauge 2026-10-28: largest room 1,433,781 B and growing ~303 KB/day
   toward the 4 MiB per-room projection cap. E15 §2.6 warned the
   redesign "makes the storage cliff load-bearing." §4 therefore
   forbids terminal-Lease accumulation in the live projection.

## 3. What fantastic means

Any room member — human or agent — answers "who may land what, right
now?" from **one read**, and the answer is mechanically enforced, not
etiquette. Concretely:

- **One read, complete answer.** `GET /api/rooms/{roomId}/leases`
  returns every live Lease in the room: PR, exact head + base,
  generation, holder, destination seat, granter, expiry, last
  heartbeat. Zero prose parsing, zero #3299 archaeology, zero
  bindings-file cross-checks. On a fixture room carrying the
  settle-pass-21-scale population (130 watched PRs), that read is
  **p95 ≤ 500 ms** locally and the serialised live projection is
  **≤ 64 KB** (one live Lease per PR, terminal Leases projected out).
- **Exclusivity is a theorem, not a hope.** Two grants raced for the
  same PR resolve to **exactly 1** live Lease, 100% of the time,
  including under concurrent writers (the store's synchronous
  `BEGIN IMMEDIATE` discipline the claim race already proved:
  "SERIALISED-BY-CONSTRUCTION", MEMORY.md money-core verdicts).
  A second grant for a PR with a live Lease is refused naming the
  live Lease's id, holder, and expiry — never queued silently.
- **Wrong seats are declined mechanically, 100%, on the record.**
  Every exercise/land/heartbeat/revoke attempt by a seat that is
  neither holder, destination, nor granter is refused AND appears
  in `attempts[]` on the next read. Count of unrecorded wrong-seat
  attempts in the acceptance suite: **0**.
- **Expiry and head-binding need no cron and no human noticing.**
  A Lease whose `expiresAt` passes reads `expired` on the **next
  read** (evaluation on read, the work-claim precedent — expiry
  correct within one read, no sweeper dependence). A Lease whose
  Record reads `superseded` (head moved) reads `revoked` on the
  next read after that transition, with `endReason: record_superseded`.
  A Lease can never be exercised against a head other than
  `headSha`: exercise presenting any other head is declined 100%
  of the time in tests.
- **Landing closes the loop in one transition.** Exercising a Lease
  to `landed` simultaneously moves its bound Record to `landed`
  (recovered spec) and frees the PR for a future generation — a
  re-grant after any terminal state carries `generation + 1`, so a
  stale holder's paperwork is distinguishable at a glance.
- **The mint stays singular and legible.** Exactly one granter
  configuration per room (§4 step 3); with it unset, grants fail
  closed — **0** Leases can be created. Fantastic explicitly does
  **not** include: faster seat execution, automated minting, or
  any change to `room/release-lease` (§1 items 2–3).
- Exemplars worth matching: `server/work-claims.mjs` — lease expiry
  evaluated on every request, claims without a lease behaving
  exactly as before, plain-language refusal messages naming the
  real recovery ("claim it again"); `server/agent-heartbeats.mjs`
  listener lease — fencing token checked inside the same
  transaction as the mutation it fences; `server/merge-queue.mjs`
  — a pure state machine with an injected clock, which is why its
  tests are deterministic. Lease's own tests must read the same way.

## 4. The instruction

Budget of record: **5–8 lane-hours** (recovered spec / E15 envelope)
for the object + verbs + head-binding + Queue-view rendering. If the
work outgrows that envelope, stop and re-price to Jill rather than
quietly expanding scope. This is a **schema-class, freeze-adjacent**
build (new event types + new projection): it lands **singly, green
at exact head**, under the Phase-2 freeze ceremony once unpaused —
never batched, never as a small-change-tier ride-along.

**Step 0 — Unpause + dependency gate (stop conditions, all must pass).**
- Confirm on the record: (a) Jill has explicitly unpaused the
  redesign typed-object phase (FOCUS-REVIEW pause lifted for this
  phase — silence is NO ANSWER, never assent); (b) John's Phase-2
  freeze go for the chain is on record (SYNTHESIS §6 item 1 pattern).
- Re-verify at the then-current main (do not trust this pack's
  Oct-28 reads): Record is landed (a successor of #4551 — the
  original is CLOSED-unmerged, §2.2), Claim is landed (successor of
  #4496, likewise), Verdict is built and its `accepted` state is the
  satisfying state, and the Queue view exists to render Lease into.
  For each: name the landed PR + head in the build's STATE.md.
- **If any dependency is missing: STOP.** Report
  `BLOCKED-dependency <which>` — do not build Lease against prose
  records, mock Records, or the work-claim board as a substitute
  substrate. Building Lease first inverts the decided order
  (SYNTHESIS D-10) and is the exact never-connected failure class
  the methods audit kept finding.
- Check the bindings file at unpause for any PR whose note names
  this Lease piece; instruct only what remains after it. At filing
  (2026-10-28) there is none — the bindings entries mentioning
  "lease" are work-claim PRs (§1 item 6), which are not this piece.

**Step 1 — State machine first, pure, failing-first.**
New `server/leases.mjs`: no I/O, injectable clock (merge-queue.mjs
precedent). Transitions: `grant`, `heartbeat`, `exercise→landed`,
`revoke`, `decline` (destination only), plus read-time evaluation of
`expired` and of `revoked`-on-Record-superseded. Enforce in the
machine, not in route code: triple binding (claimId + recordId +
headSha must match the Record read at grant time); Record state
must be `land-ready` with an `accepted` Verdict; one live Lease per
PR; TTL bounds 5 min – 4 h (default 45 min); generation increments
per PR across terminal states. Write `tests/leases.test.js` against
the machine first: every §5 check 1 case starts as a failing test
here before any route exists.

**Step 2 — Events + projection in the room store.**
Add the seven `lease.*` types (§1) to `EVENT_TYPES` in
`src/events.js` with projection handlers following the
`claim.acquired/renewed/released` handlers: live Leases project
into room state; **terminal Leases are removed from the live
projection in the same transition** (their events remain the audit
trail — §2.6 storage discipline; a projection that accumulates
terminal Leases fails §5 check 4). Where the then-landed Record /
Claim objects keep their source of truth in a side store (the
work-claim-sqlite precedent), mirror that choice instead of the
event projection — one choice, stated in the PR body, applied
consistently; do not invent a third store shape.

**Step 3 — Granter authority, fail-closed.**
Granting requires the caller seat to be the room's configured
lease granter: a room-policy field naming one seat id, settable
only by the room owner, **unset by default**, plus the room owner
as fallback granter of record. Any other caller → refusal
`lease_grant_forbidden`. Revoke: granter or holder. Heartbeat:
holder or destination seat. Exercise (`landed` transition):
destination seat only — every other seat gets the recorded
wrong-seat decline (§1). Guests are excluded from all Lease verbs
and reads beyond the live list's existence (follow the work-claim
guest rule). No new identity, no new credential, no token of any
kind is created by this piece.

**Step 4 — Routes.**
`server/routes/leases.mjs` + rows in `server/routes/table.mjs`:
`POST /api/rooms/{roomId}/leases` (grant),
`GET /api/rooms/{roomId}/leases` (live list),
`GET /api/rooms/{roomId}/leases/{leaseId}`,
`POST /api/rooms/{roomId}/leases/{leaseId}/heartbeat`,
`POST /api/rooms/{roomId}/leases/{leaseId}/land` (exercise),
`POST /api/rooms/{roomId}/leases/{leaseId}/revoke`,
`POST /api/rooms/{roomId}/leases/{leaseId}/decline`.
All reads evaluate expiry/superseded-revocation before answering
(work-claim-routes precedent: "lease expiry is evaluated on every
request"). Mutations and their fencing checks run inside one
store transaction (listener-lease precedent). Error codes
(step 5): `lease_conflict` (409, names live Lease), `lease_wrong_seat`
(403, recorded), `lease_head_mismatch` (409), `lease_expired` (409),
`lease_not_land_ready` (409), `lease_grant_forbidden` (403),
`lease_not_found` (404). Refusal messages name the real recovery,
in the work-claims voice.

**Step 5 — Registrations, in the same diff** (detail in §5):
OpenAPI fragments + `docs/openapi.yaml` operation for every route
with parity note `exempt:landing-coordination, seat tooling only —
no MCP tool in v1`; error-catalogue rows in both copies via
`node scripts/skills-sync.mjs`; runtime-package closure entries
for the new server modules; MCP catalog snapshot regeneration for
the `EVENT_CATALOG` growth (§5) — regenerated by its generator,
never hand-edited.

**Step 6 — Queue-view rendering + docs, same PR.**
The Queue view (dependency, step 0) renders, per land-ready entry:
live Lease state, holder, destination, expiry countdown, and a
visibly-orphaned marker when the holder's Presence reads `gone`
(Queue spec, recovered tail). Vanilla JS, existing tokens only.
Docs in the same diff: `docs/ROOM-COORDINATION.md` §"Land and
deploy" gains one paragraph stating Lease is now the mutex of
record, the Board MERGE-SLOT claim is retired for that purpose,
and `room/release-lease` is unchanged and still coordinator-posted;
the naming table in §1 of this pack is copied into that paragraph's
first version so the disambiguation survives this pack.

**Step 7 — Landing discipline for this PR itself.**
Single PR, `ready-to-land` added once with a user/App token (never
`GITHUB_TOKEN`), full green generation at the exact head (this PR
is above the Ruling-41 line — freeze-adjacent schema class — so
tree-SHA inheritance does **not** apply to it), pre-act journal
entry before any consequential act, fix lane never merges: the
landing seat lands it, and post-land the seat — not this lane —
confirms the first real Lease grant in muse-room against a
land-ready Record.

**Explicit non-goals:** posting or bridging to `room/release-lease`;
running the #4115 installer or mutating branch protection; policy /
automated minting or any second minter (John's gate, §1); mounting
or modifying `server/merge-queue.mjs`; extending work-claim leases,
listener leases, or CLAIM-LEASE-1 scope; an MCP Lease tool; a new
client surface beyond Queue-view rendering; retiring the bindings
file or #3299 (EVENT-LEDGER-1's job, gated on a parity cycle);
touching Obligation or Approval (later in the same build order,
separate packs).

## 5. Acceptance

Jill/the coordinator accepts from this section alone. All checks are
executed and quoted, not summarised; identifiers (PR, heads, run
ids) are read at the source (verify-at-source; summary-count rule).

1. **State-machine suite (`tests/leases.test.js`, by name, green):**
   (a) grant against a non-`land-ready` Record refused
   `lease_not_land_ready`; (b) grant without an `accepted` Verdict
   refused; (c) two raced grants for one PR → exactly one live
   Lease, loser refused `lease_conflict` naming the winner;
   (d) heartbeat by holder extends, by a third seat refused and
   recorded; (e) past `expiresAt`, next read shows `expired` with
   no sweeper run; (f) Record→`superseded` makes the Lease read
   `revoked`/`record_superseded`; (g) exercise by holder and by
   granter (non-destination seats) → `lease_wrong_seat`, attempt
   recorded, state still `granted`; (h) exercise by destination
   with a wrong head → `lease_head_mismatch`, recorded; (i)
   exercise by destination with the bound head → `landed`, Record
   simultaneously `landed`; (j) re-grant after each terminal state
   → `generation` incremented; (k) granter unset → every grant
   `lease_grant_forbidden` (fail-closed); (l) destination decline
   → terminal `declined`.
2. **HTTP + store suites, green by name:** the new route tests;
   `tests/events.test.js` and the events-kernel property suite
   (replay of a `lease.*` stream reproduces the live projection
   exactly — EVENT-LEDGER discipline); the webhook-subscription
   suite (`tests/agent-plugin-webhook-subs.test.js`) proving the
   grown `EVENT_CATALOG` validates; regression suites untouched in
   behaviour: `tests/merge-queue.test.js`, the work-claim board
   suites, `tests/agent-heartbeats` listener-lease cases.
3. **Numbers from §3, executed on a fixture:** live-list read
   p95 ≤ 500 ms at a 130-PR fixture population; serialised live
   projection ≤ 64 KB with 130 terminal Leases in history (proves
   terminal projection-out); wrong-seat and head-mismatch declines
   100% across suite cases (a)–(l).
4. **Storage check:** room projection size measured before/after a
   grant→land→re-grant cycle on the fixture room: net live-
   projection growth ≤ one live Lease's serialised size (≤ 1 KB).
5. **Hosted evidence:** one full labelled generation at the exact
   head, all substantive jobs success (designed skips named:
   coverage / quarantined-tests / full); `npm run verify:affected`
   plus `CI=1 npm run check` (the diff touches `server/**` and
   `src/**`); registration sweep (below) exits 0, no MISSING.
6. **Negative-space greps, output attached to the PR:** no new
   writer of the `room/release-lease` status (search for the
   context string + status-posting calls outside docs/tests/
   protection tooling — expected: none added); no changes under
   `.github/workflows/` or to branch-protection tooling; no diff
   in `server/merge-queue.mjs`, `server/work-claims.mjs`,
   `server/agent-heartbeats.mjs`.
7. **Post-land (seat-executed, Jill-verified):** first production
   Lease granted against a real land-ready Record in muse-room,
   read back by a second seat from the live list (two agreeing
   reads or one API read with method named); its landing, expiry,
   or revocation observed in the Queue view; Board MERGE-SLOT
   mutex retirement announced in the room in the same act.

**Registration sweep (pre-flight, per `~/AGENTS.md` — run
`node ~/workspace/fleet-tools/registration-sweep.mjs --pr <n>`,
must exit 0):**

- Runtime-package closure — **APPLIES:** `server/leases.mjs` and
  `server/routes/leases.mjs` go into `scripts/runtime-package.mjs`'s
  allowlist including full import closure AND
  `scripts/candidate-runtime-fixture.mjs`'s path list; verified by
  the closure test, never by eye.
- Error-code catalogue, both copies — **APPLIES:** the seven codes
  in §4 step 4 each get a row in
  `skills/project-room/references/errors-catalog.md`, then
  `node scripts/skills-sync.mjs`; the `plugins/` mirror must be
  byte-identical (skills-sync check output quoted).
- Route triple — **APPLIES:** every §4 step 4 route gets a
  `server/routes/table.mjs` row (plus legacy-allowlist treatment if
  the unpause tree still routes it on the legacy chain), a
  `docs/openapi.yaml` operation with a bare-path quickstart
  example, a well-formed `x-room-permission` marker on each
  mutating operation, and the parity note
  `exempt:landing-coordination, seat tooling only` on every row.
- Harness copy sets — **APPLIES conditionally:** if any test
  harness copies/transforms `src/events.js` or the new modules,
  wire them into that harness's copy/re-point set and say so in
  the PR body; if none does, state that check by name.
- Store registries — **APPLIES conditionally on the §4 step 2
  choice:** a new side table (if the side-store precedent is
  followed) requires writer-fence + purge-registry +
  recovery-audit registration, with the additive sidecar
  partitioning in `verifySchema`; event-projection-only storage
  is n/a *for tables* — one word why: no new table.
- Generated / mirrored artifacts — **APPLIES, two named growths:**
  (i) `EVENT_TYPES` growth re-sizes `EVENT_CATALOG` +
  `webhook_subscribe`'s inputSchema → regenerate
  `tests/fixtures/mcp-catalog.snapshot.json` with its generator in
  the same diff; (ii) MCP catalog growth, if the snapshot moves
  the counts, also moves the COUNT PINS
  `tests/mcp-search-actions.test.js` +
  `tests/mcp-untrusted-content.test.js` — run both **by name**
  (`verify:affected` does not select them).
- Diff hygiene — **APPLIES:** expected >300 changed lines (object +
  events + routes + registrations) → the PR body carries
  `## Large diff justification:` at filing.
- Refusal-shape step — **APPLIES:** §4 introduces new refusal
  codes/shapes; grep the test tree at head for pins on the
  neighbouring old shapes (work-claim `claim_lease_lapsed`,
  merge-queue codes) and report them as REQUIRED-review evidence
  in the PR body; exit contract unchanged.

## 6. Routing

- **Implementer: Codex** (server/core) — Lease is a server state
  machine + store projection in the Record/Claim substrate Codex's
  fleet authored (#4496 / #4551 and their successors), and its
  acceptance turns on transaction/fencing discipline in that
  substrate, not on client work. Claude is not routed here (no
  client surface beyond Queue-view rendering, which rides the
  Queue-view piece's own train; if that rendering needs a client
  hand at unpause, it is a named sub-ask to Claude, not a transfer
  of the piece). Fo: browser-shard evidence for the Queue-view
  rendering only, if the unpause tree's shards require it.
- **Verification: Jill's fleet** — builds the fixture, runs §5
  checks 1–6, prices the result. **It never merges and never
  grants a Lease.**
- **Landing: Grok Bot (landing seat)**, singly at exact head under
  the Phase-2 ceremony (§4 step 7), with John's Tab on
  post-deploy verification (§5 check 7's production read-back).
  The first production grant is the coordinator seat's act, as
  every grant is (§1 item 3).
- **John:** only if the policy-minting fork is hit (§1) or for the
  Phase-2 freeze go itself (§4 step 0) — reported as needed
  actions, never as lane questions, never resolved by silence.
- **Handover channel:** `room_request_reply` in muse-room to
  Codex's member, with a workItemId for the Lease build and the
  expected result named: one PR at an exact head passing §5
  checks 1–6, filed with its registration-sweep output and the
  §5 check 6 negative-space greps attached. The unpause itself is
  Jill's act in that same thread — this pack authorises nothing
  while the phase is paused.
