# Demigod + DIE — next automation list (then execute)

18 September 2026 ~7:05 AM PT. **Docs only.** No people-data. Company-only.

Companion to the Wave 1–3 plan already in Room via
[#548](https://github.com/Uuriko/project-room/pull/548):
[DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md](DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md).
Wave 2 START already landed via
[#551](https://github.com/Uuriko/project-room/pull/551):
[DIE-DEMIGOD-WAVE2-PROGRESS-2026-09-18.md](DIE-DEMIGOD-WAVE2-PROGRESS-2026-09-18.md).
Wave 3 land already landed via
[#575](https://github.com/Uuriko/project-room/pull/575):
[DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md](DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md).
This note does **not** re-add those files. It records the **next
automation list** after Wave 3.

Also: [OPT-IN-FORM-SHIP-PLAN-2026-09-18.md](OPT-IN-FORM-SHIP-PLAN-2026-09-18.md),
[WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md](WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md),
[MATCH-STATE-PROPOSALS-2026-09-18.md](MATCH-STATE-PROPOSALS-2026-09-18.md),
[STRIPE-INVOICE-KILL-SWITCH-2026-09-18.md](STRIPE-INVOICE-KILL-SWITCH-2026-09-18.md),
[DUAL-YES-CONSENT-2026-09-18.md](DUAL-YES-CONSENT-2026-09-18.md).

Stay-outs: Quill · dasha-lobby HTML · wrangler publish · people-data ·
Ask T0xx · Phase 0 `#8` / `#9` · auto-DM · live Stripe create/send ·
email send · live DIE `MATCH_STATES` mutation · Apollo People ·
Monid founders · invent hire evidence.

Project Room stays separate from Desk, Demigod/DIE, and Dasha.
Compute ≠ Room. DIE matching ≠ Ask. This fold is **not** a Room
product change and **not** a Compute change.

**Honesty now:** draft factory **~55/100**. Not production E2E. Queue
still synthetic. All `send_*` blocked. `FIRST_PARTY` empty. Cron
still **never-run**.
**Measure:** one Lightfield hire first, then productize (slice
`PRODUCTIZE-AFTER-HIRE.md`; not a Room product change).
**Hard never:** people-data / Apollo People / Monid founders /
auto-send / invent hire evidence.

---

## Honesty

Draft factory **~55/100** after Wave 3 (2026-09-18). Still a
**local draft factory / kill-switch harness**, not production E2E.
Do **not** claim a closed hire loop, live outbound, a live talent
pool, or a proven weekday cron.

| Claim that is true | Claim that is false |
| --- | --- |
| Opt-in Worker/static **path stub**; `FIRST_PARTY` **empty** (`live: false`) | trydemigod form deployed; live talent pool |
| Watchlist observe **CLI** exists; scheduled routine **never-run** until first 9:25 PT fire | Cron proven; continuous observe |
| Lightfield measure `ticket_sent` still **pending** (gmail draft pointer only) | Ticket emailed; hire measured |
| Local MATCH_STATES **proposals** (`status=proposed`, `dieSoRMutation: false`) | Live DIE SoR advanced |
| Local Stripe draft → `finalized_local`; `send_invoice` **blocked** | Stripe wired / invoice sent |

Queue is still **synthetic**. Dual-yes Lightfield demo remains
`dataMarker=SYNTHETIC`. All `send_*` stay blocked.

Measure remains **one Lightfield hire** — Shipped ≠ Measured. Flip
`ticket_sent` to `done` only after a human send.

---

## Snapshot (this machine)

| Metric | Count |
| --- | ---: |
| Watchlist companies | 221 |
| Packets / briefs | ~56 |
| Firmographics + ICP | 55 |
| Ticket drafts (kill-switched) | 26 |
| MATCH_STATES proposals | 26 |
| Hiring-partner email drafts | 250 |
| FIRST_PARTY opt-in | 0 (empty stub) |
| Watchlist observe routine | **never-run** (next slot 9:25 AM PT) |

---

## A. Critical path (highest leverage)

### A1. Live first-party talent opt-in (unblocks matching)
**Why:** Queue is synthetic until real talent exists. Everything after brief is theater without this.
**Do:** Ship `GET /opt-in` + `POST /api/opt-in` on trydemigod (plan already in OPT-IN-FORM-SHIP-PLAN). Persist FIRST_PARTY rows only. Rank queue over opt-in only.
**Human:** none for form browse; consent still kill-switched later.
**Done when:** `FIRST_PARTY.count ≥ 1` live and `rank-from-opt-in` refuses synthetic-as-live.

### A2. Prove watchlist observe cron
**Why:** Continuous company OS requires schedule, not only manual CLI.
**Do:** Wait for weekday 9:25/13:25/17:25 PT fire; record last-run. Prompt already calls `run-observe-enrich.mjs`.
**Done when:** automation_status shows a scheduled fire (manual ≠ cron).

### A3. Lightfield measure: human ticket send
**Why:** Product law = measure one hire. Drafts exist; measure stages pending.
**Do:** Operator flip checklist → real inbox → send/create Gmail draft → `measure-advance --apply ticket_sent` with evidence. Then consent → dual-yes → intro → trial → hire_confirmed+start_date.
**Human:** required at every send_*.
**Done when:** `hire_confirmed=done` with start_date evidence (never invent).

### A4. Hosted operator approve desk
**Why:** Local HTML desk doesn’t scale; DIE hosted is Access-gated read-only.
**Do:** Hosted read of pending approvals + MATCH_STATES proposals; approve/deny writes disk status only; outbound still kill-switched.
**Done when:** operator can clear a pending `send_ticket` approval from hosted UI without SSH.

---

## B. Company intelligence (Clay-shaped)

### B1. Packet coverage: watchlist → packet/brief
**Gap:** 221 watchlist vs ~56 packets.
**Do:** Batch `observe-to-packet` / waterfall for hiring hits missing `packet.md` (cap 15–20/run).
**Done when:** every hiringSignal=true watchlist row has packet+brief or explicit skip reason.

### B2. ATS board URL discovery
**Gap:** densify got 0 ATS fills this morning — no allowlisted board URLs on most firmographics.
**Do:** From careers/jobs pages, extract Greenhouse/Lever/Ashby/Workable board IDs → write `jobsUrl` → `enrich-ats-open-roles`.
**Done when:** ≥40% of firmographics have non-empty `openRoles[]` from public JSON.

### B3. Firmographics density
**Do:** Fill UNKNOWN cells (industry/headcount/funding/HQ) via public waterfall only; cite-or-unknown. Re-ICP.
**Done when:** median filled Clay fields ≥6/company on ticketed set.

### B4. Continuous Monid GTM
**Do:** Monday routine must fire; merge company-only leads; never founders endpoints.
**Done when:** Monid weekly last-run ≠ never.

---

## C. Matching desk automation

### C1. Partner outreach → ticket factory bridge
**Gap:** 250 email drafts sit beside 26 tickets.
**Do:** For top ICP partners with real roles + domain, auto-create packet/brief/ticket if missing (cap 20/run). Keep `careers@` guessed; never send.
**Done when:** ticket queue ≥50 kill-switched with role titles from jobs.

### C2. Gmail draft.create operator path (live dry-run safe)
**Do:** For Lightfield (and top 3), create **Gmail draft** via MCP when `to` is a real company inbox (not placeholder). Never send. Record draft id into measure evidence pointer.
**Done when:** at least one Gmail draft id on disk for Lightfield without send.

### C3. Dual-yes live (not SYNTHETIC)
**Do:** Wire opt-in talent + founder yes into `dual-yes-ledger`; intro unlock only after both.
**Done when:** one non-SYNTHETIC `intro_unlocked` after human flips.

### C4. MATCH_STATES → DIE SoR review UI
**Gap:** 26 proposals local; no apply to live DIE.
**Do:** Hosted review that applies **one** proposed transition with evidence attach; never silent mutation.
**Done when:** one proposal accepted into live MATCH_STATES with audit row.

### C5. Invoice after hire
**Do:** After hire_confirmed, `stripe-invoice-path --finalize-local` then human `send_invoice`.
**Done when:** invoice sent only after HumanLayer (not this automation alone).

---

## D. DIE SoR depth

### D1. Bridge proposals into demigod-ops
Import match-state-proposal.json as review queue items in DIE matching engine.
### D2. Role packet import from ATS openRoles
When openRoles filled, draft role packet stubs for DIE import (`die-role-import`).
### D3. Evidence attachments
Cite firmographics/packet hashes on every proposal and ticket.

---

## E. Execution order (this session)

| # | Item | Wave |
| --- | --- | --- |
| 1 | Write this plan + Room research fold | Docs |
| 2 | Packet batch for hiring watchlist misses (cap 20) | B1 |
| 3 | ATS board URL extractor + enrich | B2 |
| 4 | Partner→ticket for top 15 ICP with roles | C1 |
| 5 | Opt-in form static ship artifact toward trydemigod | A1 |
| 6 | Hosted approve desk stub/spec + minimal local API shape | A4 |
| 7 | Gmail draft.create dry-run path refine for Lightfield | C2 |
| 8 | Wait/prove 9:25 cron | A2 |

Stay-outs unchanged: no people scrape, no auto-send, no fake cron, no invent hire.

## Success metrics

- Packets on watchlist hiring hits ↑
- openRoles non-empty ↑
- Tickets with real role titles ↑
- FIRST_PARTY live path closer (static form on demigod or PR)
- Honesty score only rises with real gates, not docs alone

## What this is not

- Not a people CRM and not a people-broker ingest
- Not live Gmail send, not auto-send ticket / consent / intro / invoice
- Not a live `FIRST_PARTY` opt-in pool
- Not a proven weekday observe cron
- Not a measured Lightfield hire
- Not live DIE `MATCH_STATES` mutation
- Not a Room product change and not a Compute change
- Not production E2E

*End. Next-automation fold. Docs only.*
