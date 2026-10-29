# Instruction pack — Record (planned typed object, redesign Phase 2)

## 1. The piece

**Record** is the room-native typed landing record: the single object that
qualifies one PR head for landing. It replaces the prose LAND-READY /
RECORD-MOVED room post, the hand-edited bindings-JSON entry, and the
records-directory file — three authored copies of one fact — with one
typed, seat-attributed, append-only object whose fields are data:
`{ id (lr_…), pr, headSha, baseSha, state, evidence[], flags[],
acceptingAuthority, createdBySeat, createdAt, landedAt?, mergedSha?,
treeSha? }` plus a verbatim human-readable `note`. Prose survives only
inside that `note` field — never as the record itself. This is Primitive 3
of the migration build order (Record → Verdict → Queue view →
Lease/Obligation → Approval) adopted in the redesign synthesis D-1
(`~/workspace/pr-redesign-2026-10-23/SYNTHESIS.md` §0, §1 D-1; design in
`e3-comms-substrate.md` §5.1 and §7 step M1).

**PAUSED — executable at unpause.** The redesign typed-object phase is
paused by the FOCUS-REVIEW verdict (`~/workspace/wave-2026-10-25-focus-review/SYNTHESIS.md`,
PAUSE table: "Redesign Phases 1+ substrate (D-1..D-15)", trigger =
P-1 Decision Queue experiment result). No implementer starts §4 until
both unpause conditions in §4 step 0 are on the record. This pack targets
a tree based on main `aaa749065a6451321a949ddcb923f3174504fe35` **or
later**; production runs build `ca37fee4` and is never the target.

**Verified against source: main `aaa749065a`**, read by `git archive` of
that SHA into this lane's scratch (deleted after filing). At that SHA the
piece does **not exist in product code** — verified, not assumed:

- No `server/landing-records.mjs`, `server/landing-record-sqlite.mjs`,
  or `server/routes/landing-records.mjs`; a tree-wide grep for
  `landing_record` / `landing-record` across `server/ src/ tests/ docs/
  scripts/` returns only one hit, the archived-work table row for #4551
  (`docs/ARCHIVED-WORK.md` line 383).
- The hosted MCP catalog snapshot at main (`tests/fixtures/mcp-catalog.snapshot.json`)
  contains none of the five landing-record tools; the full catalog pins
  at 122 tools (`tests/mcp-search-actions.test.js` line 51), reached
  without this piece.
- `STORE_SCHEMA_VERSION` is still `42` (`server/writer-fence.mjs` line 7).

What exists today in its place, verified at the same SHA:

| Function Record will own | Today's mechanism at `aaa749065a` |
|---|---|
| The landing record itself | Prose LAND-READY / RECORD-MOVED posts in muse-room + an entry in `~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json` (`prs{}` entries with `boundHead`, `recordMsgId`, prose `note`) + files in the coordinator records directory |
| Observed PR head (Record's supersede sweep input) | `server/land-queue.mjs` (1,221 lines): the `land_queue` table is the source of truth for `land.updated` events (`src/events.js` lines 112–114, 1513–1517) and already polls GitHub heads/CI |
| Precedent typed-object shape to mirror | Work claims: `server/work-claims.mjs` (explicit lifecycle table, lines 57–82), `server/work-claim-sqlite.mjs`, `server/routes/work-claims.mjs` + `server/work-claim-routes.mjs`, doors in parity (HTTP + hosted MCP) |
| The built-but-unlanded Record itself | PR **#4551** at head `41ee77151f00763fe34e42d3f2fa0f4de730d4f3` — see §2; its full diff (26 files, +1,578/−12) is still served by `gh pr diff 4551` and is the specification this pack resurrects |

Name collisions to ignore (verified by reading their heads at main):
`server/routes/record-rails.mjs` serves trial-task / spend private
records and `server/routes/verdict-inbox.mjs` is a read-only verdict
inbox — neither is this piece, and neither is touched by it.
`room_record_completion` / `room_record_verification` /
`room_record_handoff` are work-claim verbs, not Record.

**No JOHN fork is touched.** The verified-delivery vocabulary fork is
not in scope: Record's `evidence[]` carries a `verdict` entry only as an
opaque typed reference (a Verdict object id, stored unresolved, never
looked up — Verdict is a later primitive), so no tier wording is chosen
here. The sponsor-human-surface fork is untouched. One gate **is**
John's and is named as a stop, not a fork with branches: the freeze go
on the Record schema (§4 step 0/6) — synthesis §6 item 1 and the
FOCUS-REVIEW JOHN-GATED table both list "#4551 — Record-primitive
schema freeze disposition" as his.

## 2. Current state

**Executed evidence, cited — not re-derived:**

1. **The built Record died in the queue it was built to fix.** PR #4551
   (RECORD-PRIM) was bound FREEZE at head `41ee7715`, record `82d6a563`,
   archived binding note verbatim: "FREEZE — schema (Record primitive;
   schema 42 additive). LAND-READY record CLEAN at this head (no price);
   the freeze packet (freeze-packet-4551.md, REV-4551 SHIP 15/15…)
   qualifies this exact head. Landing waits on John's freeze go
   (Sitting #1 pack). On landing, the BUILD-VERDICT charter unlocks."
   (`landing-watch-bindings-archive.json`, entry `4551`.) It was then
   **closed unmerged 2026-10-25T20:05:06Z** (`gh pr view 4551`:
   `state=CLOSED, mergedAt=null`), its branch `jill/record-prim` is
   deleted (GitHub branch API returns 404), it now reports
   `mergeable=CONFLICTING`, and main itself records the disposition at
   `docs/ARCHIVED-WORK.md` line 383: "conflicts with main and is stale;
   idea recorded in docs/ARCHIVED-WORK.md". The FOCUS-REVIEW synthesis
   (PAUSE table) states the general fact: the redesign's "own vehicles
   (#4496/#4551) died in the queue it was built to fix".
2. **So today a landing record is still seven authored copies of one
   fact.** E3 §2 (duplication map, executed 2026-10-23): lane completion
   report, records-dir `src-<pr>.md`, muse-room post, bindings-JSON
   entry, pass results file, PR body, MEMORY.md queue line — "Seven
   copies, three of them hand-written, none of them a projection of
   another". E3 §3 specimens, all verified there: **S1** stale queue
   rows corrected only by the other fleet's human audit (room seq
   17680); **S2** records that exist only as room posts (bindings file
   holding null head/id by design); **S4** flags naming PRs with no
   entry; **S6** `recordMsgId` stored in two formats (8-char prefix and
   full UUID) for the same field; **S7** the hourly landing-watch
   refresh failing silently (EPERM, 2026-10-23 01:10) so the ledger
   looked current while stale.
3. **The hand-join is still the live cost.** Settle pass 21
   (`~/workspace/wave-2026-10-27-settle-pass-21/SYNTHESIS.md`, and
   MEMORY.md's queue line) dispositioned 259 bound records by exactly
   this machinery — prose room records re-read, bindings re-pointed by
   hand, RECORD-MOVED supersessions posted per head move. The system
   works; it consumes coordinator-days per pass and every head move
   voids a record and starts the join again.
4. **Downstream pieces are gated behind this one and know it.**
   FOCUS-REVIEW JOHN-GATED table: "BUILD-VERDICT / Verdict Inbox's real
   charter is gated behind this closed PR". Synthesis §3 Phase 2 makes
   the chain explicit: #4551 (John's go) → BUILD-VERDICT → Queue view →
   EVENT-LEDGER projections retire the bindings file and #3299-as-state
   after one full landing cycle of parity. None of that is this pack's
   work (§4 non-goals); all of it is blocked until this pack lands.
5. **What is NOT broken:** the land queue's observed-head data already
   exists and is trustworthy (`server/land-queue.mjs`, §1), so Record's
   head-binding sweep needs no new GitHub polling; the work-claim
   primitive already proves the room-native state-machine + dual-door
   pattern in production code at main. UNVERIFIED: whether any consumer
   outside the fleet (John's Tab, Codex coordinator) reads bindings-JSON
   fields beyond `boundHead`/`recordMsgId`/`note` — the resurrection in
   §4 must not change the bindings file at all, so this does not gate it.

## 3. What fantastic means

One PR's landing qualification is one object, created in one call,
readable identically through both doors, and mechanically incapable of
the S1/S2/S4/S6/S7 drift classes:

- **1 write, 1 home.** Creating a record is a single HTTP POST or a
  single MCP call (`room_create_landing_record`); the muse-room post,
  if any, is a human summary pointing at the `lr_…` id. The question
  "what may land, in what order, at which head" is answered by **1 list
  read** of land-ready records — 0 hand joins, against today's
  coordinator-day settle pass over 4 stores (E3 §8).
- **Head-binding is structural, not remembered.** Creating a record for
  a PR that already has a land-ready record at a different head
  supersedes the old record in the same transaction, linked both ways;
  the same head returns **409 `landing_record_exists`** with the
  existing record in `existing` — duplicates are impossible, not
  discouraged. Every operation sweeps first: a land-ready record whose
  head differs from the land queue's observed head for that PR reads
  `superseded` (persisted); with no observation, nothing is derived —
  no fabricated supersession.
- **Priced flags are data with an owner.** A record carrying flags
  cannot be created without `acceptingAuthority`; each flag names its
  own accepting authority, defaulting to the record's. Zero flagged
  records with an unnamed acceptor (today's rule lives in the emit
  tool's prose convention; here it is in the object).
- **Evidence is typed or it is not evidence.** `evidence[]` entries are
  typed links only (`suite | ci | verdict | link`); a `verdict` ref
  round-trips unresolved-but-typed. Free-text evidence strings are
  rejected at validation (422).
- **Authority is enforced at the state machine,** not the door only:
  land / revoke / supersede require the creator, the room owner, or a
  `decide` member (403 `landing_record_not_authority`); members only
  throughout (403 `not_member`); guest writes refused on the same chain
  as Claim's.
- **Cross-door byte-faithfulness:** a record written via HTTP reads
  byte-faithful via MCP and the reverse (`deepEqual` +
  `JSON.stringify` equality, transitions crossing doors) — the #4551
  specimen property, kept as the acceptance bar.
- **No write-path cost:** the table is additive and off the message
  write path; `bench:room` at the landing head shows no metric moving
  significantly vs base (the #4551 bench at its head: every metric
  `~`, no Holm-adjusted p < 0.05; write p50 head/base 1.01×, p95 1.00×).
- **A record lands nothing by itself.** The release seat still lands
  against it. Fantastic does not mean automated landing.

Exemplar worth matching: the in-repo work-claim primitive (§1) — one
explicit lifecycle table, one SQLite registry, both doors generated from
one state machine — and #4551's own 15-test specimen suite, which is
the shape of proof this pack re-earns at the new base.

## 4. The instruction

**Step 0 — Unpause gate (stop here until both are on the record).**
(a) The FOCUS-REVIEW pause trigger has fired — P-1 Decision Queue
experiment result filed and Jill has unpaused redesign Phase 2 on the
record; and (b) John's freeze go / #4551 disposition is given (synthesis
§6 item 1; this is schema + freeze-class work, his gate, reported as a
needed action — never assumed from silence, and silence on a directed
question is no answer). Before any act on the closed PR or its branch
name, file the pre-act journal entry
(`node ~/workspace/fleet-tools/pre-act-journal.mjs record --actor …
--act … --target … --reason …`, per AGENTS.md's bound-set protection
rule). If either condition is missing, return BLOCKED-unpause and stop.

**Step 1 — Recover the specification; do not flip-war the corpse.**
Retrieve the filed diff: `gh pr diff 4551 --repo Uuriko/project-room`
(the API still serves it; the branch is deleted and the PR is
closed-unmerged — do **not** reopen it and do not restore the branch at
`41ee7715` for landing). Create a fresh branch off the then-current
main (≥ `aaa749065a`; re-read the tip at start and name it in the PR
body), apply the diff, and resolve conflicts file by file against
current main. The 26 files of record are: `server/landing-records.mjs`
(state machine, 353 lines as filed), `server/landing-record-sqlite.mjs`
(registry), `server/routes/landing-records.mjs` (6 HTTP routes: list,
create, get-one, land, revoke, supersede over the 5 OpenAPI paths
`/api/rooms/{roomId}/landing-records[/{recordId}[/land|/revoke|/supersede]]`),
`server/routes/table.mjs`, `server/store.mjs`, `server/writer-fence.mjs`,
`server/purge-registry.mjs`, `server/mcp-hosted-tools.mjs`,
`server/mcp-room-profile.mjs`, `server/mcp-tool-contracts.mjs` (5 tools:
`room_create_landing_record`, `room_list_landing_records`,
`room_land_record`, `room_revoke_landing_record`,
`room_supersede_landing_record` — the four write tools in
`MCP_ROOM_WRITE_TOOLS`), `src/agent-error.mjs`, `src/room-mcp-join.js`,
`scripts/runtime-package.mjs`, `scripts/candidate-runtime-fixture.mjs`,
`scripts/recovery-coverage.mjs`, `docs/openapi.yaml`,
`skills/project-room/references/errors-catalog.md` +
`plugins/project-room/skills/project-room/references/errors-catalog.md`,
`tests/landing-records.test.js`, `tests/fixtures/mcp-catalog.snapshot.json`,
`tests/mcp-search-actions.test.js`, `tests/mcp-untrusted-content.test.js`,
`tests/mcp-openapi-drift.test.js`, `tests/errors-catalog-drift.test.js`,
`tests/recovery.test.js`, `tests/recovery-comparison.test.js`.
Known drift at `aaa749065a` — re-derive, never restore the filed numbers:
(i) the MCP catalog already pins at **122** without these tools, so the
landed count will be 122 + 5 = 127 only if nothing else moved —
regenerate the snapshot and set both count pins from the regenerated
actual; (ii) the filed recovery pin move (comparison 208→209) is stale
— recompute from `scripts/recovery-coverage.mjs` at your base;
(iii) `server/store.mjs`, `server/writer-fence.mjs` and
`server/routes/table.mjs` have moved since the Oct-23 base — the
additive table registration must merge into their current shapes, and
`STORE_SCHEMA_VERSION` stays **42** (the filed design is schema-42
additive: additive table + `verifySchema` partition, no version bump);
if your merge genuinely requires a bump, stop — that is a new schema
decision and returns to John's freeze gate.

**Step 2 — Re-verify every filed invariant against the merged result**
(the spec, from the #4551 body — all of it survives the resurrection or
the deviation is named in the PR body with a reason): object shape and
`lr_…` ids as in §1; state machine `land-ready → landed | revoked |
superseded` with terminal refusals; typed evidence only, `verdict`
refs unresolved; priced-flag authority rule; the three head-binding
mechanisms (op-sweep derivation from the land queue's observed head,
create-replacement supersede in one transaction linked both ways,
explicit supersede verb); land carrying `mergedSha`/`treeSha`;
authority = creator / room owner / `decide` member; members-only fence
and the Claim route chain including the guest write refusal; the five
error codes `invalid_landing_record`, `landing_record_not_found`,
`landing_record_closed`, `landing_record_exists`,
`landing_record_not_authority` in `src/agent-error.mjs` with
hint/next prose (the filed +15 i18n-growth declaration is re-measured
at the new base and re-declared, not copied).

**Step 3 — Registrations, all of them, in the same diff** (the filed PR
is the checklist; §5 names the sweep mapping): runtime-package closure
**and** candidate-runtime-fixture path list for both new server
modules; writer-fence additive list + `verifySchema` partition for
`landing_records`; purge-registry entry; recovery-coverage seed +
comparison pin; error catalogue in **both** copies via
`node scripts/skills-sync.mjs` (byte-identical mirror, never hand-edited
twice); OpenAPI operations + schemas as bare paths with a well-formed
`x-room-permission` marker on every mutating operation and a parity
note naming the MCP tool (`parity: "mcp:room_…_landing_record"`) on
every new route row in `server/routes/table.mjs`; MCP catalog snapshot
regenerated; the diff is >300 lines, so the
`## Large diff justification:` section goes in the PR body at filing
(one primitive landing whole — registrations trailing code is the
failure the sweep exists to catch).

**Step 4 — Specimen suite.** Port `tests/landing-records.test.js`
(15 tests as filed: registry round-trip; route-table parity; HTTP
create/read/filters; validation 422s; deactivated-member 401 at the
door and state-machine 403 `not_member`; verdict evidence ref
round-tripping unresolved-but-typed; priced-flag authority rules;
duplicate 409 + replacement supersede; land with `mergedSha`/`treeSha`
+ terminal refusals; creator/owner/decide authority; land-queue
head-move derivation — seeded observation supersedes, same head does
not; the five MCP tools end-to-end; cross-door byte-faithful specimen).
Every test must fail at base for the right reason (surface absent)
before it passes at head — state that check in the PR body.

**Step 5 — Bench.** `npm run bench:room -- --sizes 1000`, head vs
base, per the repo's bench discipline; PR body carries the table and
the no-significant-move verdict (§3).

**Step 6 — Freeze packet, price, land — singly, at exact head.**
Refresh the freeze packet against the new head (the filed
freeze-packet-4551.md / REV-4551 SHIP 15/15 qualifies the dead head
only). This is schema/freeze-class: it lands **singly**, green at the
**exact head** (Ruling 41 tree-SHA inheritance does not apply above the
schema line), only on John's freeze go at that head, by the release
seat — the author/fix lane never merges. Add the `ready-to-land` label
once (user or App token, never `GITHUB_TOKEN`) or the heavy CI reads as
designed-skipped.

**Step 7 — Post-land proof (same landing cycle).** After deploy,
John's Tab verifies production (§6): create → duplicate-409 →
replacement-supersede → land-against-record on one real PR in the
commons room through **both** doors. Only then is BUILD-VERDICT
unlocked (synthesis Phase 2) — unlocking is a note in the completion
record, not work in this pack.

**Explicit non-goals:** Verdict object (M2), Queue view (M3),
bindings-JSON demotion/kill, records-directory archive, #3299
projector, EVENT-LEDGER projections, Lease/Obligation/Approval, any
change to the bindings file or the settle-pass machinery, any client
(UI) surface, any change to `server/land-queue.mjs`'s polling, and any
resolution/lookup of `verdict` evidence refs.

## 5. Acceptance

Jill (or the coordinator) accepts from these checks alone, run at the
PR's exact head, each read at the source:

1. **Registration sweep clean:** `node ~/workspace/fleet-tools/registration-sweep.mjs --pr <n>`
   exits 0, no MISSING. Item mapping for this change: runtime-package
   closure — **REQUIRED** (2 new `server/**` modules + full import
   closure, both lists); error-code catalogue, both copies —
   **REQUIRED** (5 new codes, `skills-sync` mirror byte-identical,
   `tests/errors-catalog-drift.test.js` green); route triple —
   **REQUIRED** (6 routes: table + OpenAPI bare paths + quickstart,
   `x-room-permission` on mutating ops, parity notes naming the MCP
   tools); harness copy sets — **n/a** (no module imported by a test
   harness's copy/re-point set is added; sweep output is the evidence);
   store registries — **REQUIRED** (`landing_records`: writer-fence,
   purge registry, recovery-audit seed + comparison pin at the
   recomputed count); generated/mirrored artifacts — **REQUIRED**
   (MCP catalog snapshot regenerated + both count pins —
   `tests/mcp-search-actions.test.js` and
   `tests/mcp-untrusted-content.test.js` run **by name**, since
   `verify:affected` does not select them — plus the plugins errors
   mirror check).
2. **Specimen suite:** `node --test tests/landing-records.test.js` —
   15/15 green at head; and the base check: the same suite at base
   fails on surface-absent (POST create → 404; 0/5 tools in catalog).
3. **Close-out:** `npm run verify:affected` green, plus
   `CI=1 npm run check` green (the diff touches `server/**`; affected
   does not select check's secret-scan / generation-freshness stages).
   Any suite that cannot run locally is named in the PR body.
4. **Cross-door probe (executed, not inspected):** in a test room,
   create via HTTP → read via MCP → land via MCP → read via HTTP;
   `deepEqual` + `JSON.stringify` equality at each hop; duplicate
   create at the same head returns 409 with `existing`; replacement at
   a moved head supersedes the prior record linked both ways; a
   flagged create without `acceptingAuthority` is refused.
5. **Bench:** the §4 step 5 table is in the PR body; no metric moves
   significantly (Holm-adjusted p < 0.05 = failure).
6. **Landing discipline verified at the API:** PR state/head read via
   `gh pr view <n>` (two agreeing reads or one API read with the method
   named); labelled `ready-to-land`; hosted CI green at the exact
   head; John's freeze go for that head on the record; merged head ==
   bound head, read back after landing.
7. **Post-deploy:** §4 step 7's both-doors production sequence passes
   on the deployed build; the completion record names the deployed
   build SHA and the first real `lr_…` id created through the new door.

## 6. Routing

**Implementer: Codex** — server/core work (state machine, SQLite
registry, both doors, registrations) is his class, and the resurrection
needs exactly his merge-against-a-moved-main discipline. Handover
channel: **`room_request_reply`** in muse-room to Codex's seat, with a
concrete ask, a `workItemId`, and the expected result named as "one PR,
resurrected Record primitive, §5 acceptance green at its exact head,
freeze packet refreshed" — all Codex utilisation inside Project Room,
per the settled connection rule; the ask does not wake an idle session,
so it is posted when his seat is attended. **Landing: the release seat**
(Codex coordinator from John's Mac, the reviewed #4115 path) — singly,
at exact head, only on John's freeze go; Grok Bot's stack/slot seat
does not batch this PR (schema/freeze-class exclusion). **Verification:
Jill's fleet** runs §5 items 1–5 (settle/verify role; fix lanes never
merge) and files the completion record through the prose path one last
time for this piece. **Post-deploy: John's Tab** runs §5 item 7.
Charter budget note: the build is filed work being resurrected, not a
new build — price the lane as recovery + re-verification (E3 priced M1
at 0 lh build / seat landing only when the PR was live; the honest
price now is the step-1 conflict resolution plus steps 4–6, and the
lane reports at 50% if conflict resolution exceeds that).
