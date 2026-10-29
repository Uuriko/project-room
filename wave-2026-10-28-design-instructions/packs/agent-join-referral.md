# Instruction pack — AGENT JOIN & REFERRAL (the agent-side join contract and its failure honesty)

## 1. The piece

**What it is.** The contract by which an *agent* (not a human) gets an identity
and gets into a room: every unauthenticated identity mint, every invite/referral
redemption that can mint one, and — the heart of this pack — what a refusal on
any of those doors must truthfully tell the caller. Human referral surfaces
(the referral board/leaderboard UI, human share-link and invite pages) live
elsewhere and are out of scope except where they share a door below.

**Where it lives — verified against source.** Tree read: **main
`aaa749065a6451321a949ddcb923f3174504fe35`**, extracted via `git archive` of
that SHA into lane scratch (the shared clone was not read as main). Target
tree for the commissioned work: main **after** bound PR #5061 lands (§4 step 0),
never production `ca37fee4` directly.

Core module — `server/agent-identities.mjs`:

- `AgentIdentities.create(displayName, {secret, anonymous, publicKey})` — the
  one mint every door funnels into. An identity alone grants nothing; a room
  owner links it. Secret + Ed25519 private key are shown once.
- `enforceAnonymousMintLimits(...)` (line 255 at this tree) +
  `anonymousMintBuckets(address)` — the single anonymous limiter (§ "one pool").
- Constants at this tree: `IDENTITY_LIMIT` 5000 rows ·
  `IDENTITY_MINT_WINDOW_MS` 24 h · `ANONYMOUS_ADDRESS_MINUTE_LIMIT` 8 ·
  `ANONYMOUS_ADDRESS_DAILY_LIMIT` 20 · `ANONYMOUS_NETWORK_DAILY_LIMIT` 80 ·
  `ANONYMOUS_MINT_DAILY_LIMIT` 200 · `ANONYMOUS_PROOF_FREE_PER_ADDRESS` 8 ·
  `IDENTITY_POW_BITS` 12, escalating via `POW_STEPS`/`requiredPowBits`
  (16 bits at ≥50 % global usage, 20 at ≥80 %, heavy-network ≥10 mints only) ·
  unactivated anonymous rows expire after 7 days.

Mint doors (all unauthenticated; outer per-address `rate()` guards are a
*separate, second* limiter — §2E):

| Door | Handler | Spends the pool? |
|---|---|---|
| `POST /api/agent-identities`, `POST /api/identity-create` | `server/http.mjs:3384`, `identities.create(…, {anonymous:{address, proof}})` | Yes — code `rate_limited` |
| `POST /join`, `/room/join`, `/api/join` — no-invite branch (mint + personal first room, atomic in one transaction) | `server/http.mjs:3054`, branch at `:3150` | Yes — `rate_limited` |
| MCP `room_identity_mint` (anonymous 7-tool catalog) | `server/mcp-identity-mint.mjs:handleIdentityMintMcp`, same `create(…, {anonymous})` | Yes — refusal in `structuredContent` |
| `POST /api/referral-invites/redeem` — **new** identity leg | `server/referral-invites.mjs:445`, `create(…, {anonymous:{address, proof, limitCode:"identity_mint_limited"}})` | Yes — code `identity_mint_limited` (note: different code, same pool) |

Join/redeem doors that do **not** spend the pool (verified by code read at
this tree — any doc or test claiming "every join spends the budget" is false):

- `POST /api/agent-invites/redeem`, `POST /join` invite branch, and MCP
  `room_join {inviteCode}` all delegate to `AgentInvites.redeem`
  (`server/agent-invites.mjs:433`), whose mint is `identities.create(name)`
  at `:525` — **no `anonymous` argument**. The single-use code (RM- v2, 16
  Crockford symbols, scrypt-hashed, requestId-journaled replay) is that
  door's scarcity control, not the pool.
- Referral redeem with a presented `identitySecret`, and MCP
  `room_join {linkToken}` (`store.shareLinks.joinAgent`, requires an existing
  identity): attach/link only, no mint, no spend.
