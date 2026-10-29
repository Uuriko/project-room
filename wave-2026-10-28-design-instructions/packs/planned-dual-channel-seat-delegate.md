# Instruction Pack — Planned Dual-Channel Landing Experiment + Seat-Delegate-1

Slug: `planned-dual-channel-seat-delegate`
Decisions of record: D-1 (DUAL-CHANNEL LANDING chartered) and D-2 (SEAT-DELEGATE-1, phased) in `~/workspace/pr-redesign-2026-10-23/SYNTHESIS.md` §1.
Design sources: E15 §7 (`e15-rebuild-options.md`), E4 §5–§6 (`e4-release-seat.md`), E1 batch windows (`e1-flow-latency.md`), E11 Import 1 MQ-SEMANTICS-1 (`e11-alternatives.md` §5).
Status: **PLANNED / PAUSED — executable at unpause only. Do not start either experiment until §4 Step 0's unpause gate passes.**

---

## 1. The piece

Two linked, pre-registered experiments about the landing channel — not product features for room users. Together they answer: (a) is the fleet's delivery failure the substrate or the last hop into a session-shaped consumer, and (b) can machine-verifiable landings be minted without the single human seat, without moving any of John's reserved gates?

### 1a. DUAL-CHANNEL LANDING (D-1 / E15 §7)

One real landing wave run on two substrates at once:

- Channel A (control, authoritative): today's room path — room objects (Claim / Record / Verdict / Lease as they exist at run time), coordination thread #3299, `landing-watch-bindings.json` at `~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`, and Jill's WAKE-S6 re-pack (B1) as the room-path delivery control.
- Channel C (experimental): a typed event log dual-written beside the room objects for that wave's Record / Verdict / Lease lifecycle, plus exactly two consumers: (1) a GitHub projector posting the wave's LAND_RECORD / status from events; (2) a Codex-host subscriber prototype — the smallest script on Codex's Mac that long-polls the feed and surfaces new directed events, offered as the actual-host journey Codex specified (room seq 17371 / 17501 / 17629 in E15 §7's citation).
- The dual-write and feed are Option C phases 0–1/2. They are kept under either verdict; C phases 2–3 (external consumers first-class, log as standalone service) exist **only** if the experiment promotes them (SYNTHESIS §4 kill list).

### 1b. SEAT-DELEGATE-1 (D-2 / E4 §5–§6)

Delegated, policy-scoped minting of the `room/release-lease` commit status, in three phases:

- Phase 0 — Identity: per-fleet GitHub Apps; the coordinator App is the only identity permitted to post `room/release-lease`. Creation + private-key custody is John's act (SYNTHESIS §6 item 2).
- Phase 1 — Batch windows, no new identity required: pre-authorised Rules v2 batch windows under the existing checks, one lease minted per batch (not per sitting), batches ≤5 non-money PRs (default K=4), money / shared-core / schema land singly. This is E1's batch-window mechanism.
- Phase 2 — Productised gate: the #4115 coordinator gate logic as versioned repo tooling on a hosted runner, parity-proven against the Mac coordinator, executing MQ-SEMANTICS-1 (speculative composed head → one CI pass at the composed head → green batch lands as a unit; red batch auto-bisects, ejects the failing leg with the failing check named on its record, remainder re-composes without human touch; stack order is a composition constraint).
- Always, from day one of delegation: a Policy Record (classes, breaker rules, digest cadence), a circuit breaker, and a daily audit digest anchored on LAND_RECORDs. Money, shared-core singletons, freeze class, FLAG-held PRs, out-of-order stack members, and any record with an unpriced failure are **never** delegable.

### Where it lives — verified against main `aaa749065a6451321a949ddcb923f3174504fe35`

