# Instruction pack — Ledger & Balances (what a user sees of money)

Slug: `money-ledger-balances`
Wave: wave-2026-10-28-design-instructions

## 1. The piece

What a member of a room can see of the room's credit money: their own
balances by lot state (payable / locked / attributed / approved), their
movement history, the room pool's position, and whether the room's money
still adds up (conservation). This pack is about **display and read
surfaces only**. It changes no money movement, no fee, no settlement
behaviour.

**FORK — read before starting.** This piece sits on John's pending
decision (b) in the master brief: the human sponsor surface was
deliberately deleted on 2026-10-19 under John's approved simplification
(see §2). There is therefore no human panel to polish at the target tree.
Section 4 is split: **Branch A** (John keeps sponsors agent/API-operated)
is executable now and is server/MCP/HTTP display only; **Branch B** (John
approves a human rebuild) adds one client panel and stops at exactly the
scope in §4B. Do not build Branch B on inference, and do not present
Branch A work as a human surface.

A second, narrower fork touches §4 step 5: fork (a), the two-tier
verified-delivery vocabulary. History receipts must not be labelled
"signed" / "verified" beyond what the data carries (see §2, item 6).

Verified against source: **main `aaa749065a6451321a949ddcb923f3174504fe35`**,
read by `git archive` of that SHA into the lane scratch (the shared clone
worktree was not read). Production is a different, older build
(`ca37fee4` per the master brief); nothing in this pack claims production
behaviour. All file/line references below are to the `aaa749065a` tree
unless named otherwise.

Where it lives, verified:

| Surface | File | What exists |
|---|---|---|
| Core ledger | `server/bounty-escrow.mjs` (3,319 lines) | Append-only double-entry `bounty_journal`; balances are derived, never stored. Header, lines 6–10: the only mint is genesis issuance, and `payable + locked + attributed + approved = total_issued`. `LOT_STATES = ["payable","locked","attributed","approved"]` (line 147). `GENESIS_CREDITS = 100` per lane (line 91). `POOL_ACCOUNT = "pool"` (line 109); fee `FEE_DENOMINATOR = 100` — 1% of the award to the pool, on released payouts only (line 103). |
| Per-lane balances | `server/bounty-escrow.mjs`, `balances(roomId, identity)` | Returns a frozen object: `identity, payable, locked, attributed, approved, total` (the four buckets summed **for that lane only**), plus `flake {strikes, rung, bondMultiplier, cooldownUntil}` and `reputation {completedBounties, earnedCredits, earnedCredits30d}` (paid completions only). |
| Movement history | `server/bounty-escrow.mjs`, `history(roomId, identity, {state, since})` | Movement-level receipts: both legs of every movement the lane touched, `before`/`after {account, lotState}`, `amount`/`amountMillis`, `hash`/`prevHash`, `signedReceiptIds`. |
| Conservation check | `server/bounty-escrow.mjs`, `verifyConservation(roomId)` | Returns `{ok, violations, totalIssued, byState}`: global sum vs genesis, per-state buckets, per-account non-negativity, per-bounty award coverage, per-account hash chains. **No HTTP route and no MCP tool calls it** (grep of `server/bounty-escrow-routes.mjs` and `server/mcp-full-profile.mjs` at this tree: no match). |
| Room metrics | `server/bounty-escrow.mjs`, `metrics(roomId)` | Returns `{byGroup, openBounties, lockedInEscrowCredits, paidOutCredits, poolFeesCredits}`. No caller was found in `server/`, `client/` route/MCP wiring at this tree — treat as unexposed until the implementer re-greps (see §5). |
| Offline conservation script | `scripts/bounty-conservation-check.mjs` | Read-only (`node:sqlite {readOnly:true}`), runs `verifyConservation` over every room, exit 0 clean / 1 violations / 2 environment error. Its own header states `verifyConservation` "has ZERO production callers: the chain's tamper-evidence is write-only". |
| HTTP routes | `server/bounty-escrow-routes.mjs`, mounted in `server/http.mjs` (credits matches at lines 4033–4036, dispatch at 4361–4383) | `GET /api/rooms/{roomId}/credits/balances/{identity}`, `GET /api/rooms/{roomId}/credits/history/{identity}`, `POST /api/rooms/{roomId}/credits/transfer`, `POST /api/rooms/{roomId}/credits/epoch/close`. Read gate `canReadLaneLedger`: the lane itself or the room owner only; anyone else gets `403 not_authorized` (the #3281 bilateral-ledger privacy rule). Documented in `docs/openapi.yaml` at `/api/rooms/{roomId}/credits/balances/{identity}` (line 8449) and `CreditBalances` schema ("Derived per-lane balances plus paid-only reputation", line 18366). |
| MCP tools | `client/bounty-tools.mjs`; dispatched in `server/mcp-full-profile.mjs` lines 466–468 | `bounty_read_balances` (caller's own lane only, no arguments) and `bounty_read_history` (`state`, `since`). Tool text already states the invariant in words: "payable + locked + attributed + approved always equals what was issued to you. Credits are ledger units with no cash value." |
| Pool | `server/bounty-escrow.mjs` lines 862–871 | The pool is an escrow-internal fee sink, **not a participant**: participant transfers to it are refused. Its money arrives only via `fee` and `bond-forfeit` movements. There is no pool balance read for a member: `balances()` for the pool lane is not reachable by an ordinary member under `canReadLaneLedger`, and `metrics().poolFeesCredits` (cumulative fees only, not the pool's current payable) is unexposed. |
| Separate ledger — do not conflate | `server/fee-credit-ledger.mjs` | A record-only Demigod trial-fee/placement-credit ledger (in-memory, string minor units, 180-day expiry). It is **not** the room credit ledger. Never sum, co-display, or label these together; `docs/openapi.yaml` line 12423 already states the analogous rule for milli-credits: never summed or co-displayed as one figure. |
| Human (browser) client | — | **Nothing.** No module in `src/` renders balances, history, the pool, or conservation. See §2, item 1. |

The worked example every display in this pack must be able to reproduce
(FS-FUND leg-8 settlement check, PASS, read 2026-10-24T02:35Z; recorded
in `MEMORY.md`, "FS-FUND leg-8 settlement check: PASS"):

- Builder payable **105.94**, locked 0, attributed 0.
- Sponsor total **94** — 23 payable / 71 locked.
- Pool **0.06**.
- Conservation **200.00 exact = genesis** (two lanes × 100 genesis credits).
- The two drill settlements behind it: FS-01 worker 1.98 / pool fee 0.02;
  FS-02 worker 3.96 / pool fee 0.04 (the 1% fee on released payouts).

Check the arithmetic the display must make legible:
105.94 + 94.00 + 0.06 = 200.00, and inside the sponsor figure
23 + 71 = 94. A display that shows any one of those numbers without the
sum that contains it has failed this pack's central requirement.

## 2. Current state

Executed/verified evidence, not inference:

1. **No human sees any of this in the browser.** The in-room human panel
   (`src/bounty-board.js`, created 2026-10-15 in the #3437 slice, with
   post/fund, review, balances, receipts) was deliberately deleted
   2026-10-19 in commit `f40ec67d` under John's approved simplification,
   and `DESIGN.md` gained the standing rule "Peripheral agent/API features
   do not automatically earn a human panel." Diagnosis, deletion commit,
   and the rule are documented in
   `~/workspace/wave-2026-10-27-ut-conversion/charters/sponsor-human-surface.md`
   (§Diagnosis, §The gap that remains real) and summarised in
   `~/workspace/wave-2026-10-27-ut-conversion/REPORT.md` §4 ("Sponsor board
   404 — DIAGNOSED: deliberate deletion; rebuild CHARTERED"). That charter's
   user-facing fact still stands at `aaa749065a`: a human cannot read
   balances or history in the browser; the economy is reachable only via
   the HTTP API and the `bounty_*` MCP tools. The 404 for the deleted file
   is correct behaviour, not a bug to fix.
2. **Conservation is computed but invisible.** `verifyConservation` is
   correct and complete (see §1) and the money-core deep dive graded
   invariants 1–16 HOLD at main `bdc5a04b` (recorded in `MEMORY.md`,
   "Money-core deep-dive verdicts (2026-10-25)"), yet at `aaa749065a` it
   has no HTTP route, no MCP tool, and — per
   `scripts/bounty-conservation-check.mjs`'s own header — zero production
   callers. The only way to see the FS-FUND 200.00 line today is an
   operator running that script against the database file, or an ad-hoc
   read. No user-facing surface states `totalIssued`, the per-state room
   buckets, or `ok / violations`.
3. **The room-level pool view does not exist as a read.** Members can
   infer fees only from their own history legs. `metrics()` computes
   `lockedInEscrowCredits`, `paidOutCredits`, and `poolFeesCredits`, but
   no route or tool exposing `escrow.metrics()` was found at this tree,
   and cumulative `poolFeesCredits` is in any case not the pool's current
   balance (forfeited bonds also land in the pool's payable bucket).
4. **The per-lane `total` invites a wrong reading.** `balances().total`
   is one lane's four buckets. Nothing at any surface labels it "your
   total, not the room total", and nothing places it next to the room's
   `totalIssued`. In the FS-FUND room, a builder reading only their own
   response sees 105.94 with no way to discover 94 + 0.06 or the 200.00
   it must sum to.
5. **Fee disclosure is not at main — it is bound, not landed.**
   `feeDisclosure` has zero hits in `server/`, `tests/`, and
   `docs/openapi.yaml` at `aaa749065a` (grep executed this lane).
   Bound PR **#5019** at head `18b6e3cbbc` adds "`feeDisclosure` on every
   bounty view (both doors) + Terms 'Credits and bounties' (award minus
   1%)", SETTLED-GREEN, money-surfaces + terms, lands singly
   (bindings file, PR #5019 note). Until it lands, a payout in history
   shows the net movement and the separate `fee` movement with no
   gross / fee / net grouping on the bounty view itself. This pack
   instructs only what remains **after** #5019 lands (§4, step 1).
6. **History must not overclaim signing.** `history()` returns
   `signedReceiptIds`, which are empty when no signer ran. Invariant 17
   (signed receipts) DOES-NOT-HOLD in production: no signer is wired, zero
   production callers, keeper movements issue no receipts even with a
   signer (`MEMORY.md`, money-core deep-dive verdicts, 2026-10-25; master
   brief: "the signer is UNPROVISIONABLE today"). Yet the
   `bounty_read_history` tool description in `client/bounty-tools.mjs`
   says signed receipts "carry an Ed25519 signature … verifiable offline".
   Any display built from that text without checking
   `signedReceiptIds.length` will claim a proof the room does not have.
7. **A state-filter mismatch between the two doors (verified at this
   tree).** `bounty_read_history`'s `state` enum in
   `client/bounty-tools.mjs` is
   `["payable","locked","attributed","approved","paid","refunded"]`, but
   `history()` in `server/bounty-escrow.mjs` validates `state` against
   `LOT_STATES` — only the first four — and rejects anything else with
   `invalid_input`. An agent filtering by `paid` or `refunded` through
   MCP is offered a value the server then refuses. (`paid`/`refunded` are
   movement outcomes, not lot states.)
8. **Bundled, unlabelled extras.** The balances response silently bundles
   the anti-flake ladder (`flake`) and paid-only `reputation` next to the
   money. No surface explains in plain words that `approved` is a
   transitional bucket (it becomes payable, minus the 1% fee, on the
   epoch sweep / finalize path), that `locked` mixes escrowed awards and
   bonds, or that `attributed` means "accepted, in its challenge window,
   not yet payable". The raw API names are the only explanation a reader
   gets.
9. **What is NOT broken — do not rebuild it.** The ledger itself:
   derived balances, hash-chained journal, per-bounty coverage checks,
   and the conservation verifier all hold (evidence in items 2 and 5
   above, plus bound audit-conversion pins: #4990 "B1-2 ledger pins" at
   `c5e94b23`, #4993 "B1-3 bonds/escrow pins" at `57e8b20a`, both
   SETTLED-GREEN in the bindings file). Bound money singles that touch
   what a balance display will show, and which this pack must not
   duplicate: #3952 escrow finalize at `4a69e29f` (finalize pays an
   approved bounty through the per-bounty door), #4297 settlement-time
   receipt content at `d4ff13f2` (stack: after #4295, before #4345),
   #4798 accept-at-deadline refusal at `918ca914`, #4998 settled-lot
   mirror authoritative leg at `2f2ca14d`, #5018 dispute core at
   `9ef07a88`, #5071 dispute case file at `54366223`, #5069
   funded-bounty withdraw/archive refusal at `87464cad`, #4157 at
   `8d74cee9` (export-only cure in `server/bounty-escrow.mjs`). Seat
   order and dispositions: `~/workspace/wave-2026-10-27-settle-pass-21/SYNTHESIS.md`
   §§ singles / money-singly / stacks. All of these land singly, green at
   exact head; a display change never rides in the same PR as any of them.

UNVERIFIED: whether any operator dashboard outside this repo already
renders `metrics()` or the conservation script's output. Nothing in the
tree at `aaa749065a` does; the implementer re-greps before claiming it
(§5, check 1).

## 3. What fantastic means

A member — human or agent — can answer, from one read, in plain words,
without doing arithmetic in their head and without trusting a number
they cannot re-derive:

1. **"What have I got, and in what state?"** Four labelled buckets, each
   with a one-line plain meaning of at most 12 words:
   payable = "yours to spend or transfer now"; locked = "held in escrow
   or as a bond, not spendable"; attributed = "accepted work, in its
   challenge window, not yet payable"; approved = "cleared to pay out;
   becomes payable minus the 1% pool fee". Then **"Your total"** —
   explicitly captioned "your four buckets; not the room total".
2. **"Does the room's money add up?"** One conservation line, always
   adjacent to any room-level figure, in exactly this shape:
   `Room total 200.00 = payable P + locked L + attributed A + approved V
   across all lanes and the pool · issued 200.00 · checks pass`
   (or `checks fail: N problems` — never a silent omission, never a
   green tick without the numbers). Rendered from a live
   `verifyConservation` result plus the per-state room buckets, with the
   time it was computed. In the FS-FUND room this line, drilled to lanes,
   reads: builder 105.94 + sponsor 94.00 (23 payable / 71 locked) +
   pool 0.06 = 200.00.
3. **"What is the pool?"** Pool payable balance, cumulative fees in,
   cumulative forfeits in, each labelled; one sentence: "The pool holds
   the 1% fee from released payouts and forfeited bonds. It is not a
   member and cannot be paid by transfer." No pool figure ever appears
   without the conservation line from item 2 next to it.
4. **"What happened?"** History grouped as movements (not journal legs),
   newest first, each showing kind in plain words, amount, the
   counterparty account and lot-state change, and — for a payout —
   gross / fee / net as one grouped triple (after #5019,
   `feeDisclosure` is the source; do not recompute the fee client-side).
   A receipt with no signature is labelled "unsigned — hash-chained
   only"; the word "signed" appears only when `signedReceiptIds` is
   non-empty for that movement.
5. **Honesty invariants on every surface that shows an amount**
   (standing rules, from `DESIGN.md` as cited in the sponsor charter and
   the room anti-slop skill): the sentence "Credits are valueless ledger
   units: no cash-out, no real money" appears wherever a balance or award
   amount appears; a price/reward is shown as payable only where it can
   actually be paid; no figure from `server/fee-credit-ledger.mjs` is
   ever shown on the same surface as a room-credit figure.
6. **Numbers that prove it:**
   - Conservation line present in 100% of room-view responses; its four
     buckets sum to `totalIssued` to the milli-credit (3-decimal exact,
     no float rounding in display: format from `amountMillis`-style
     integers, never from summed floats — `balances()`'s `total` is a
     float sum of `toCredits()` values and must not be copied as a
     display pattern).
   - Zero extra reads: the room view is one HTTP response / one MCP
     result containing balances (where authorised), pool, and
     conservation; history stays a separate, paginated-by-`since` read.
   - Every bucket label + definition renders in ≤ 140 characters per
     bucket; the whole balances block (Branch B panel) fits one viewport
     at 360 px wide with no horizontal scroll.
   - The `paid`/`refunded` filter trap (§2 item 7) is gone: every value
     the MCP schema offers is accepted by the server, proven by test.
   - Load cost: the room view adds no per-lane history expansion; its
     server work is the existing `verifyConservation` + aggregate
     `SUM … GROUP BY` queries only (the journal lot-state index noted at
     `server/bounty-escrow.mjs` line 1043 exists for exactly these sums).

Exemplars worth matching (named, not copied): the **Stripe Dashboard
balance view** — available vs pending shown as labelled buckets that
visibly sum to the total, with the pending bucket explaining when it
clears (the model for payable vs attributed/approved); a **Wise account
statement** — every movement grouped with its fee broken out on the same
row, never on a separate screen (the model for gross / fee / net).

## 4. The instruction

Target tree: **main, after the bound money singles in §2 item 9 have
landed** — re-read the bindings file
(`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`)
at start; if #5019 has not landed, do steps 2–4 and hold step 5's
fee-grouping leg. This is a money-adjacent display change: it lands
**singly, green at exact head**, never batched, and never in the same PR
as a money-movement change. Client work, if any, stays vanilla JS.

### Branch A — agent/API surfaces (executable now, no John decision needed)

Step 1 — **Re-verify, don't assume.** At the starting head, re-grep:
`feeDisclosure` in `server/bounty-escrow.mjs` (has #5019 landed?);
`verifyConservation` and `.metrics(` callers across `server/` and
`client/`; the current `CreditBalances` schema in `docs/openapi.yaml`.
Record the head SHA and the results in the PR body. If #5019 has not
landed, note it and skip the fee-triple rendering in step 5.

Step 2 — **Add one room-money read to the escrow module.**
In `server/bounty-escrow.mjs`, add a read-only method (working name
`roomMoneyView(roomId)`) inside a `readTransaction`, composing existing
code only: `verifyConservation(roomId)` for `{ok, violations,
totalIssued, byState}`; one aggregate query for the pool lane
(`account_id = POOL_ACCOUNT`) giving pool payable plus cumulative
`fee` and `bond-forfeit` credits; and `metrics(roomId)`'s
`lockedInEscrowCredits / paidOutCredits / poolFeesCredits`. Return a
frozen object with integer milli-credit fields alongside the credit
values, so renderers never sum floats. No new tables, no schema change,
no journal writes, no change to any existing method's return shape.

Step 3 — **Expose it on both existing doors, with the existing privacy
rule.** (a) HTTP: a new GET route alongside the credits routes in
`server/http.mjs` + `server/bounty-escrow-routes.mjs`, shaped
`GET /api/rooms/{roomId}/credits/room-view`, **room-owner only** (reuse
`isRoomOwner`; the room view aggregates every lane, so the
self-or-owner rule of `canReadLaneLedger` does not widen to "any
member"). A non-owner gets `403 not_authorized`, matching the existing
credits error contract. (b) MCP: extend the hosted profile in
`server/mcp-full-profile.mjs` / `client/bounty-tools.mjs` only if the
catalogue step in §5 can be completed in the same PR; the tool (working
name `bounty_read_room_money`) must enforce the same owner-only rule
server-side — the MCP door currently passes only the caller's own lane
to `balances`/`history`, and this tool must not become the hole in that
rule. If owner identity cannot be established on the MCP door, ship the
HTTP leg alone and say so in the PR body; do not ship an all-members
MCP version. (c) Per-lane `balances`/`history` responses and tools stay
byte-compatible; at most, add the caption data (`totalScope: "lane"`)
as an additive field.

Step 4 — **Fix the history state-filter mismatch (§2 item 7).** Align
`client/bounty-tools.mjs`'s `bounty_read_history` enum with the server:
either remove `paid`/`refunded` from the offered enum, or — preferred,
if it can be done inside `history()` without changing existing results
for the four lot states — teach `history()` to treat `paid`/`refunded`
as movement-kind filters. One behaviour, both doors, with a test that
exercises every offered value end-to-end. Do not change the four
lot-state filters' results.

Step 5 — **Make every rendered amount honest (all Branch A surfaces:
route JSON field names/docs, MCP tool descriptions, OpenAPI text).**
(a) Where a payout movement is described, group gross / fee / net from
#5019's `feeDisclosure` / the movement legs; never recompute 1%
downstream. (b) Rewrite the `bounty_read_history` description so signing
is conditional: "…hash-chained to the previous entry; movements with a
non-empty `signedReceiptIds` also carry an Ed25519 signature" — and add
the same conditional wording anywhere `history()` output is documented
in `docs/openapi.yaml`. Do **not** adopt a "verified" label for receipts
in this step: that vocabulary is fork (a), John's; use the factual
"signed / unsigned — hash-chained only" wording above until he rules.
(c) Ensure the valueless-credits sentence (§3 item 5) is present in the
room-view and balances documentation text on both doors.

Step 6 — **Tests.** Add/extend: a balances + room-view test that builds
the FS-FUND shape in a test room (two genesis lanes; fund, claim,
submit, accept, finalize two bounties at the leg-8 amounts) and asserts
the room view reports builder payable 105.94, sponsor 23 payable / 71
locked / total 94, pool 0.06, `totalIssued` 200, `ok: true`, and that
the four room buckets sum exactly in milli-credits; a 403 test for a
non-owner, non-self room-view read; a test for every `state` value the
MCP schema offers (step 4). Follow the existing suites' patterns:
`tests/bounty-escrow.test.js`, `tests/bounty-escrow-routes.test.js`,
`tests/bounty-escrow-http.test.js`, `tests/bounty-conservation-check.test.js`,
`tests/mcp-bounty-escrow-errors.test.js`.

Explicit non-goals (Branch A): no new human UI; no change to genesis
amounts, the fee, lot states, epoch/finalize timing, dispute or
settlement behaviour; no production caller/scheduler for the
conservation script (that is an operator/integrity piece, not this
one); no public (unauthenticated) money read of any kind; no exposure
of another lane's history to a non-owner; no touching
`server/fee-credit-ledger.mjs`.

### Branch B — human panel (ONLY on John's explicit ruling reversing 2026-10-19)

Step B1 — Build **one** room panel, vanilla JS, current navigation, per
the minimum surface in the sponsor charter
(`~/workspace/wave-2026-10-27-ut-conversion/charters/sponsor-human-surface.md`
§Rebuild scope items 1 and 4, narrowed to this piece): the §3 balances
block (own lane), the conservation line, the pool block, and own
history with the gross / fee / net grouping. Post/fund/accept controls
are the sponsor piece, **not** this pack — this panel is read-only.
Step B2 — Wire it completely: served-asset registration in
`server/public-assets.mjs` and the runtime package, in the same PR
(the original panel shipped dead for exactly this omission; the sponsor
charter names it and `tests/lazy-import-assets.test.js` guards it).
Step B3 — Rendered browser check: a human identity opens the panel in a
room where they hold a balance and sees figures identical to the HTTP
responses for the same room/lane; the panel is absent (not empty, not
erroring) in a room where the viewer has no standing, per the design
decision recorded with John's ruling.
If John rules "sponsors stay agent-operated", close Branch B by
recording that decision in `DESIGN.md` next to the panel rule, as the
sponsor charter's kill criteria direct — that docs-only PR is the
deliverable, not a panel.

## 5. Acceptance

The coordinator/Jill runs these at the PR's exact head; money-adjacent
rules apply (singly, exact-head green, two agreeing reads or one named
API read for any reported state).

Executed checks:

1. **Source re-verification:** the PR body names its base head SHA and
   the step-1 grep results; Jill re-runs
   `grep -rn "feeDisclosure" server/bounty-escrow.mjs`,
   `grep -rn "verifyConservation" server/ client/`, and the
   `escrow.metrics` caller grep at that head and confirms the PR's
   claims match.
2. **Test suites by name, all green at the exact head:**
   `tests/bounty-escrow.test.js`, `tests/bounty-escrow-routes.test.js`,
   `tests/bounty-escrow-http.test.js`,
   `tests/bounty-escrow-atomicity.test.js`,
   `tests/bounty-conservation-check.test.js`,
   `tests/bounty-receipts.test.js`, `tests/bounty-disputes.test.js`,
   `tests/mcp-bounty-escrow-errors.test.js`, plus the new tests from
   §4 step 6 (named in the PR body). Then `npm run verify:affected`,
   and, because the diff touches `server/**`, `CI=1 npm run check`
   (per AGENTS.md close-out rule). Hosted CI: the PR must carry the
   `ready-to-land` label or its gated jobs report `skipped` by design —
   a skipped generation is not evidence.
3. **FS-FUND fixture probe (the headline check):** run the §4 step 6
   test room scenario and read the new room view over HTTP as the
   owner: response states builder payable 105.94, sponsor payable 23 /
   locked 71 / total 94, pool payable 0.06, `totalIssued` 200,
   conservation `ok: true`, and the milli-credit bucket sum equals
   200,000 exactly. As a non-owner member, the same GET returns
   `403 not_authorized`; as the builder, `GET credits/balances/<self>`
   still returns the pre-change shape plus at most the additive
   caption field.
4. **Filter probe:** for each value in the MCP `bounty_read_history`
   `state` enum at the new head, one executed call succeeds (no
   `invalid_input` for an offered value).
5. **Honesty probes:** (a) grep the diff for "signed" / "verified"
   near receipt/history copy — every occurrence is conditional on
   `signedReceiptIds` or is the factual unsigned label; (b) the
   valueless-credits sentence is present in the room-view docs/tool
   text; (c) an adversarial read of the room-view JSON: no field sums
   room credits with fee-credit-ledger units, and the per-lane total
   is captioned as lane-scoped wherever it is documented.
6. **Conservation script regression:** `node scripts/bounty-conservation-check.mjs`
   against a test database still exits 0 on a clean room and 1 on a
   room with an injected violation (existing suite in check 2 covers
   the script; this confirms the new read did not alter
   `verifyConservation`'s behaviour or return shape).
7. **Branch B only:** `tests/lazy-import-assets.test.js` green; the
   rendered browser check in step B3 executed by Fo / John's Tab with
   figures matched against the HTTP responses; panel absent for a
   no-standing viewer.

Registration sweep (AGENTS.md "Pre-flight registration sweep") — the
implementer runs `node ~/workspace/fleet-tools/registration-sweep.mjs
--pr <n>` and it must exit with no MISSING:

- **Runtime-package closure — APPLIES if** any new `server/**` module is
  added (none is planned; `roomMoneyView` lives in the existing
  escrow module). If one appears: allowlist in
  `scripts/runtime-package.mjs` including its import closure, plus
  `scripts/candidate-runtime-fixture.mjs`, verified by the closure test.
- **Error-code catalogue, both copies — APPLIES if** a new error code is
  introduced (none is planned; reuse `not_authorized`). If one appears:
  row in `skills/project-room/references/errors-catalog.md`, then
  `node scripts/skills-sync.mjs` so the `plugins/` mirror is
  byte-identical.
- **Route triple — APPLIES.** New GET route → row in
  `server/routes/table.mjs` (and the legacy allowlist if it lands on
  the legacy chain), a `docs/openapi.yaml` operation for
  `/api/rooms/{roomId}/credits/room-view` written as a bare path with a
  quickstart example, a well-formed `x-room-permission` marker on the
  operation, and a parity note on the route row — `parity:
  "mcp:bounty_read_room_money"` if step 3(b) ships, otherwise
  `exempt:<reason>` naming the owner-only MCP restriction.
- **Harness copy sets — APPLIES if** Branch B adds a client module that
  any test harness copies/transforms; wire it into that harness's
  copy/re-point set. Branch A server-only: n/a — no client module is
  added (the `client/bounty-tools.mjs` edit is a definition change in
  an existing file; still check the harness sets that copy it).
- **Store registries — n/a:** no new table; read-only aggregates over
  `bounty_journal` / `bounty_records` only, so no writer-fence,
  purge-registry, or recovery-audit registration.
- **Generated/mirrored artifacts — APPLIES.** MCP catalogue growth
  (step 3b) moves `tests/fixtures/mcp-catalog.snapshot.json`
  (regenerate in the same diff) and the count pins in
  `tests/mcp-search-actions.test.js` and
  `tests/mcp-untrusted-content.test.js` — run both by name;
  `verify:affected` does not select them. OpenAPI changes must keep the
  route-docs gate green. No EVENT_TYPES growth is permitted in this
  pack; if the diff adds an event type it is out of scope, stop.
- **Diff hygiene:** if the diff exceeds 300 changed lines, the PR body
  carries the `## Large diff justification:` section at filing.
- **Refusal-shape step — APPLIES if** step 4 changes any refusal: grep
  the test tree at head for pins on the old `invalid_input` behaviour
  for `state=paid|refunded` and report them as REQUIRED-review evidence
  in the PR body (never as sweep MISSING).

## 6. Routing

- **Implementer, Branch A server/read-model (steps 2–4, 6): Codex** —
  server/core is his seat, the escrow module is his terrain, and any
  landing runs from John's Mac under his coordination. Handover:
  `room_request_reply` in Project Room to Codex's member, naming this
  pack, a `workItemId`, and the expected result: one PR, singly-queued,
  containing the room view on both doors (or HTTP-only with the §4
  step 3(b) reason stated), the filter fix, and the §4 step 6 tests,
  with the registration sweep clean.
- **Implementer, copy/docs legs (step 5) and Branch B panel, if John
  rules for it: Claude** — client surfaces and design/copy coherence are
  his train; the bucket definitions, conservation line, and honesty
  sentences in §3 are the copy spec. Same handover channel, separate
  `workItemId`, and Branch B does not start before John's ruling is on
  the record.
- **Landing seat: Grok Bot**, singly, after the already-bound money
  singles in §2 item 9 — this pack's PR never jumps that queue and
  never batches with one of them. Fix lanes (including Jill's fleet)
  never merge it.
- **Verification: Jill's fleet** runs §5 checks 1–6 and files the
  verdict at the source (PR + exact head); **Fo** owns any browser-shard
  evidence if Branch B's rendered check touches the shards; **John's
  Tab** does the post-deploy probe: owner room-view GET on production
  against a known room, figures matched to the conservation script's
  output for the same database — production runs a different build
  until this lands and deploys, so a pre-deploy production probe proves
  nothing about this pack.
- **John's hand, named once:** the Branch B ruling itself (reverse or
  reaffirm the 2026-10-19 panel deletion), and, only if step 5's wording
  is ever to say "verified", the fork (a) vocabulary ruling. Neither
  blocks Branch A.