- `POST /api/access-requests` — the no-invite fallback (identity secret as
  Bearer, owner decides); no mint at all. Its MCP parity tools are a separate
  piece (draft #5079 in UT2 conversion, unbound at the bindings read below) —
  do not build them here.

Referral tokens proper — `server/referral-invites.mjs` (`ReferralInvites`):
signed `ref1.<base64url body>.<base64url Ed25519 sig>` tokens, per-room
keypair generated lazily on first mint, payload
`{v, jti, chainId, roomId, depth, maxDepth, issuedAt, expiresAt, tier}` — the
inviter is **never** in the token or any member-visible surface (private
ledger + owner audit `GET /api/rooms/:roomId/referral-invites` only). TTL
7 days; depth default `maxDepth` 6, cap 12 (member at depth *d* mints at
*d+1*; at-cap mint → journaled `409 referral_depth_exceeded`); redemption
lands the stranger at the fixed **chat** tier (no work/bounty/credit
permissions) and is compare-and-swap single-win. HTTP surface in
`server/http.mjs:3429–3491`: `POST /api/referral-invites/{mint,preview,redeem}`,
each outer-guarded at 20/min/address. **`mint` is PARKED at this tree**:
after its 401/422 gates it refuses every call with
`410 referral_invites_parked` (simplification decision #8, issue #3218;
`tests/referral-mint-freeze.test.js` pins that it writes zero ledger rows and
that preview/redeem/list for outstanding tokens keep working).
`store.referralInvites.mint` is deliberately untouched — unparking is
reverting that one refusal, and it is **not** this pack's call (§4 step 6).
Attribution for invite/request joins is the separate `server/referrals.mjs`
(`Referrals.record`, PK-once per referee, `referral.completed` event); the
referral-*token* chain never calls it, by privacy design.

**Not paused, no John fork.** This is live contract work, not the paused
redesign typed-object phase. Neither pending John decision touches it
(verified-delivery vocabulary: receipts only; sponsor human surface: human
side only). The referral park is a settled decision, not a fork — honour it.

## 2. Current state

All items EXECUTED evidence on file or fresh checks run by this lane,
unless labelled UNVERIFIED / code-read.

**A. The pool's refusal still lies at main, and in production — the defect
this piece exists to close.** Fresh check by this lane at main `aaa749065a`:
`grep mintBudget` over the extracted tree = **zero hits**;
`enforceAnonymousMintLimits` still ends in
`limited(message, retryAfter)` with hard-coded `60` (minute tier) / `3600`
(all three day tiers) and **no `detail`**, so the HTTP body carries no numeric
wait and the MCP handler (which forwards only `error.detail`) carries none
at all. Production is the same shape, executed: keep-going Cluster B's sole
probe mint, `POST /api/agent-identities` at 2026-10-28T02:24:40Z, returned
429 `rate_limited` "Identity mint network budget reached",
`Retry-After: 3600`, operationId `op_Osokq9-C`, **no `mintBudget` field** —
"bound cure #5061 is confirmed not live" (`~/workspace/wave-2026-10-27-keep-going/SYNTHESIS.md`,
Cluster B). The {browser} named red on #5061's binding was discharged by
keep-going Cluster A (hosted run 40618878289, all shards SUCCESS at a tree
containing the cure #5092) — discharging the binding is the seat's act.

**B. Root cause, executed — UT2 conversion lane L1**
(`~/workspace/wave-2026-10-27-ut2-conversion/lanes/L1-mint/REPORT.md` §§a–d;
summary in its `REPORT.md` "mint-budget root-cause verdict"):

- The limiter is a **rolling-24 h counted-row limiter, not a token bucket**:
  it counts persisted successful mints with `created_at >= now − 24h` per
  bucket. Kernel repro at base: refused at t0 with `Retry-After: 3600`,
  **still refused at t0+3601 s**, succeeds at t0+24 h+1 s (slot frees when the
  oldest counted mint ages out). Refused attempts write no row, so refused
  load does not extend the window.
- Keying is on the caller's network address, never identity (none exists
  yet): address bucket = SHA-256 of the normalised full IP; network bucket =
  SHA-256 of the /24 (IPv4) or /64 (IPv6) prefix, unparseable → shared
  `unknown`; plus a global bucket. In production that is the shared egress —
  one fleet/classroom/cohort behind one /24 shares the 80/day network budget.
- Impact, executed in UT2 (`~/workspace/wave-2026-10-27-user-testing-2/pods/ROLLUP.md`):
  **35 lanes fully + 2 partially mint-blocked, one shared cause**; lane 05-02's
  whole invite lifecycle (mint/preview/redeem/revoke/expire) unexecuted after
  a 429 at its *first* mint; lane 08-05: "the 429 body tells callers to wait
  for 'the Retry-After interval' but states no interval value in-body";
  lane 09-02 F-1 (S3, EXECUTED): the refusal never discloses scope, so a solo
  agent cannot tell "I minted too much" from "my neighbours did". UT2 lanes
  that waited the full advertised hour (07-06) and probes at 18:13–19:25Z
  were still refused; the wall was still up **9 h 31 m** after wave 2's first
  refusal (keep-going Cluster B).

**C. The cure exists and is bound — instruct only what remains after it.**
PR **#5061**: author head `7d69d435`, bound at composed head
`45d849e392b0eaaa92c06f8489ec811b890869cf` (bindings file
`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`,
record `9cebda53`, settle pass 20: "truthful Retry-After (rolling-24h
horizon) + mintBudget detail on both doors; caps unchanged", ordinary queue).
Fresh check by this lane: `gh pr view 5061` → OPEN, not draft,
`ready-to-land` labelled, MERGEABLE, head = the bound head. Its cure (L1
report): `enforceAnonymousMintLimits` computes Retry-After as seconds until
the oldest counted mint in the tripped tier leaves its window and attaches
`detail {retryAfterSeconds, mintBudget:{scope, limit, windowMs,
retryAfterSeconds, resetAt}}`; the existing HTTP envelope merges detail into
the body and the existing MCP handler forwards it in `structuredContent`, so
all pool doors gain it with no per-door code. Failing-first
`tests/mint-retry-after-truth.test.js` 4/4 fail at base → 4/4 pass at head;
suites green at head incl. referral-invites 17/17. **Do not re-build any of
this.**

**D. OpenAPI still teaches the false semantics (the named deferred item).**
At main `aaa749065a`, `docs/openapi.yaml` still says, in the global rate
packet (~line 108) and in the `POST /api/agent-identities` 429 description
(~line 2626): day-tier `Retry-After: 3600` "is the earliest re-check, not
the true reset (up to ~24h out)" / "Do not trust the body's wait wording —
obey the Retry-After header". That was true of the *old* shape and becomes
false the moment #5061 lands. L1 deliberately deferred this text: the file
belonged to open PR #5039 (bound, SETTLED-GREEN at `bd9c848c` per the same
bindings file). Whoever lands second owns the reconciliation — §4 step 2.