Tree read for this pack: **main `aaa749065a6451321a949ddcb923f3174504fe35`** (commit read via `gh api repos/Uuriko/project-room/commits/aaa749065a…`: 2026-10-28T08:00:07Z, merge of PR #5143). Production (`ca37fee4` per the wave brief) is **not** the target tree for either experiment; both target main at the unpause head, re-verified in §4 Step 0.

Verified at that SHA / live API on 2026-10-28:

| Fact | Evidence |
|---|---|
| Branch protection requires exactly one context, `room/release-lease`, `enforce_admins: true`, 0 required approving reviews | `gh api repos/Uuriko/project-room/branches/main/protection` |
| `room/release-lease` is a commit status posted by the landing coordinator, not a workflow job | `docs/RELEASE-MERGE-GATE.md` at `aaa749065a`, §"Checks that report" |
| Heavy PR CI is label-gated: non-draft + `ready-to-land`, label added once with a user token or GitHub App installation token, never `GITHUB_TOKEN` | Same doc; MEMORY.md CI label gate (PR #4813) |
| An in-repo room merge-slot queue already exists: `server/merge-queue.mjs` (phase 1, pure state machine, 15-min slot leases), `scripts/merge-queue-worker.mjs`, `scripts/merge-queue-dryrun.mjs`, `scripts/merge-queue-receipt.mjs`, `client/room-land.mjs` (RoomLandClient), `tests/merge-queue.test.js` | Git tree at `aaa749065a` (recursive tree read) |
| Fleet-side landing tool exists outside the repo: `~/workspace/fleet-tools/land.mjs` + `README-land.md` (MERGE-SLOT claim on #3299, pins exact heads, verifies `test`/`contract`/`lint`/`browser`/`cloudflare` SUCCESS at exact head, merges serially, post-merge main watch) and `~/workspace/fleet-tools/gh-app-token.mjs` + `README-gh-app-token.md` (App installation-token helper, built 2026-10-20, opt-in) | Fleet-tools files read for this pack |
| No dual-write event log, no GitHub projector from events, no Codex-host feed subscriber, and no delegated lease minter exist in the tree | Tree grep at `aaa749065a` for `release-lease` / `event-ledger` / `delegate` / `projector` returned only the merge-queue, verdict-inbox, record-rails and owner-delegates surfaces above — **the two experiments themselves are UNBUILT** |

Explicit non-duplication warnings (implementer: read these before designing anything):

1. **Do not rebuild the in-repo merge-slot queue.** `server/merge-queue.mjs` is a room-coordinated slot queue, not MQ-SEMANTICS-1 (no speculative composed head, no bisect/eject) and not a lease minter. SEAT-DELEGATE Phase 2 composes with it / the coordinator path; it does not replace it without a named supersession record.
2. **Do not touch PR #4951.** #4951 (`e01eb2d4f`, OPEN, "Land green ready-to-land pull requests and deploy main hourly", verified via `gh pr view 4951` for this pack) carries a review hold in MEMORY.md (2026-10-26): it must not land until John explicitly chooses its settings change, because its ruleset would re-add required checks John removed on 19 Oct and omits `room/release-lease`. It is not the delegate, not a vehicle for either experiment, and no step below enqueues, labels, or lands it.
3. **GitHub native merge queue is not available** as the vehicle: SYNTHESIS §2 C-8 — GitHub documents merge queue for org-owned public repos or Enterprise-Cloud private repos; `Uuriko/project-room` is a personal-account repo. MQ-SEMANTICS-1 is the semantics imported into the coordinator path, not the native feature.

**Pause statement (required by the wave brief):** the redesign typed-object phase is PAUSED (FOCUS-REVIEW, `~/workspace/wave-2026-10-25-focus-review/SYNTHESIS.md`: "Redesign Phases 1+ substrate (D-1..D-15)" PAUSED, trigger named there as P-1's experiment result). This pack is written executable-at-unpause. Every date in the original charters that has passed (notably SEAT-DELEGATE-1's parity kill date 2026-11-06) is **lapsed, not waived** — §4 Step 0 re-dates it on the record before any build starts.

---

## 2. Current state

### What is broken / missing, with executed evidence

1. **The seat is a single point and the queue waits on it.** SYNTHESIS §0/§7: "the fleet builds fast and lands slowly"; "the release seat remains a single point until Phase 3 lands". Current scale: settle pass 21 (`~/workspace/wave-2026-10-27-settle-pass-21/SYNTHESIS.md` §queue state) — 259 bound records, 246 OPEN at bound head, 5 MERGED, 3 CLOSED-UNMERGED anomalies, 4 OPEN with records VOID from head moves. The constraint named there is seat cadence, not fleet readiness.
2. **The original prerequisite vehicles are dead — the D-1/D-2 sequence cannot be run as literally written in 2026-10-23.** Verified via `gh pr view` for this pack:
   - PR #4551 (RECORD-PRIM, Record primitive) — CLOSED, `mergedAt: null`, closed 2026-10-25T20:05:06Z, head `41ee77151f`. D-1 says the experiment "runs on the first landing wave after the Verdict build lands" and SYNTHESIS §3 Phase 2 chains #4551 → BUILD-VERDICT → Queue view → experiment. That chain has no live vehicle.
   - PR #4496 (CLAIM-PRIM, Claim primitive) — CLOSED, `mergedAt: null`, closed 2026-10-25T20:03:22Z, head `67c1281298`. E11 CLAIM-LEASE-1 and parts of the typed-object substrate depended on it.
   - PR #4115 (release-pause / landing status, the gate SEAT-DELEGATE Phase 2 productises) — CLOSED, `mergedAt: null`, closed 2026-10-25T19:55:21Z, head `f869d79cd61e8cdc8d4a2e23a615db1266f79615`. Its content is recoverable at that head; it is **not** on main. FOCUS-REVIEW confirms the pattern: the redesign's "own vehicles (#4496/#4551) died in the queue it was built to fix".
   - Consequence: any implementer who starts from the SYNTHESIS §3 order without re-founding these three will build on air. §4 Step 0 is therefore a hard gate, not paperwork.
3. **There is no second channel, so the substrate-vs-session-hop question is unanswerable today.** E15 §7: A4's forensics point at the last hop "but cannot prove it, because today there is no second channel to compare against". D-7 / SYNTHESIS §7: WAKE-S6 remains open — delivery into an attended-but-idle Codex session is unproven, explicitly **not** cited as a product defect. UNVERIFIED beyond that: whether Codex will run a host subscriber at all in the experiment window — that is an experiment input to secure in §4 Step 0, not an assumption.
4. **All landing acts are unattributable under one shared login, and the rate pool is shared.** E4 §4 Option D / §5 layer 1: per-fleet Apps are "the attribution fix the fleet has needed since the Oct 18 unattributable protection change" and end "the shared-pool 429 coupling". The token helper is built (`gh-app-token.mjs`, 16 fixture tests per its README); **whether any fleet GitHub App has actually been created and installed is UNVERIFIED in this pack** — no App ID / installation read was performed, and creation + key custody is John's reserved act (SYNTHESIS §6 item 2). Treat Phase 0 as not started until §5's App-identity check passes.
5. **Lease semantics today are human-witness semantics.** E4 §2–§3: a delegated mint must mean "policy engine verified the record discipline for this head", never "a human saw this", and the status description must carry record id + minting identity so the two meanings are never confused in the journal. No Policy Record, breaker, or audit digest exists today — UNBUILT (no such artefact found in the tree read or in `~/workspace/fleet-tools/` listing for this pack).
6. **Evidence decay is the cost the experiments must not re-create.** D-12 / Ruling 41 (SYNTHESIS §1): below the money line, verdicts bind to tree SHA and a tree-identical merge-up inherits evidence; E1 measured ~2,900 CI runs burned re-proving unchanged content. Money / shared-core / schema keep exact-head ceremony. Both experiments inherit this in full (§4, settled constraints).

### What is NOT broken (do not "fix")

- The five protection contexts and the label gate work as documented in `docs/RELEASE-MERGE-GATE.md`; an unlabeled PR's heavy jobs reporting `skipped` in 1–2s is by design (PR #4813), not a failure to cure in either experiment.
- The in-repo merge-slot queue (§1) and `land.mjs` work as their READMEs describe; neither experiment is a bug-fix for them.

---

## 3. What fantastic means

### Dual-Channel — user-visible end state

A coordinator runs one landing wave and, at wave close, files **one verdict that settles the architecture** — no follow-up wave is needed to interpret it:

- Every directed event in the wave (15–25 records) has a per-channel delivery record: sent, acked-by-Codex-host-unattended or not, ack latency. Nobody reconstructs delivery from chat or thread scrollback.
- The GitHub projection and the room agree, or every divergence is enumerated event-by-event. Zero unexplained divergences is the bar (E15 §7 internal leg).
- Coordinator time is a number, not an impression: minutes per landing per channel, compared against the settle-pass baseline measured the same way.

Numbers that prove it (pre-registered in E15 §7 — do not move them after the run):

| Measure | Bar / decision use |
|---|---|
| Unattended delivery rate per channel | Any rate on the feed that the room path does **not** achieve → substrate was the failure → promote C (fund phases 2–3, external consumers first-class) |
| Identical failure at the session hop on both channels | Events delivered, acked by nobody until a human attends the session → substrate exonerated → A is final; C phases 2–3 deleted by name; effort redirected to a session-injection mechanism or to scheduling attended Codex sessions like meetings |
| Coordinator minutes per landing, feed+projector vs room-only | ≥30% reduction against the settle-pass measured rate **and** zero unexplained divergences → phases 0–2 kept permanently even under an A verdict |
| State-divergence count (log vs room objects vs GitHub projection) | 0 unexplained; every explained divergence names its event id |
| Lease-mint latency (human seat vs the wave's one policy-minted test lease, ordinary tier) | Reported as measured; no bar pre-registered in E15 — do not invent one post-hoc |

### Seat-Delegate-1 — user-visible end state

John and the coordinator stop being the landing clock for mechanical work, and can prove that is safe:

- A small-change-tier PR or a priced non-money batch ≤5 lands at machine pace: record + exact head + hosted-green + no holds/flags + stack order satisfied are all re-read at the API by the bot at mint time (E4 §5 layer 3); the lease on the head names the bot/App identity and the record id.
- A money, shared-core, freeze, FLAG-held, out-of-order, or unpriced-failure PR is **refused** by the delegate, every time, and lands only through the human seat (with a named deputy rota on the Queue view, so the gated path no longer has one person's availability as its service level).
- Every delegated mint is journaled in-room as a LAND_RECORD with the grant + record + head triple; a daily audit digest posts to the room; any post-land check failure or audit specimen miss suspends delegation automatically until coordinator review (E4 §4A/§4E: two specimen misses or one post-land failure trip the breaker; tier escape already suspends the tier pending a /correct pass).
- Three independent halts exist and are drilled: policy flag off, App disabled GitHub-side, protection context re-pinned — the first two executable in under a minute, none requiring the seat's laptop (E4 §3 principle 4).
- Net effect priced in E4 §5: the non-money, non-shared-core stock becomes landable at machine pace under audit; the money/shared-core/freeze singles keep the seat's witness — "a load the seat can actually carry".

Exemplar worth matching (named in the sources): GitHub's own merge-queue semantics as documented for `merge_group` (speculative composition, eject-and-rebuild) and Uber's SubmitQueue shape (speculate / batch / bisect), both cited in E11 §5 Import 1 — matched in **semantics inside the coordinator path**, not by adopting the native feature (unavailable, §1 warning 3).

---

## 4. The instruction

**Settled constraints for both experiments (honour, never relitigate):** Rules v2 + Ruling 41 evidence discipline (tree-SHA binding below the money line; exact-head for money/shared-core/schema); money/shared-core/schema land singly, green at exact head; fix lanes never merge; pre-act journal entry before any bound-PR close, bound-branch delete, labelled-run cancel, or production deploy (AGENTS.md Rules v2, adopted 2026-10-25); a 429 anywhere is a fleet-wide stop; never `git stash`; TMPDIR / scratch discipline with a `STATE.md` per lane; heavy CI only on non-draft PRs carrying `ready-to-land` (added once, with a user/App token, never `GITHUB_TOKEN`); no writes to production, ever, in either experiment's setup. Neither experiment touches the two pending John forks in the wave brief (verified-delivery vocabulary; sponsor human surface) — no fork is present in this piece.

### Step 0 — Unpause gate (coordinator/Jill act; BLOCKS everything below)

Do all of these, in order, and file the result as the experiment's opening record in the coordination room. If any item fails, stop and return BLOCKED with that item named — do not substitute a new vehicle silently.

0.1. Confirm the FOCUS-REVIEW pause trigger has fired or that Jill lifts the pause for this piece on the record (pause entry: `~/workspace/wave-2026-10-25-focus-review/SYNTHESIS.md`, PAUSE table, trigger "P-1's experiment result"). Record which.
0.2. Re-verify at the then-current main head (do not reuse `aaa749065a` if main has moved): protection contexts, `docs/RELEASE-MERGE-GATE.md`, the in-repo merge-slot queue files listed in §1, and PR #4951's hold status. Any change to the §1 table is written into the opening record as a delta.
0.3. Re-found or formally waive each dead prerequisite, by name:
   - #4551 / Record + BUILD-VERDICT + Queue view (D-1's stated predecessor chain): either a live successor vehicle is named (PR number + head), or Jill records that the experiment's "Record/Verdict/Lease lifecycle" is the lifecycle **as it exists at unpause** (bindings + LAND_RECORDs + lease statuses) and the dual-write instruments that. The experiment may not wait indefinitely for a typed-object rebuild that is itself paused.
   - #4496 / Claim: same treatment, only insofar as a step below names Claim events.
   - #4115 head `f869d79cd61e8cdc8d4a2e23a615db1266f79615`: confirm the branch content is still retrievable (`gh pr view 4115` / git fetch of that SHA). If it is not, SEAT-DELEGATE Phase 2's base becomes "the current coordinator process as operated by the seat, re-derived and written down with the seat as reviewer" and the budget in Step D2 is re-priced before starting.
0.4. Secure the two human inputs, in writing, before building:
   - Codex's agreement to run the host subscriber prototype in an attended-arranged window for one landing wave, via `room_request_reply` with a workItemId and the expected result named (see §6). No agreement → Dual-Channel's external leg cannot run; file BLOCKED-codex-window, do not fake the leg with a Jill-side consumer (E11 CLAIM-LEASE kill language applies by analogy: mark the cross-fleet leg BLOCKED rather than faking it).
   - John's Phase 0 act for SEAT-DELEGATE (App creation + key custody, §6 / Step D1) — or Jill's recorded decision to run Phase 1 (batch windows, no new identity) first, which D-2 explicitly permits.
0.5. Re-date the kill criteria: SEAT-DELEGATE parity kill = **unpause date + 14 days** (the original 2026-11-06 date in E4 §6 has lapsed); Dual-Channel wave window = the first landing wave of ≥15 records after Step 0 passes. Write both dates into the opening record.
0.6. Take the one-line claims on #3299 for both experiments and open each lane's `STATE.md` in its named scratch dir (`~/workspace/dual-channel-landing-scratch/`, `~/workspace/seat-delegate-1-scratch/`; E4 §6 already names the second).

### Part A — DUAL-CHANNEL LANDING (budget 6–9 lh, inside Option A's build order; E15 §7)

A1. **Dual-write (C phases 0–1 slice).** For the experiment wave only, every Record / Verdict / Lease lifecycle transition (as re-founded in Step 0.3) appends a typed event to a new log store beside the room objects. The room path remains authoritative throughout; the log never gates a landing. Event shape: minimal typed family — event id, type, record/PR id, head SHA (and tree SHA, for Ruling 41), actor, timestamp, prior-state → next-state. Reuse the existing event/store patterns in `server/` at the unpause head; do not introduce a second store engine. Scope the dual-write behind a flag/config so it can be switched off without a revert.
A2. **GitHub projector (consumer 1 of 2 — build no others).** A projector reads the log and posts the wave's LAND_RECORD / status to GitHub (PR comment or status, matching the form the coordinator uses today for that artefact — match it exactly, do not invent a second format). It must be idempotent per event id: re-running it over the same log posts nothing twice.
A3. **Codex-host subscriber prototype (consumer 2 of 2).** The smallest long-poll consumer Codex's side can run on his Mac: poll the feed endpoint/log read, surface each new directed event locally, and emit an ack carrying the event id when it surfaces it — unattended (no human driving his session) is the property being measured, so the ack must be emitted by the script, not by Codex typing. Offer it exactly as the actual-host journey he specified; Jill's WAKE-S6 re-pack (B1) runs as the room-path control in the same wave.
A4. **Feed read surface.** Expose the log to the two consumers through one read path (route or script — implementer's choice, justified in the PR body). If it is a new HTTP route, the full route triple in §5 applies. Authenticate both consumers; no public feed.
A5. **Run one real wave.** The next landing wave of 15–25 records after Step 0, both channels live for the whole wave, under today's discipline (the seat still lands; the experiment observes and projects, it does not land). Include in the wave exactly one policy-minted test lease on the ordinary tier if — and only if — SEAT-DELEGATE Phase 1/2 has produced a minter by then; otherwise record lease-mint latency as human-only and drop that measure, do not delay the wave for it.
A6. **Measure, exactly as pre-registered in §3:** unattended delivery rate per channel; Codex ack latency per channel; coordinator minutes per landing per channel (time the coordinator's landing work during the wave; baseline = the settle-pass rate measured the same way — name the pass and the number in the report); state-divergence count across log / room objects / GitHub projection, each divergence explained event-by-event or counted unexplained; lease-mint latency if A5's condition held.
A7. **Verdict and disposal, in the same filing.** Apply the §3 decision rule literally and file which branch fired. Then execute the branch's disposal in the same wave-close: promote C (charter phases 2–3 as a new, separately budgeted programme — not built in this pack) **or** delete C phases 2–3 by name in the redesign record and redirect the effort as E15 directs; and independently, keep phases 0–2 permanently if the internal-leg bar (≥30% + zero unexplained divergences) was met, otherwise switch the dual-write flag off and file the log as an in-room implementation detail / remove it. No third, undecided outcome is a valid filing.

Non-goals (Part A): no external consumers beyond the two named; no standalone event service; no change to what Record/Verdict/Lease mean; no migration of bindings/#3299 state (EVENT-LEDGER-1's retirement of those surfaces is a separate, later programme gated on one full landing cycle of projection parity — E11 Import 3 — and is **not** part of this experiment).

### Part B — SEAT-DELEGATE-1 (budget 16 lh total per E4 §6: identity wiring 3, gate productisation 6, policy + delegation enablement 4, breaker + digest 2, merge-queue spike 1; report at 50%, stop BLOCKED-budget at 100% without a coordinator extension on the record)

D1. **Phase 0 — APP-IDENTITY (John's act, staged by the lane).** Lane prepares everything except the act itself: coordinator GitHub App spec with least permissions (statuses: write, contents: write, pull-requests: write, checks: read — E4 §6 Step 1), install on `Uuriko/project-room`, private key through John's custody flow into the runner's secret store, using the existing helper `~/workspace/fleet-tools/gh-app-token.mjs` (do not write a second token helper). Lane verifies: installation-token auth succeeds and a test status post on a scratch PR is created **by the App identity**. Per-fleet Apps for Jill's fleet follow the same pattern after the coordinator App proves. If John's act has not happened, Phases 1 may proceed (Step 0.4) and Phase 0 stays named-pending — the delegate may not mint under the shared login as a substitute identity.
D2. **Phase 2 substrate — GATE-PRODUCTIZE.** Land the gate logic as repo tooling via the current manual coordinator path (E4 §6 Step 2: this PR is "the last fully-manual landing class"): base = PR #4115's `release-merge-gate.mjs` at head `f869d79cd…` as re-founded in Step 0.3, plus a hosted runner (`workflow_dispatch` + record-poller). The Mac coordinator remains the producer until D3 passes. Tooling lives outside `server/**` unless a step explicitly says otherwise; state that in the PR body either way (see §5).
D3. **PARITY GATE (hard gate; kill criteria live here).** The bot dry-runs 5 named specimens: one small-change-tier single, one composed non-money batch, one stack member, one FLAG-held PR, one money single. Pass = journal equivalence with the Mac coordinator on the first three and **refusal** on the last two. Then exactly one live delegated mint on a tier specimen → merge → lease revoked post-merge, verified at the API. **Kill:** parity not proven by the re-dated kill date in Step 0.5 → the lane dies, file the rota + Apps only fallback (E4 Option B + D) instead; any specimen where the bot mints for a head the Mac coordinator refuses = immediate kill + /correct entry (E4 §6).
D4. **Phase 1 + POLICY + DELEGATION.** Post Policy Record v1 in-room: delegable classes (small-change tier records; composed non-money batches ≤5 with priced records — both only with record + exact head + hosted-green + no holds/flags + stack order satisfied, all re-read at the API at mint time), breaker rules, digest cadence. Enable delegation for those classes; mint per batch under pre-authorised Rules v2 batch windows (Phase 1 semantics — this step is where Phase 1 and the productised gate join; if D1 is still pending, run this step's batch windows under the existing coordinator checks with the seat minting per batch, and enable bot minting only when D1 + D3 have both passed). Wire MQ-SEMANTICS-1 as the train mechanism the delegate executes (E11 Import 1 scope and kill criteria apply to that mechanism: composed-head CI time exceeding the sum of per-head merge-up CI on the fixture replay, or ejection misattributing a leg twice → stop that mechanism, revert to hand trains, delegation itself continues on serial batches). Start the daily audit digest job posting to the room on day one of delegation.
D5. **Breaker drills (before delegation is called done).** (i) Inject a held-flag record → mint must refuse. (ii) Inject a post-land check failure → delegation must suspend automatically and page the coordinator. (iii) Policy halt set → bot mint refused within one poll cycle. All three results are filed; a drill that cannot be run is a BLOCKED item, not a pass.
D6. **MERGE-QUEUE SPIKE (read-only, 1 lh).** Stack-law-at-enqueue analysis + CI capacity model on the then-current bound composition; decision record filed; **no protection changes under the spike** (E4 §6 Step 5). Note §1 warning 3 and PR #4951's hold in the record so the spike cannot be misread as reviving either.
D7. **ROTA + OPERATOR CLASSIFICATION.** Post the named deputy rota for gated classes on the Queue view (or its Step 0.3 successor surface); file the operator-capability classification (E4 Option F: custody-forever / scripted-known → approval-tap job / read-only) as the follow-on charter list. Neither is built further in this pack.

Non-goals (Part B): no delegation for money, shared-core, freeze, FLAG-held, out-of-order, or unpriced-failure records — ever, under this policy; no change to John's reserved gates (policy approval and any policy change, App creation + key custody, freeze/money gates, the halt all stay his, E4 §3 principle 5); no forging of `room/release-lease` outside the policy path and the pre-act journal; Jill's fleet builds and verifies, it does not become the merging seat by this pack.

### Sequencing between the parts

Step 0 → Part B D1/D2/D3 and Part A A1–A4 may build in parallel (different surfaces, one owner per surface, claims taken per AGENTS.md). Part A A5's wave is the preferred first workload for Part B D4's delegated batches **only if** D3 has passed before the wave starts; otherwise the wave runs human-minted and Part A still completes (A5's fallback). Wave-close files both verdicts together: Dual-Channel's architecture verdict (§3) and Seat-Delegate's parity/breaker evidence (§5).

---

## 5. Acceptance

The coordinator (Jill) accepts from this section alone. Every check is executed at the source (API / tree / room), never from the implementer's report. Two agreeing reads, or one API read with the method named, for every state claim (Rules v2).

### Dual-Channel acceptance

1. **Dual-write correctness:** pick 5 transitions from the wave at random from the room record; for each, the log contains exactly one matching typed event (id, PR, head + tree SHA, actor, states) — read both stores directly. Any miss or duplicate = fail.
2. **Projector idempotence:** re-run the projector over the wave's log; `gh api` read of the affected PRs shows zero new LAND_RECORD/status posts from the re-run.
3. **Measurement completeness:** the wave filing contains all §3 measures for every directed event in the wave (denominator = wave record count, named; 15–25). A filing with a sampled denominator = fail.
4. **Decision-rule fidelity:** the filed verdict states which §3 branch fired, with the numbers that fired it, and the branch's disposal (§4 A7) is executed or chartered with owner + date in the same filing. A verdict of "promising, more data needed" = fail by pre-registration.
5. **Authoritativeness preserved:** during the wave, no landing was gated on the log (spot-check: switch-off / projector outage, if one occurred, is shown to have blocked zero landings; if none occurred, the flag-off drill in a rehearsal wave shows the same).

### Seat-Delegate acceptance (E4 §6 coordinator verification, verbatim in substance)

6. **App identity:** API read — the test status on the specimen head carries the coordinator App as its creator, not the shared login.
7. **Parity journals:** bot and Mac dry-run journals identical on the 5 D3 specimens, refusals included — diff the two journals, do not summarise them.
8. **Live specimen:** one tier PR merged under a delegated mint; lease revoked post-merge; LAND_RECORD present in-room with grant + record + head triple — all read at the API / in-room.
9. **Breaker drills:** D5 (i)–(iii) results filed and re-read at the source (held-flag refusal, post-land-failure suspension + page, policy-halt refusal within one poll cycle).
10. **Protection unchanged except as policy intends:** `gh api repos/Uuriko/project-room/branches/main/protection` still shows `room/release-lease` as the sole required context; PR #4951 untouched by the lane (state + head re-read and compared to §1).
11. **Digest live:** the daily audit digest has posted to the room for each day delegation was enabled during acceptance, each anchored on LAND_RECORDs.

### Registration sweep (AGENTS.md "Pre-flight registration sweep") — applicability for the commissioned changes

| # | Item | Dual-Channel | Seat-Delegate |
|---|---|---|---|
| 1 | Runtime-package closure (`scripts/runtime-package.mjs` allowlist incl. full import closure + `scripts/candidate-runtime-fixture.mjs`) | **REQUIRED** if the dual-write / feed lands in `server/**` (expected) — verify with the closure test, never by eye | n/a — tooling lives outside `server/**`; if any `server/**` file is touched it becomes REQUIRED and the PR body must say so |
| 2 | Error-code catalogue, both copies (`skills/project-room/references/errors-catalog.md` + `node scripts/skills-sync.mjs`, byte-identical mirror) | **REQUIRED** for any new error/refusal code from the feed/projector (e.g. feed ack, divergence refusals) | **REQUIRED** for any new bot refusal shape (E4 §6 pre-flight says the same); n/a only if zero new codes, stated in the PR body |
| 3 | Route triple (`server/routes/table.mjs`; legacy allowlist if on the legacy chain; `docs/openapi.yaml` operation + bare-path quickstart example; `x-room-permission` on new mutating operations; parity note per new route row) | **REQUIRED** if A4 exposes an HTTP feed route; n/a (one word: script-only) if A4 is script-only, with that choice justified in the PR body | n/a — no new product route (delegate is fleet/repo tooling); a `workflow_dispatch` runner is not a room route |
| 4 | Harness copy sets | **REQUIRED** for any module imported by a test-harness-copied/transformed file (check the projector/feed modules against harness copy sets) | **REQUIRED** — new runner/workflow files registered per sweep item 4 (E4 §6 pre-flight) |
| 5 | Store registries (writer-fence + purge-registry + recovery-audit for a new table; additive sidecars partition in `verifySchema`) | **REQUIRED** — the dual-write log is a new store/table if persisted in the room store; if it is an append-only sidecar, its `verifySchema` partition is still REQUIRED | n/a — no new store table (policy/digest live as room records / LAND_RECORDs) |
| 6 | Generated / mirrored artifacts | **REQUIRED** if new event types grow EVENT_TYPES: re-size EVENT_CATALOG + `webhook_subscribe` inputSchema and regenerate `tests/fixtures/mcp-catalog.snapshot.json` in the same diff; MCP catalog growth also moves the count pins in `tests/mcp-search-actions.test.js` + `tests/mcp-untrusted-content.test.js` (run both by name — `verify:affected` does not select them). If the log reuses existing event types with no catalog growth: n/a, stated with the grep evidence | NOT-APPLICABLE — bot posts use the existing LAND_RECORD format, no new event types (E4 §6 states this; re-verify at handoff, do not assume) |
| 7 | Diff hygiene | **REQUIRED** if >300 changed lines: `## Large diff justification:` section in the PR body at filing | Same — **REQUIRED** if >300 lines |
| 8 | Close-out | `npm run verify:affected` + named registration suites for touched surfaces; **plus `CI=1 npm run check`** (diff touches `server/**`) | `npm run verify:affected` + named suites; `CI=1 npm run check` REQUIRED only if `server/**` is touched — state which case applies in the PR body (E4 §6) |
| 9 | Refusal-shape step | **REQUIRED-review evidence** if any refusal status/code is removed or remapped: grep the test tree at head for old-shape pins and report them (never MISSING; exit contract unchanged) | Same — **REQUIRED-review** if the bot remaps any existing refusal shape |

Additional close-out for both parts: `node ~/workspace/fleet-tools/registration-sweep.mjs` (per its README / AGENTS.md invocation for the PR/range) reports no MISSING; each lane's `handoff-check.mjs` runs clean before filing; scratch dirs deleted before the FILED line, with the deletion named in the completion report.

### Kill criteria (consolidated, binding)

- **Dual-Channel:** no kill-by-date in E15; the experiment dies instead by Step 0 failure (no Codex window, no re-founded lifecycle) → BLOCKED filing, no partial build kept running. A wave with <15 records does not count as the experiment — extend to the next wave or file BLOCKED-wave-size; do not lower the denominator post-hoc.
- **Seat-Delegate:** parity unproven by the Step 0.5 re-dated kill date → lane dies, rota + Apps only fallback filed (E4 §6). Any bot mint for a head the Mac coordinator refuses → immediate kill + /correct entry. MQ-SEMANTICS-1 mechanism: its own E11 kills (composed CI slower than per-head sum on fixture replay; ejection misattributes twice) stop the mechanism only.
- **Either part:** any mint, merge, close, or deploy outside the pre-act journal / claim discipline → stop the part, file the breach, coordinator decides restart. A 429 from GitHub anywhere → fleet-wide stop + ledger note, no local retry.

---

## 6. Routing

| Work | Recommended implementer | Why / channel |
|---|---|---|
| Step 0 re-founding, claims, opening record, all acceptance in §5 | **Jill (coordinator) + Jill's fleet** | Verification, settle passes and cures are Jill's fleet's role; it never merges. Opening record posted in the coordination room; claims are one line on #3299 per Rules v2 |
| Dual-Channel A1/A2/A4 (dual-write, projector, feed) | **Codex** | Server/core is Codex's map entry, and the lifecycle/store patterns are server-side. Handover: `room_request_reply` to Codex's exact member with a concrete ask, workItemId, and expected result (the §5 items 1–5 as the expected result). All Codex utilisation inside Project Room — no side channel |
| Dual-Channel A3 (Codex-host subscriber) | **Codex, on his own host** | Only his side can run a consumer on his Mac; Jill supplies the feed spec + event ids to ack. Same `room_request_reply` channel, separate workItemId from A1/A2 so a failure of the host leg never blocks the build leg. Note honestly in the ask: the tracked-ask protocol does not wake an idle session — arrange the attended window in the same ask (Step 0.4) |
| Seat-Delegate D2/D3/D4 (gate productisation, parity, policy enablement) | **Codex as required reviewer + Jill's fleet as builder** | E4 §6: owner = Jill's fleet (build), coordinator acceptance = Jill, release seat (Codex) is a required reviewer of the parity specimens because his Mac coordinator process is the one being productised. The D2 PR itself lands through the current manual coordinator path from John's Mac |
| Seat-Delegate D1 Phase 0 (App creation + key custody) | **John's act, staged by Jill's fleet** | Reserved gate (key custody incl. GitHub App creation). Delivered to John as a Decision Pack (D-13 format: act, exact permissions, recommendation, yes/no consequences, cost of a week of waiting) — never as a raw request. The fleet prepares the spec and verifies the result (§5 item 6) |
| Seat-Delegate D6 spike, D7 rota/classification filings | **Jill's fleet** | Read-only analysis and filings; no merges, no protection changes |
| Wave-close post-deploy / post-land verification of both verdicts | **John's Tab** | Post-deploy verification is its map entry; it re-reads the §5 numbers at the source for the wave-close filing |
| Browser-shard / CI evidence if a specimen's green is disputed | **Fo** | Responsive duty, browser-shard evidence |

**Handover channel for this piece (one sentence):** both experiments are commissioned, claimed, and accepted inside Project Room — work items via `room_request_reply` with workItemId + expected result to the named member, claims as one line on #3299, verdicts and the audit digest as room records — with GitHub (PRs, statuses, protection reads) as the verification surface, never as the coordination surface.

---

*Pack ends. Verify-claim anchors: main `aaa749065a6451321a949ddcb923f3174504fe35` (commits API, 2026-10-28); protection = sole context `room/release-lease`, `enforce_admins: true`, 0 reviews (branches/main/protection API); #4115 CLOSED unmerged at `f869d79cd61e8cdc8d4a2e23a615db1266f79615`, #4551 CLOSED unmerged at `41ee77151f`, #4496 CLOSED unmerged at `67c1281298`, #4951 OPEN at `e01eb2d4f` (`gh pr view`, 2026-10-28); bindings/settle state = settle pass 21 SYNTHESIS (259 bound / 246 OPEN at bound head); all other claims cite their file + section inline.*
