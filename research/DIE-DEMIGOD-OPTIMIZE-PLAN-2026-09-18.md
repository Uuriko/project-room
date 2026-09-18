# DIE + Demigod optimization plan

**Date:** 2026-09-17 ~11:00 PM PT (file dated 2026-09-18)  
**Owner:** Grok Bot (execute); Potter kill-switches only  
**Measure:** one Lightfield hire first, then productize  
**Honesty today:** draft factory **~40/100**; Clay company tables **~36/100**. Not production E2E. Not Clay/Apollo people parity.

---

## 0. North star (what “optimized” means)

Optimize **company-OS matching desk automation**, not a people-data CRM.

| Optimized looks like | Explicitly NOT |
| --- | --- |
| Continuous public company observe → packet → firmographics → ICP → ranked ticket queue | Scraped LinkedIn lakes, Apollo People, email finders |
| Humans only at: send ticket, send consent, both-sides intro, send invoice | Auto-DM, auto-intro, auto-pay |
| DIE SoR (match states, role packets, evidence) fed by company research + opted-in talent | ATS dump / résumé marketplace |
| Lightfield funnel instrumented with real evidence after human flips | Fake `hire_confirmed` from green CLI |
| Operator desk that ranks work by ICP and shows pending HumanLayer gates | Dashboard that pretends sends happened |

**Product facts (unchanged):** matching desk + founder tickets; both sides approve before intro; talent pays nothing; startup pays 10% first-year base on start; identity only after mutual approve of exact role.

---

## 1. Current state (truthful inventory)

### 1.1 What is already strong