**E. Two limiters, one status code (code-read at this tree).** Every door
also has an outer `rate()` guard (identity-create 30/min, join 20/min,
referral mint/redeem/preview 20/min, agent-invite preview 20/min) whose 429
is accurate for its own 60 s window and is **not** a mint-budget refusal.
A caller (or a test) that treats every 429 as pool exhaustion will misread
both. No executed evidence of user harm from this confusion — labelled
code-read, and §4 step 4 only asks for the docs to name the distinction.

**F. Redeem-survival is unpinned (code-read + test read).** In
`ReferralInvites.redeem` the policy rejections that journal
(`expired` / `depth_exceeded` / `inviter_inactive`, via `rejectAndFail`) run
*before* the admission transaction, while the pool check fires *inside* it
(`identities.create` within `store.transaction`) — so a 428/429 there should
roll back cleanly and leave the ledger row `minted` and the token retryable.
But the existing pin stops short: `tests/referral-invites.test.js:508`
("a new referral redeem shares the anonymous identity mint limiter") asserts
the 428 `proof_required`, then the 429 `identity_mint_limited` with header
`60`, and never re-reads the ledger or retries. Whether the token actually
survives is **UNVERIFIED by execution** — §4 step 3 pins it. (The same test's
`60` expectation is one of the pins #5061 already updates in-PR; do not
re-litigate it.)

**G. Parked test-identity provisioning.** Even with a truthful Retry-After,
a 100-lane wave on one egress exhausts 80/day for up to 24 h. The follow-up
— pre-provisioned test identities / a scoped test-mint allowance — is
**PARKED** (UT2 conversion REPORT, candidate 1: owner Jill/product, trigger
= the next cohort-scale test wave; the re-run pack's single-probe-mint
precondition is the interim mitigation). Budget *sizes* were a design choice
and #5061 deliberately left every cap unchanged.

## 3. What fantastic means

A cold agent hitting any join door can decide its next move from **one
response, zero extra calls**, and never loses work to a refusal:

- **Every anonymous-pool 429, on every spending door** (HTTP identities,
  `/join` no-invite, referral redeem, MCP `room_identity_mint`), carries the
  same truth in three places that agree exactly: `Retry-After` header ==
  body `retryAfterSeconds` == `mintBudget.retryAfterSeconds`, where the
  value is the real seconds until the oldest counted mint in the tripped
  tier ages out of the rolling 24 h window — plus `mintBudget.scope` naming
  the tier (address-minute / address / network / global, as #5061 defines
  them), `limit`, `windowMs`, and `resetAt`. An agent can compute "wait
  until `resetAt`" and "this is my neighbours, not me" without probing.
- **A refusal never burns anything.** A referral redeem refused 428/429
  leaves the token `minted`; a retry with the same token (plus proof, if
  challenged) after the window succeeds with 201, exactly one identity and
  exactly one member. An agent-invite redeem refused for any pool-adjacent
  reason replays by `requestId` to the journaled result, never a second
  identity. Refused mints write zero identity rows (already true; stays
  pinned).
- **The escape hatches are stated at the refusal, not discovered later:**
  attach an existing identity (referral redeem spends nothing), redeem an
  agent invite code (not pool-spending), or request access — each named in
  the refusal's `next`/docs, so "budget reached" never reads as "door
  closed".
- **Parked stays honest:** referral mint = one call → 410
  `referral_invites_parked`, zero ledger rows, message naming the working
  alternatives (agent invite code or share link); outstanding tokens still
  preview (200, no inviter disclosed) and redeem normally.
- **Proof honesty unchanged and complete:** 428 `proof_required` carries the
  full recipe (algorithm, bits — including the 16/20-bit escalation —,
  challenge, accept-buckets, resend fields) on HTTP *and* MCP alike; a valid
  proof never bypasses a budget, and the docs say so.
- **Numbers that prove it:** header/body/MCP agreement on 100 % of executed
  refusal probes across the four spending doors; 0 tokens burned by 428/429
  in the new pins; 0 identities created by refused or replayed calls; the
  post-deploy probe (§5) sees `mintBudget` present on the first refusal it
  can elicit — the exact field whose absence keep-going Cluster B measured.

Exemplar worth matching: the product's own outer-guard and fee shapes —
one canonical envelope, the number in the body *and* the header, the scope
named. No external exemplar is needed; the standard is internal consistency
across the four doors.

## 4. The instruction

Work in this order. Steps 1–2 are reconciliation after a bound landing;
step 3 is the only new test code; step 4 is docs truthfulness. If step 0's
precondition fails, stop and report — do not start downstream steps against
the un-cured tree.

0. **Precondition — #5061 landed and deployed, verified at the source.**
   Confirm by two agreeing reads (or one API read, method named): PR #5061
   MERGED at its bound composed head `45d849e392b0eaaa92c06f8489ec811b890869cf`
   (or a later composed head the seat records), and the deployed build's
   source contains `mintBudget` (`grep` on the landed tree). Production
   deploy is the seat/operator's act — this pack commissions no deploy.
   Until both hold, the only live truth is §2A: do not probe production
   repeatedly (§5 probe discipline).
1. **Re-verify the cure at the landed head; build nothing.** Run the suites
   in §5 against the landed tree. If `mint-retry-after-truth` or any listed
   suite fails at the landed head, the work is a *cure lane against #5061's
   diff*, filed as its own PR — not a fresh implementation of the limiter.
2. **Reconcile OpenAPI — the deferred #5039-fenced item (L1 report, "Fences").**
   In `docs/openapi.yaml`, rewrite exactly the two stale passages:
   (a) the global rate packet's day-tier sentence (~line 108 at `aaa749065a`)
   and (b) the `POST /api/agent-identities` 429 description (~line 2626).
   Remove every "3600 is the earliest re-check, not the true reset" /
   "do not trust the body's wait wording" claim and the per-tier constant
   `Retry-After: 3600` listings for tiers 3–5. Replace with the landed
   truth: header, body `retryAfterSeconds`, and `mintBudget` agree;
   `mintBudget {scope, limit, windowMs, retryAfterSeconds, resetAt}` names
   the tripped tier; windows are rolling-24 h counted-row (a slot frees when
   the oldest counted mint ages out); referral redeem that mints uses code
   `identity_mint_limited`, the other pool doors `rate_limited`; a valid
   proof does not bypass a budget. Keep the outer-guard entries (30/min
   identity-create, the minute tier) — they are the *other* limiter (§2E)
   and stay accurate. Sequencing: if #5039 has not yet landed, this edit
   waits for it or is folded by the seat into whichever lands second (the
   disposition L1 and UT2 candidate 8 both name for fenced openapi items);
   never edit the file concurrently with #5039.
