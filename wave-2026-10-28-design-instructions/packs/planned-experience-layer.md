# Instruction Pack — Planned Experience Layer (typed Decision / Fix / Pattern objects)

Slug: `planned-experience-layer` · Wave: `wave-2026-10-28-design-instructions`
Status: **EXECUTABLE-AT-UNPAUSE ONLY.** Do not start implementation until §1's trigger fires. This pack commissions no work today.

## 1. The piece

**What it is.** Project Room's memory layer: typed experience objects —
**Decision**, **Fix**, and **Pattern** — as siblings of the redesign's typed
event family (Claim / Record / Verdict / Lease / Ruling). Each object carries
(a) the lesson in one or two sentences, (b) provenance (room id, source
message/record ids, PR numbers and heads), and (c) **first-class outcome
links** — foreign keys, written at capture time, to the Verdict, landing, and
alive-after-7-days records that later judged it. Retrieval is by outcome rank,
inside a token budget, over MCP, keyed primarily on surfaces (PR, flag, file,
work item), so an agent joining a room inherits what the room's work *taught*,
not just what it produced. Receipts prove process; experience carries lessons.
The two layers stay distinct — an experience object is never a receipt and
must never be rendered as one.

Source of the design (read these two files first; they govern over this pack
where they conflict):

- Park record / decision of record: `~/workspace/pr-redesign-2026-10-23/EXPERIENCE-NODES-PARKED.md`
  — John, 2026-10-25, "Ok do it all", approving the sequenced recommendation.
- Fleet experiment report: `~/workspace/wave-2026-10-25-experience-pack/REPORT.md`
  (verdict PASS, 2026-10-26; see §2).
- Redesign context: `~/workspace/pr-redesign-2026-10-23/SYNTHESIS.md` §1 D-1
  (the typed family Claim/Record/Verdict/Lease/Ruling is the one typed event
  family; Option A room-native, Option C event discipline inside it) and §3
  (phase order).

**Trigger — BOTH legs must hold before any step in §4 starts (park record,
Trigger section):**

1. **Leg 1 — OPEN.** The redesign typed-object phase unpauses. Phases 1+ are
   PAUSED under the 2026-10-25 FOCUS-REVIEW pivot until the bound queue
   drains. The implementer must cite, in the PR body, the unpause record
   (room record id or synthesis file + date) that discharges this leg.
   No unpause record = do not start.
2. **Leg 2 — SATISFIED 2026-10-26.** The fleet-side experiment passed its
   pre-registered falsifier (see §2). No further experiment is owed.

**Where it lives (target tree: main `aaa749065a6451321a949ddcb923f3174504fe35`,
verified by `git archive` of that SHA into lane scratch on 2026-10-28 — the
shared clone `~/workspace/project-room` was NOT read as main):**

- Event vocabulary: `src/events.js` — `EVENT_TYPES` (frozen object, verified:
  it already contains the precursor vocabulary this layer builds beside, e.g.
  `DECISION_RECORDED: "decision.recorded"`, `VERIFICATION_RECORDED`,
  `OWNER_DECISION_RECORDED`, `WORK_CLAIM_UPDATED`, plus the reducer dispatch
  table and `WORK_CLAIM_EVENT_ACTIONS`). New experience event types are added
  here, nowhere else.
- Store / projection: `server/store.mjs` — verified `PILOT_LIMITS` at line 450:
  `projectionBytes: 4 * 1024 * 1024` (the 4 MiB hot per-room cap this piece
  must not inflate; enforcement `fail(409, "pilot_limit", …)` at line 3585 and
  in the invite/access paths). Rooms table = `(id, sequence, projection,
  archived_at)`; events table = `(room_id, sequence, id, body)` (line 1600-1601).
- **Architectural precedent to copy (verified in `src/events.js` comments):**
  the side-table pattern — `land_queue` table is the source of truth and
  `land.updated` is "the thin wake record"; `work_claims` table is the source
  of truth and `work_claim.updated` is "the thin room record";
  `dm_consents` side table with a thin sequenced event. Experience objects
  follow exactly this pattern (§4, Step 2).
- Archive discipline: `server/messages-store.mjs` (archived rows /
  `archiveRoomMessages` / `restoreArchivedMessages`, imported by
  `server/store.mjs`) and `server/operator-archive.mjs` — experience nodes
  live under this archive discipline from day one (park record, v1 scope).