| Surface | Status |
| --- | --- |
| Stage machine + kill-switches | All `send_*` blocked; ledger + asserts |
| Live observe | Full watchlist proven (43 cos; 34 hiring hits) |
| Packets/briefs | ~41 companies with packet+brief |
| Firmographics (Clay-shaped) | 40 `firmographics.json`; industry/headcount/funding/hq columns; cite-or-unknown |
| ICP scoring | 40 scores; custom weights; desk chips |
| Ticket factory | 11 kill-switched tickets; ICP-ranked queue |
| Observe→enrich pipeline | `run-observe-enrich.mjs`; weekday routine prompt updated |
| DIE bridge | Movers seed, role import, hosted healthz |
| Lightfield measure path | ticket/consent/intro/trial drafts; measure JSON pending |
| Guards | `run-slice` green; people-domain / GTM / firmographics / brief-id asserts |
| Docs | Clay/Apollo gap (PR #542 merged); optimize research; honesty one-pagers |

### 1.2 What is still fake-complete or thin

| Gap | Why it hurts |
| --- | --- |
| **Queue is synthetic** | Matching theater until first-party opt-in talent is live |
| **Ops research catalog empty** | `DEMIGOD-COMPANY-RESEARCH.json` still `companies: []` on SoR |
| **openRoles / ATS underfilled** | Most firmographics lack ATS JSON fills |
| **techStack missing** | No public technographic column yet |
| **Routine never fired** | Watchlist observe routine historically “never run” (prompt now updated; next weekday slot proves it) |
| **No Gmail draft.create from slice** | Payload files only; human still pastes |
| **No dual-yes consent ledger product** | Markdown drafts ≠ mutual approve SoR |
| **Hosted desk is Access-gated / read-only** | Local HTML desk ≠ operator SoR UI |
| **Stripe unused** | Invoice fixture only |
| **Hire measure pending** | No real ticket_sent evidence yet |
| **Live MATCH_STATES not advanced by harness** | Bridge drafts; SoR stays human/ops |

### 1.3 Hard nevers (optimize without violating)

1. No people-data brokers; no LinkedIn `/in`; no Apollo People / Enrichment / phones  
2. No Monid `search_founders` / `get_person_detail`  
3. No auto-send ticket / consent / intro / invoice  
4. No inventing ARR/funding/hire evidence  
5. No Designer-publish / plugin.jup.ag / Potter keys / Phase 0 #8/#9 source  
6. No claiming “fully automated” while queue is synthetic

---

## 2. Strategy: three optimization axes

### Axis A — Company intelligence (Clay company tables)

**Goal:** Every watchlist company has dense, cited firmographics that support ICP + brief quality.

Steal: Clay Enrich Company waterfall (domain → industry, headcount, funding, HQ, careers); Apollo **Organization** field vocabulary only; stop-on-first public providers.

### Axis B — Matching desk automation (Demigod E2E)

**Goal:** Draft factory → operator flip UX → measured Lightfield hire, with kill-switches as the only human gates.

Steal: HumanLayer approve/deny; Factory blocklist; Horton recommend-into-queue over **opted-in** talent; Greenhouse scorecard discipline.

### Axis C — DIE SoR depth (matching engine)

**Goal:** Hosted DIE + demigod-ops hold real company research + role packets + match review states; harness writes **drafts** and **proposals**, humans advance MATCH_STATES.

Steal: Evidence provenance; role-packet stages; refuse mutating SoR without review.

---

## 3. Target maturity (honest ladders)

| Area | Now | Wave 1 target | Wave 2 | Wave 3 |
| --- | ---: | ---: | ---: | ---: |
| Overall draft factory | 40 | 48 | 58 | 70* |
| Clay company tables | 36 | 45 | 55 | 65 |
| Observe/cron | 35 | 50 | 60 | 70 |
| Packet/firmographics | 70 | 78 | 85 | 90 |
| Brief/ticket | 65 | 72 | 80 | 85 |
| Queue (opt-in) | 22 | 25 | 45 | 70 |
| Consent/intro | 25 | 35 | 50 | 65 |
| Measure (Lightfield) | 35 | 40 | 55 | 80 |
| DIE SoR bridge | 40 | 48 | 60 | 75 |

\*70 still means kill-switches exist; “fully automated” remains false forever under product policy.

---

## 4. Wave 1 — Now (48h): densify company OS + operator leverage

**Success criteria:** ATS openRoles filled for ≥15 companies; ops research fixture fully synced; techStack column present; desk shows ICP queue + Lightfield flip path; auto-ticket gate for new ICP≥70 demigod; Room docs PR for this plan.

### W1.1 ATS / openRoles enrichment (public JSON only)

- Extend waterfall to fetch Greenhouse/Lever/Ashby/Workable **public** boards when `jobsUrl` host matches allowlist  
- Write `openRoles` + `openRolesAt` + `atsSource` into firmographics with cites  
- Never scrape people pages from ATS  
- Re-batch firmographics for top ICP + legal-AI

### W1.2 Sync research catalog

- `export-firmographics-to-die-research.mjs --write-ops` **only after** dry-run diff + assert company-only  
- Prefer writing to ops **mirror** first; if ops write, refuse people keys  
- Document rollback (empty companies array restore)

### W1.3 Technographics (public HTML fingerprint)

- New optional field `techStack[]` from first-party HTML: known script hosts / CDN tokens (e.g. stripe.js, segment, hubspot) — company infra signals only  
- Cite page URL; confidence low; never invent

### W1.4 Auto-ticket gate (still kill-switched)

- Script: when ICP≥70 AND productFit demigod|both AND no ticket-draft → draft ticket + gmail + pending approval  
- Cap 5 per run; never send  
- Wire into end of `run-observe-enrich` behind `--auto-ticket` flag (default off for cron; on for operator)

### W1.5 Operator desk polish

- ICP-ranked queue (done) + Lightfield flip checklist prominence  
- Show firmographics fill % and openRoles count  
- Pending approvals grouped: ticket / consent / intro

### W1.6 Prove weekday routine

- After next 9:25a / 1:25p / 5:25p PT fire: confirm routine ran; if still never-run, debug scheduler  
- Manual: run `run-observe-enrich` once and attach beat

### W1.7 Docs

- This plan → `research/` via project-room PR  
- Update skill + AUTOMATION-HONESTY scores after W1 lands

---

## 5. Wave 2 — Next (1–2 weeks): human flip path + talent honesty

### W2.1 Gmail draft.create from payload

- Operator command: create Gmail **draft** from `gmail-ticket-draft.json` via MCP (not send)  
- Record message id into measure evidence when operator confirms  
- Still kill-switched from auto path

### W2.2 First-party opt-in talent intake (live)

- Ship form on trydemigod per `OPT-IN-INTAKE.md`  
- Replace SYNTHETIC pool marker with live FIRST_PARTY rows  
- Rank queue over opt-in only; refuse scrape

### W2.3 Dual-yes consent ledger

- Schema: consent request / talent yes / founder yes / intro unlocked  
- HumanLayer for each send; SoR write only after dual yes  
- Intro draft auto-refresh when unlocked (send still blocked until flip)

### W2.4 Hosted operator desk (read + approve)

- Hosted read of pending approvals (Access already on DIE)  
- Approve/deny writes disk status only; outbound separate  
- Never enable wrangler Access from harness alone without Potter

### W2.5 Continuous Monid GTM

- Weekly company-only Monid wave → `gtm-leads.json` → seed watchlist  
- Budget cap; free tinyfish preferred; never founders endpoints

### W2.6 Greenhouse scorecard quality

- Brief fields: must-haves, nice-to-haves, interview loop cheap-talk  
- Ticket role titles from GTM+ATS job title when available

---

## 6. Wave 3 — Later (measure + SoR): Lightfield hire → productize

### W3.1 Lightfield hire funnel to done

- Human sends ticket → evidence → `ticket_sent=done`  
- Consent/intro/trial flips with evidence paths  
- `hire_confirmed` only with start_date evidence (refuse invent)

### W3.2 Stripe draft→finalize→send kill-switch

- Keep `auto_advance:false` until hire start verified  
- Finalize+send only after HumanLayer on `send_invoice`

### W3.3 Live DIE MATCH_STATES proposals

- Harness writes **proposed** transitions; review UI advances SoR  
- Evidence attachments from packets/firmographics cites  
- Never silent SoR mutation

### W3.4 Clay-like company table UI

- Columns: domain, industry, headcount, funding, HQ, ICP, openRoles, ticket status  
- Sort/filter; click → packet/brief/approvals  
- Still company-only

### W3.5 Productize after one hire

- Encode playbook: observe→enrich→ICP→ticket→consent→intro→trial→bill  
- Second customer uses same factory with less hand-wiring

---

## 7. Prioritized backlog (execution order)

| ID | Item | Wave | Effort | Leverage |
| --- | --- | --- | --- | --- |
| P0-ATS | openRoles ATS JSON enrich | 1 | M | High |
| P0-OPS | Sync research catalog from firmographics | 1 | S | High |
| P0-TECH | techStack public fingerprint | 1 | M | Med |
| P0-TICKET | --auto-ticket ICP≥70 gate | 1 | S | High |
| P0-DESK | Desk groups + Lightfield flip UX | 1 | S | Med |
| P0-DOCS | Plan → Room research PR | 1 | S | Med |
| P0-CRON | Prove/fix watchlist routine fire | 1 | S | High |
| P1-GMAIL | Gmail draft.create operator path | 2 | M | High |
| P1-OPTIN | Live opt-in form | 2 | L | Critical |
| P1-DUAL | Dual-yes consent ledger | 2 | L | Critical |
| P1-HOST | Hosted approve desk | 2 | L | High |
| P1-MONID | Scheduled Monid GTM | 2 | M | Med |
| P2-HIRE | Lightfield evidence → measured | 3 | L | Critical |
| P2-STRIPE | Invoice kill-switch path | 3 | M | Med |
| P2-SOR | MATCH_STATES proposals | 3 | L | High |
| P2-TABLE | Company table UI | 3 | L | Med |

---

## 8. Kill-switch matrix (unchanged product law)

| Action | Auto draft | Human flip | Auto send |
| --- | --- | --- | --- |
| Ticket | YES | YES | NEVER |
| Consent request | YES | YES | NEVER |
| Both-sides intro | YES after dual-yes drafts | YES | NEVER |
| Trial invite | YES | YES | NEVER |
| Invoice | YES (fixture) | YES | NEVER |
| People scrape / auto-DM | NEVER | NEVER | NEVER |

---

## 9. Measurement (shipped ≠ measured)

| Metric | Definition | Owner |
| --- | --- | --- |
| Firmographics fill rate | % fields filled with cite / total WATERFALL+Clay fields | Automation |
| ICP coverage | # companies with icp-score.json | Automation |
| Ticket pending age | Days pending HumanLayer | Operator |
| Lightfield funnel | ticket_sent → … → hire_confirmed with evidence | Potter + automation ledger |
| Opt-in pool size | Live FIRST_PARTY rows (0 until form) | Product |
| Cron health | Routine last-run ≠ never | Automation |

---

## 10. Execution log (append as we go)

| When (PT) | Action | Result |
| --- | --- | --- |
| 2026-09-17 ~23:00 | Plan authored | This file |
| (next) | W1.1 ATS openRoles | TBD |
| (next) | W1.2 research catalog sync | TBD |
| (next) | W1.3 techStack | TBD |
| (next) | W1.4 auto-ticket flag | TBD |
| (next) | W1.7 Room docs PR | TBD |

---

## 11. Escape hatches

- If Monid/ATS network fails: keep unknown cells; do not invent  
- If ops write blocked: stay on fixtures mirror  
- If Instinct deploy blocked for Ask #282: Demigod W1 continues independently  
- If tempted by people-data to “finish”: **stop**; empty > illegal  

---

## 12. Immediate next commands (operators / agents)

```bash
cd /workspace/phase0-publish/die-packet-brief-status
node scripts/run-observe-enrich.mjs --check
# After W1 scripts land:
# node scripts/enrich-ats-open-roles.mjs --all-with-jobsUrl
# node scripts/export-firmographics-to-die-research.mjs --check
# node scripts/run-observe-enrich.mjs --auto-ticket
node scripts/run-slice.mjs
```

**Room docs:** open PR adding `research/DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md` + README index row.