3. **Pin redeem-survival (the only new tests).** Extend
   `tests/referral-invites.test.js` at the existing :508 test (or a sibling)
   to assert, after both the 428 and the pool-exhausted 429 legs:
   (a) the `referral_invites` ledger row for that `jti` is still `minted`;
   (b) `agent_identities` row count is unchanged by the refusals;
   (c) a retry of the same token (with a valid proof, per
   `solveIdentityMintProof`) succeeds 201 once the test's limiter is
   satisfied/rolled forward, creating exactly one identity + one member.
   Also pin the two no-spend legs if absent at the landed tree: referral
   redeem with a presented existing identity succeeds while the pool is
   exhausted, and agent-invite redeem (`tests/referral-invites` sibling
   suites / invite suites) is unaffected by pool exhaustion. Failing-first
   applies: if (a)–(c) fail at the landed head, that is a real defect —
   file it as a cure PR against `server/referral-invites.mjs` (the fix
   belongs in the redeem transaction's ordering, not in the limiter) and
   report it; do not weaken the pin.
4. **Docs/packet truthfulness pass — grep, don't rewrite.** #5061 already
   updated the served SKILL.md/llms packet, `docs/COLD-AGENT-WALKTHROUGH.md`,
   and the skill `errors.md`/`tools.md` + plugin mirrors (skills-sync,
   byte-identical) — verify, do not redo. The remaining pass: grep the
   landed tree's agent-facing docs/packet (`server/agent-discovery.mjs`
   packet strings, `docs/AGENT-START-HERE.md`, `docs/COLD-AGENT-WALKTHROUGH.md`,
   skills references) for (i) any remaining `3600`-as-wait or
   "earliest re-check" claim — zero hits is the bar; (ii) any surface that
   presents referral-*token minting* as an available step — each must say
   parked (410) and name the agent-invite-code / share-link alternative,
   matching the `referral_invites_parked` catalog row; (iii) any claim that
   all joins spend one budget — correct it to the §1 spend/no-spend table;
   (iv) the two-limiter distinction (§2E) stated wherever 429s are
   explained. Touch only lines that fail (i)–(iv).
5. **Post-deploy verification handover.** Hand §5's probe protocol to
   John's Tab as a single staged act (it is a production *write* — a mint —
   so it is never a fleet free-for-all): one probe mint, build pinned by
   direct `/api/version` read first, staggered never parallel, and
   explicitly **not** fired at a stale advertised Retry-After time
   (the keep-going Cluster B scheduling error to avoid repeating).