- MCP surface: `server/mcp-hosted-tools.mjs` (hosted tool catalogue),
  `server/mcp-tool-contracts.mjs`, `server/mcp-action-search.mjs` — retrieval
  ships as an MCP tool first; any HTTP route is secondary (§4, Step 5).
- Routes, if any HTTP surface is added: `server/routes/table.mjs` (verified:
  imports e.g. `RECORD_RAIL_ROUTES` from `server/routes/record-rails.mjs` and
  `VERDICT_INBOX_ROUTES` from `server/routes/verdict-inbox.mjs` — the sibling
  typed-object surfaces to sit beside).
- Fleet reference implementation (read-side only, NOT product code, do not
  port wholesale): `~/workspace/fleet-tools/experience-pack.mjs` +
  `~/workspace/fleet-tools/experience-pack.test.mjs` (6/6 pass at report time).
  Its ranking tiers, flag semantics, and 4096-token default budget are the
  behavioural spec for §4 Steps 4-5.

**What does NOT exist today (verified at `aaa7490`):** no experience layer in
the product. `grep -ril "experience" server/` returns only
`server/opportunities.mjs` (a comment about "first-task experience"),
`server/public-assets.mjs`, `server/receipt-share.mjs` ("share text is the
whole experience"), and `server/wiki-read-api.mjs` (the read-only room-wiki
API, whose source doc `docs/ROOM-WIKI.md` is an append-only human "lessons"
log embedded at build time — related in spirit, **not** this layer: no typed
objects, no outcome links, no per-room capture, no MCP retrieval by rank).
Do not extend the wiki to fake this piece. Likewise the redesign typed family
itself (Claim/Record/Verdict/Lease/Ruling as product objects) is not yet the
landed substrate at this SHA — that is precisely why Leg 1 gates this pack.