6. **Explicit non-goals / parked — do not build:**
   - No cap, window, keying, or PoW change (8/20/80/200, /24·/64, 12→16→20
     bits all stand; sizes are a design choice, L1 §"Operability remainder").
   - No test-identity provisioning / test-mint allowance — PARKED, owner
     Jill/product, trigger = next cohort-scale test wave (§2G).
   - No unparking of referral minting — reversing simplification decision
     #8 / issue #3218 is a product decision above this pack; the store mint
     stays untouched either way.
   - No new route, tool, error code, or table; no MCP access-request tools
     (separate piece, §1); no `/join` page a11y (bound #5055 owns the label
     leg; the focus-seizure sub-leg stays fenced to #5047); no human
     referral board/leaderboard work (`server/referrals.mjs` is read-only
     context here); no money, schema, or freeze-class work — nothing in
     this pack lands singly on those grounds, and fix lanes never merge.

## 5. Acceptance

The coordinator/Jill accepts from these checks alone. All test runs use
`TMPDIR=<lane-scratch>` and run **serially** (parallel local batches hit
SQLite errcode 778 at base and head alike — L1 report).

**Source checks (commands, landed tree via `git archive` of the landed SHA):**

```bash
grep -rn "mintBudget" server/agent-identities.mjs   # ≥1 hit (was 0 at aaa749065a)
grep -rn "earliest re-check" docs/openapi.yaml docs/ server/agent-discovery.mjs  # 0 hits
gh pr view 5061 --json state,mergedAt,mergeCommit   # MERGED, head chain recorded
```

**Executed suites (by name, all green at the landed head):**
`mint-retry-after-truth` (4/4) · `referral-invites` (incl. the new §4-step-3
pins) · `referral-mint-freeze` (410, zero rows, outstanding tokens live) ·
`referral-mint-idempotency` · `referrals` · `identity-mint-capacity` +
`mcp-identity-mint` (17/17 at #5061 head) · `identity-mint-pow-escalation` ·
`identity-mint-adaptive-pow` · `agent-discovery` · `docs-mcp-parity` ·
`mint-budget-docs` · `openapi-mint-429-docs` · `mint-429-skill-guidance` ·
`errors-catalog-drift` · `agent-error-hints` · `join-invite-retry` ·
`join-recoverable-first-room`. Plus `npm run verify:affected` exit 0, and
`CI=1 npm run check` if any `server/**` file changed (step 3's contingency
cure only).

**Behavioural probes (executed against a local store, kernel-style as L1):**
for each of the four spending doors, force the network tier and assert
header == body `retryAfterSeconds` == `mintBudget.retryAfterSeconds`,
`mintBudget.scope` = the network tier, and refusal at t0+advertised+1 s
**succeeds only when** the oldest counted mint has aged out — i.e. the
advertised value now predicts the outcome (the exact L1 repro, inverted).
Assert the parked mint returns 410 with zero new `referral_invites` rows,
and the §4-step-3 survival pins hold.

**Production probe (John's Tab, once, post-deploy):** pin the build by a
direct `/api/version` read; fire **one** mint; if 201, stop (pool open —
record it, no journey follows from this pack); if 429, the response must
carry `mintBudget` with a numeric `retryAfterSeconds` — the field whose
absence is the §2A evidence. No second probe inside the advertised window.

**Registration sweep (per ~/AGENTS.md "Pre-flight registration sweep"):**
- Runtime-package closure — n/a: no new/newly-imported `server/**` module.
- Error-code catalogue, both copies — n/a: no new/removed code (`rate_limited`,
  `identity_mint_limited`, `proof_required`, `referral_invites_parked` are
  already catalogued at main); if step 3's contingency cure introduces a
  code, it becomes REQUIRED (catalog row + `scripts/skills-sync.mjs`).
- Route triple — n/a: no new route. The step-2 OpenAPI edit is an existing
  operation's text; it must still pass `openapi-mint-429-docs` +
  `docs-mcp-parity` (named above).
- Harness copy sets — n/a: no module imported by a copied/transformed
  harness is touched.
- Store registries — n/a: no new table (writer-fence / purge-registry /
  recovery-audit untouched; `referral_invites` is already registered in
  all three at main).
- Generated/mirrored artifacts — REQUIRED if any skill/packet file is
  touched in step 4: re-run `node scripts/skills-sync.mjs` and verify the
  `plugins/` mirror is byte-identical; CANDIDATE-MANIFEST — n/a unless a
  `src/**` client file is touched (none is instructed; touching one
  re-opens the #5047 fence — stop instead).
- Diff hygiene / close-out — REQUIRED: >300 changed lines needs the
  `## Large diff justification:` PR-body section (not expected here);
  close-out = `verify:affected` above plus the named suites.

## 6. Routing

**Implementer: Codex** (server/core) — steps 1–3 are limiter-adjacent test
and OpenAPI work in `server/` + `tests/` + `docs/openapi.yaml`, and Codex
holds the landing context for the bound queue this piece rides on. Step 4's
doc-packet lines, if any fall in client/packet surfaces Claude owns, split
to **Claude** as a named sub-hand, lines enumerated by the step-4 grep —
not a general docs rewrite.

**Landing: Grok Bot** (landing seat) — #5061 is already bound and
`ready-to-land` at its composed head; the seat lands it in the ordinary
queue (non-money, batchable per its binding note) and folds step 2 with
#5039 per the second-lander rule. **Jill's fleet** runs §5's source checks,
suites, and kernel probes as the acceptance read, and files any step-3
contingency cure — the fleet never merges. **John's Tab**: the single
post-deploy production probe (§5). **Fo**: not routed (no browser-shard
evidence in this piece; the {browser} red that touched #5061's binding is
already discharged, §2A).

**Handover channel:** `room_request_reply` to the exact member (Codex for
the build hand, Grok Bot for the landing hand) with a concrete ask, a
`workItemId`, and the expected result — for Codex: "§5 suites green at the
landed head + step-2/3 diffs filed as PR(s)"; for the seat: "#5061 landed
at its bound head, step-2 fold disposition named". Per the settled Codex
connection terms, that protocol does not wake an idle session — file the
ask and report it filed; do not claim dispatch.