**Bindings check (verified 2026-10-28):**
`grep -i "experience" ~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`
returns **zero hits** — no bound PR covers any part of this piece, so §4
duplicates nothing. The SPILL chain (#4900 → #4543 → #4265, bound) is a
dependency on storage headroom only, not a partial implementation; §4 is
written to be correct whether or not SPILL has landed, because it never
puts node bodies in the hot projection.

**Forks:** neither of John's two pending decisions is touched — (a) the
verified-delivery vocabulary fork: experience objects carry no delivery /
verification tier vocabulary, and §4 forbids adding any; (b) the sponsor
human surface: no human/sponsor surface is built. No FORK marker applies.

## 2. Current state

**Missing, by design (parked), with the evidence that it should be built
when unpaused:**

- **Fleet experiment PASSED — executed evidence on file.**
  `~/workspace/wave-2026-10-25-experience-pack/REPORT.md`, §"Falsifier
  verdict: PASS" and paired measurement table: pre-registered falsifier
  (≥30% fewer primary-source reads at equal-or-better correctness, fixed
  before data, threshold not softened); result **with-pack 48 reads vs
  without-pack 94 reads = −48.9%**, correctness **25/25 core fields in both
  arms**, 6 matched pairs / 12 fresh lane runs, read logs cross-checked
  against tool-call records, no GitHub 403/429 during runs. Per-task deltas
  ranged −36% (T4, FLAG-SPILL1) to −67% (T6, PR #4806).
- **Honest limit (same report, §"Input to the parked product item"):**
  the experiment proves halved re-derivation at equal correctness on
  state questions; it does **not** prove error rescue — both arms avoided
  every trap, at different cost. §3's numbers honour this: the product
  target is read reduction, never a correctness claim.
- **Three sharpenings the experiment imposes on the build (same section):**
  (1) value concentrated in *state questions* (what governs this surface,
  is it still current, what discharged that flag) → v1 retrieval keys on
  surfaces and current-state synthesis, not free-text search;
  (2) every false verdict found in pack development came from *outcome
  attribution* — outcome language near a surface that was not that
  surface's outcome (metric prose, conditions, merge-ups) → outcome links
  must be first-class fields written at capture time; outcome inference
  over prose afterwards is forbidden in v1;
  (3) crude decay flags carried the full load (SUPERSEDED/VOID exclusion,
  HEAD-MOVED warnings are what let lanes verify instead of re-derive) →
  v1 decay stays crude (§4, Step 3).
- **Park state:** `EXPERIENCE-NODES-PARKED.md`, Trigger section — Leg 2
  recorded SATISFIED 2026-10-26; "Leg 1 is still open; this item stays
  parked until both legs hold." Product build NOT chartered by that file;
  this pack is the executable instruction for when it is.
- **Storage pressure is real and current:** MEMORY gauge 2026-10-28 —
  largest room 1,433,781 B and growing ~303 KB/day, ~7.8 days to the
  3.8 MB BUY-TIME trigger at that rate. Any design that grows the hot
  projection per lesson learned is disqualified on arrival; §4 Step 2/6
  and §5's byte checks exist for this reason.
- **UNVERIFIED:** the exact schema/API shape the unpaused typed-object
  phase will land for Claim/Record/Verdict/Lease/Ruling (it does not exist
  at `aaa7490`). §4 Step 1 therefore starts with a re-verification pass
  against the unpaused tree, and §4's field lists are written against the
  park record + experiment, to be reconciled in that step — not assumed
  compatible.

## 3. What fantastic means

An agent joining a room asks, over MCP, "what governs PR #N / this flag /
this file?" and gets back, inside one 4,096-token pack, the room's
outcome-ranked lessons — each one or two sentences, each with provenance
and live outcome links — and verifies instead of re-deriving.

Concrete, measurable end state:

- **Effort:** on the experiment's own 6-task shape replayed against the
  product surface (§5, Check F), with-layer lanes use **≥30% fewer
  primary-source reads** than without-layer lanes at equal correctness
  (25/25-class scoring). Stretch target: reproduce the fleet result,
  **−48.9% (48 vs 94)**. No correctness-improvement claim is made or
  accepted.
- **Pack shape:** default budget **4,096 tokens** (fleet tool default,
  flag-configurable); every returned item carries kind, lesson (≤2
  sentences, enforced ≤560 chars), provenance ids, outcome tier, and
  decay flags inline; SUPERSEDED items are excluded from the body and
  named in a one-line appendix (fleet tool behaviour, REPORT §Tool).
- **Ranking (exact order, fleet tool spec):** landed-and-alive >
  landed > bound > settled-priced > filed — mapped onto product outcomes
  in §4 Step 4. A query with no relevant node returns an explicit empty
  pack, never prose-inferred filler.
- **Storage:** experience node bodies add **0 bytes** to the hot per-room
  projection. The projection carries at most a budgeted index: **top 10
  nodes per room, ≤8 KiB total serialised index bytes per room**
  (ids + tier + flags + lesson hash only — no lesson text). A room at
  the 4 MiB cap with 500 experience nodes still accepts writes; the
  `pilot_limit` 409 path is never triggered by experience data (§5,
  Check C).
- **Capture cost:** zero new paperwork surface. Nodes are captured only
  at the four existing capture points (claim completion, verdict,
  landing, alive check — park record, v1 scope). Capture is a side
  effect of those flows; no agent ever files a form to create a node.
- **Decay:** exactly three flags — SUPERSEDED, HEAD-MOVED, STALE
  (14 days without a reinforcing outcome). No curves, no posteriors,
  no graph index. A HEAD-MOVED node is visibly flagged in every pack
  that includes it, with cited vs current head.
- **Exemplar to match:** the fleet tool itself
  (`~/workspace/fleet-tools/experience-pack.mjs`, packs in
  `~/workspace/wave-2026-10-25-experience-pack/packs/pack-*.md`) — its
  output format (header with budget + exclusion count, per-surface
  best-outcome line, flagged items, void appendix) is the format bar
  for the MCP tool's text result.

## 4. The instruction

Target tree: the tree that exists **when Leg 1 discharges** (re-verify;
do not build against `aaa7490` blindly — it is the reference tree this
pack was verified against). Money semantics: none touched. This is a
schema-adding change (new side table + new event types): under Rules v2
it lands **singly, green at exact head**, freeze-class ceremony if the
typed-object phase's own landing rules say so — the implementer follows
the unpause charter on that point, not this pack.

**Step 0 — Gate check (before any code).** Cite the Leg-1 unpause record
in the draft PR body. If it cannot be cited, stop and report BLOCKED —
the park is Jill's/John's decision (John approved the sequence
2026-10-25), not the implementer's to override.

**Step 1 — Re-verify the substrate on the unpaused tree.** Read the
landed typed-object implementation for Claim/Record/Verdict/Lease/Ruling:
its event-type registration in `src/events.js`, its reducer/validation
shape, its id scheme, and how Verdict and landing/alive-check records are
identified. Write the reconciliation into the PR body: every place §4
Steps 2-5 assumed a name or shape, state the landed name it maps to.
If the typed family landed with a different capture-point mechanism than
the four in §3, use the landed mechanism and say so.

**Step 2 — Storage: side table + thin event, never projection bodies.**
Following the verified `work_claims` / `land_queue` / `dm_consents`
precedent (§1):

- New side table (name to reconcile in Step 1; working name
  `experience_nodes`): columns at minimum — `id` (typed-object id),
  `room_id`, `kind` (`decision` | `fix` | `pattern`), `lesson` (text,
  ≤560 chars, validated), `surface_keys` (PR numbers, flag names, file
  paths the node is keyed on — the retrieval keys from §2 sharpening 1),
  `provenance` (room message ids, record ids, PR numbers + cited heads),
  `outcome_links` (structured ids: verdict record id, landing record id
  / merged head, alive-check record id — nullable, filled as outcomes
  arrive, **never inferred from prose**), `outcome_tier` (derived, see
  Step 4), `flags` (Step 3), `superseded_by` (node id or null),
  `created_at`, `last_reinforced_at`.
- Register the table in every store registry the sweep requires (§5):
  writer-fence, purge registry, recovery audit; additive-sidecar
  partition in `verifySchema` if that is the landed pattern.
- Event types in `src/events.js` `EVENT_TYPES`: working names
  `experience.captured`, `experience.outcome_linked`,
  `experience.superseded` — thin events carrying node id, kind, room id,
  and outcome-link ids only. The reducer records **nothing of the lesson
  body into the projection**; at most it maintains the budgeted index
  (Step 6). Follow the `ACCESS_REQUESTED` / `REFERRAL_COMPLETED` comment
  pattern in `src/events.js`: state in the comment that the side table
  is the source of truth and the projection copy would go stale.
- Nodes are archive-discipline citizens from day one: when a room's
  messages archive via `server/messages-store.mjs`, node bodies follow
  the same store/restore path; restore must count nodes (event/row
  counts, not integrity-ok alone — fleet rule: count-verification
  certifies stores and restores).

**Step 3 — Decay, crude on purpose (park record, v1 scope — do not
improve).** Exactly: `SUPERSEDED` (a later node/record replaces it;
set only via an explicit supersede link, and superseded nodes are
excluded from pack bodies, listed in the appendix), `HEAD-MOVED` (a
head cited in provenance is no longer current — compare against the
binding/current head at read time, prefix-equality as in the fleet
tool), `STALE` (no reinforcing outcome in 14 days, from
`last_reinforced_at`). No other flags, scores, curves, posteriors,
drift detection, or graph index in v1. Each graduates only on a later,
separately chartered, measured need.

**Step 4 — Outcome tiering (derived, deterministic).** Tier is computed
from `outcome_links` + flags only, in this order (fleet tiers mapped to
product outcomes): `landed-and-alive` (landing link + alive-after-7-days
link present) > `landed` (landing link) > `bound` (a binding/LAND-READY
record link) > `settled-priced` (a priced settle record link) > `filed`
(capture only). Line-scoped/proximity/negation text heuristics from the
fleet tool are **not** ported — they existed only because fleet records
are prose; product nodes carry the links as fields (§2, sharpening 2).

**Step 5 — Capture points (existing flows only; no new surface).**
Hook capture as a side effect at: (1) claim completion, (2) verdict,
(3) landing, (4) alive check. At capture, the hook receives the lesson
text + provenance from the completing flow's own record — if a flow
cannot supply a one/two-sentence lesson and provenance ids, it captures
nothing (a missing node is acceptable; a fabricated lesson is a defect).
Outcome links are attached by the later flows (verdict/landing/alive)
matching on node id / surface key, via `experience.outcome_linked`.
Kind assignment: Decision = a choice with rationale that a later
verdict judged; Fix = a defect + cure pair; Pattern = a lesson asserted
across ≥2 surfaces. When in doubt, capture as Pattern — kind is a
retrieval hint, not a claim.

**Step 6 — Projection index budget (the 4 MiB constraint, hard).**
The hot projection may carry only an index entry per top-ranked node:
node id, kind, tier, flags, surface keys, lesson hash — **no lesson
text, no provenance bodies**. Cap: **top 10 per room, ≤8 KiB total**
serialised; eviction = lowest tier, then oldest `last_reinforced_at`.
Index maintenance must be O(index size), never O(node count), on the
write path. Reads of non-indexed nodes go to the side table.

**Step 7 — Retrieval: MCP tool first.** One MCP tool (working name
`experience_pack`) in `server/mcp-hosted-tools.mjs` +
`server/mcp-tool-contracts.mjs`: input = exactly one of {PR number,
flag name, file path, work-item id, topic string} + optional token
budget (default 4096). Behaviour: key on `surface_keys` first
(state-question shape, §2 sharpening 1); rank by Step 4 tier; exclude
SUPERSEDED from the body (one-line appendix); flag HEAD-MOVED / STALE
inline with cited-vs-current head; truncate to budget by dropping
lowest-tier items whole, never mid-lesson; empty result = explicit
empty pack. Output format matches the fleet exemplar (§3). An HTTP
read route is optional and, if added, is a thin wrapper over the same
function via `server/routes/table.mjs` — never a second ranking
implementation. No write tool is exposed over MCP in v1; capture is
server-side only (Step 5).

**Step 8 — Client.** No client surface in v1. No vanilla-JS page, no
room-UI panel. (If a later charter adds one, it follows the settled
vanilla-JS convergence constraint; it is out of scope here.)

**Explicit non-goals (park record + brief):** not a general memory
product; not a replacement for receipts, and nodes never render as
receipts or carry receipt/verdict vocabulary (including any
verified-delivery tier words — John's pending fork (a) is untouched);
no per-user personal memory — experience belongs to the room's work;
not the fleet's internal tooling (`experience-pack.mjs` stays fleet-side,
unchanged); no free-text semantic search, embeddings, or graph index
in v1; no sponsor or human-facing surface (fork (b) untouched); no new
paperwork/capture surface for agents; no backfill of historical lessons
from prose records (that is the outcome-attribution failure class, §2).

## 5. Acceptance

Coordinator/Jill runs these at the composed head; the lane passes the
pre-flight registration sweep itself before filing (AGENTS.md). All
checks are executed, none are by-eye.

- **Check A — Gate evidence.** PR body cites the Leg-1 unpause record
  (Step 0) and the Step 1 reconciliation table. Absent either: reject
  without running the rest.
- **Check B — Unit / contract suites.** New tests by name (implementer
  names them in the PR body; expected coverage): kind validation +
  560-char lesson cap; capture at each of the four points and
  capture-nothing-when-no-lesson; outcome-link attachment updates tier
  (filed → bound → landed → landed-and-alive transitions); SUPERSEDED
  exclusion + appendix; HEAD-MOVED flagging against a fixture bindings /
  current-head source; STALE flagging at the 14-day boundary (flag at
  14d+ε, none at 14d−ε); budget truncation drops whole lowest-tier
  items. Run: `CI=1 npm run check` (required — diff touches
  `server/**`) plus `npm run verify:affected`, plus the new suites by
  name. Green at exact head; Ruling 41 evidence discipline applies
  (schema-adding change: exact-head green, not tree-only).
- **Check C — Projection byte proof (the headline check).** Executed
  fixture: seed a room, capture 500 nodes with maximal lessons, then
  assert (1) serialised projection index for experience ≤8 KiB and
  ≤10 entries, (2) projection byte growth vs the no-experience control
  room ≤8 KiB, (3) no lesson text substring appears anywhere in the
  stored projection, (4) a room pre-filled to within 16 KiB of
  `PILOT_LIMITS.projectionBytes` (4,194,304) still captures nodes
  without a `pilot_limit` 409. Any failure = reject, no waivers.
- **Check D — Archive / restore count proof.** Archive the Check-C room
  and restore it; node row count and event count after restore equal
  the pre-archive counts exactly (counts, not integrity-ok — cf. the
  methods-audit restore defect, PR #5004's lesson). Mismatch = reject.
- **Check E — MCP catalogue discipline.** The new tool appears in the
  regenerated `tests/fixtures/mcp-catalog.snapshot.json` (regenerated
  in the same diff); count pins updated and passing by name:
  `tests/mcp-search-actions.test.js` and
  `tests/mcp-untrusted-content.test.js` (verify:affected does not select
  them — run both explicitly). Node lesson text is untrusted content:
  a lesson containing instruction-shaped text is returned as data,
  escaped per the untrusted-content contract, never surfaced as a
  system/tool instruction.
- **Check F — Value replay (the experiment, product form).** Replay
  three of the experiment's task shapes (one settle-state, one
  flag-discharge, one record-governs question) as matched pairs against
  the product tool, using the method in
  `~/workspace/wave-2026-10-25-experience-pack/REPORT.md`: with-tool
  reads ≥30% fewer than without-tool at equal correctness, scored
  against ground truth established before the runs. Below 30% or any
  correctness regression = the build does not land as v1; report the
  numbers, do not soften the threshold after seeing data.
- **Check G — No-attribution-by-prose grep.** `grep` the diff for any
  code path that derives tier/outcome from lesson or message text
  (regex/keyword outcome matching over prose). Any hit = reject per
  §2 sharpening 2; tiers come from `outcome_links` fields only.

**Registration sweep (AGENTS.md "Pre-flight registration sweep") —
run `node ~/workspace/fleet-tools/registration-sweep.mjs --pr <n>`
(or `--range` form) and attach the output; MISSING blocks handoff:**

1. Runtime-package closure — **REQUIRED.** New `server/**` module(s)
   go into `scripts/runtime-package.mjs` allowlist including full
   import closure AND `scripts/candidate-runtime-fixture.mjs`; verify
   with the closure test.
2. Error-code catalogue, both copies — **REQUIRED if** any new error
   code is introduced (e.g. a lesson-validation refusal): row in
   `skills/project-room/references/errors-catalog.md`, then
   `node scripts/skills-sync.mjs` so the `plugins/` mirror is
   byte-identical. If no new code: mark n/a — no new refusal shape.
3. Route triple — **REQUIRED only if** the optional HTTP route (Step 7)
   is built: row in `server/routes/table.mjs`, legacy-allowlist +
   routes if on the legacy chain, `docs/openapi.yaml` operation +
   bare-path quickstart example, well-formed `x-room-permission`
   marker, parity note `parity: "mcp:experience_pack"`. MCP-only v1:
   n/a — no new route.
4. Harness copy sets — **REQUIRED if** any new module is imported by
   anything a test harness copies/transforms; wire it into that
   harness's copy/re-point set, else n/a — no harness imports it.
5. Store registries — **REQUIRED.** New `experience_nodes` table:
   writer-fence + purge-registry + recovery-audit registration;
   additive sidecar partitions in `verifySchema` (Step 2).
6. Generated/mirrored artifacts — **REQUIRED.** EVENT_TYPES growth
   re-sizes EVENT_CATALOG + `webhook_subscribe` inputSchema →
   regenerate `tests/fixtures/mcp-catalog.snapshot.json` in the same
   diff; MCP catalogue growth moves the COUNT PINS in
   `tests/mcp-search-actions.test.js` +
   `tests/mcp-untrusted-content.test.js` (run both by name, Check E).
7. Diff hygiene — if >300 changed lines, the PR body carries the
   `## Large diff justification:` section at filing.
8. Close-out — `npm run verify:affected` + named registration suites +
   `CI=1 npm run check` (diff touches `server/**`); any suite that
   cannot run locally is NAMED in the PR body.
9. Refusal-shape step — n/a if no error code is removed/remapped; if
   Check/Step work remaps one, grep the test tree at head for
   old-shape pins and report as REQUIRED-review evidence.

## 6. Routing

- **Implementer: Codex** — this is server/core work (store, event
  vocabulary, MCP catalogue) and Codex owns server/core; all Codex
  utilisation happens inside Project Room. Handover channel:
  `room_request_reply` to Codex's exact member, with a concrete ask,
  a `workItemId`, and the expected result named as "PR filed at exact
  head, sweep output + Checks B-G evidence attached, fix lane — never
  merges". Note the channel's settled limit: it does not wake an idle
  session; Jill posts the ask and reports it as posted, not delivered.
- **Landing seat: Grok Bot** (with John's Tab) — schema-adding change,
  lands singly under Rules v2 / the unpause charter's ceremony, green
  at exact head. Jill's fleet never merges.
- **Verification support: Jill's fleet** — runs §5 Checks C, D, and F
  independently of the implementer's own evidence (verify-at-source;
  delivered output is a surface to verify, never a fact), plus the
  registration-sweep readback.
- **Post-deploy verification: John's Tab** — one live MCP
  `experience_pack` query against a production room with known nodes,
  confirming tier/flag rendering on the deployed build (name the build
  SHA in the report; production and main have diverged before).
- **Not routed to:** Claude (no client surface in v1 — Step 8), Fo
  (no browser-shard surface; call Fo only if Check B's browser shard
  is named red and needs evidence triage).
- **Sequencing note for the coordinator:** this pack is filed now and
  executed only at unpause. On unpause, re-run the bindings check in
  §1 before dispatch — if a typed-object-phase PR has by then covered
  any step above, re-scope §4 to what remains rather than duplicating it.
