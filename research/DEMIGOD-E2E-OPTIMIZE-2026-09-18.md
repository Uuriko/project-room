# Demigod E2E — Optimize steals (production-shaped gates)

18 September 2026. **Docs only.** Condensed from the 17 September
optimize research. Companion to
[DEMIGOD-E2E-AUTOMATION-2026-09-18.md](DEMIGOD-E2E-AUTOMATION-2026-09-18.md)
(#531),
[DEMIGOD-E2E-SLICE-CLI-2026-09-18.md](DEMIGOD-E2E-SLICE-CLI-2026-09-18.md)
(#532),
[DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md](DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md)
(#534), and
[DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md](DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md)
(#536).

**Why:** local drafts are not enough. Point the DIE matching desk
toward production-shaped gates, company-only research,
recommend-into-queue, and placement billing — no people brokers, no
auto-DM.

Stay-outs: Quill · dasha-lobby HTML · wrangler · people-data · Ask T0xx ·
Phase 0 `#8` / `#9` · auto-DM · Stripe live send · email send.

---

## 0. Honesty first

The local `die-packet-brief-status` slice is a **draft factory with
blocked sends**, not production E2E automation. Overall maturity
**~34/100** (2026-09-17 PT gap audit): strong local draft discipline;
observe / waterfall / measure ledgers present; almost no live
send→hire loop. Do **not** claim fully automated matching.

Measure remains **one Lightfield hire** — Shipped ≠ Measured.

---

## 1. Top 5 steals for implement

1. **HumanLayer email/send gates** — `requireApproval` /
   `fetchHumanApproval` with full payload; Slack/email channel;
   timeout = deny.
2. **Factory Autonomy + allow / deny / block** — drafts on
   allow/deny; `send_*` + Stripe finalize/send on **blocklist** (no
   bypass).
3. **Horton recommend-into-queue** — rank opted-in matches into a
   review queue; never auto-intro.
4. **Company waterfall** — Parallel Task (cited schema) → Exa
   company search → Clay Enrich Company (domain only).
5. **Stripe draft → finalize → send** — `auto_advance=false`; 10%
   fee; human on send.

North star: **one Lightfield hire** as an Amplitude-style funnel
(`ticket_sent` → `hire_confirmed`).

---

## 2. Stage → allow / ask / block

Preserve existing kill-switches. Blocked set stays: `send_ticket`,
`send_queue_digest`, `send_consent_request`, `send_intro`,
`send_trial_invite`, `send_invoice`.

| Stage | Allow | Ask | Block |
| --- | --- | --- | --- |
| Visit / Packet | Parallel / Exa / Clay **company**; citations | Publish weekly | People-broker fetch |
| Brief / Ticket | Draft brief, scorecard, ticket JSON | **`send_ticket`** | Silent email |
| Match queue | Horton rank over first-party opted-in; explain cards | Queue add/remove | Auto-intro; broker ingest |
| Consent | Draft consent | **`send_consent_request`** | Auto-DM |
| Intro | Draft mutual-yes | **`send_intro`** | Auto-send |
| Trial | EOR/W-2 checklist | **`send_trial_invite`** | 1099 onsite |
| Placement | Stripe **draft** | **`send_invoice`** (finalize+send) | Auto-charge / score-pay |

---

## 3. Lightfield hire measure funnel

**North star:** `hire_confirmed` where `company_slug=lightfield`
within a window (e.g. 90d from `ticket_sent`).

| # | Event | When | Props (no people PII) |
| --- | --- | --- | --- |
| 1 | `company_packet_ready` | Cited packet passes CI | `citation_count`, `waterfall_providers` |
| 2 | `brief_locked` | Scorecard frozen | `brief_id`, `freeze_band` |
| 3 | `ticket_drafted` | Local ticket JSON | `ticket_id` |
| 4 | `ticket_sent` | Approve `send_ticket` | `approver_id`, `approval_latency_s` |
| 5 | `queue_recommended` | Horton rank written | `queue_size`, `shadow_mode` |
| 6 | `consent_sent` / `consent_yes` | Kill-switched send + reply | opaque ids |
| 7 | `intro_sent` | Mutual yes | `mutual_yes_at` |
| 8 | `trial_started` | EOR/W-2 | `classification=eor_w2` |
| 9 | `hire_confirmed` | Start verified | `base_salary_band` |
| 10 | `invoice_drafted` / `_sent` / `_paid` | Stripe | `amount_cents`, `stripe_invoice_id` |

- **Primary chart:** funnel 4→9 for Lightfield (unique `brief_id`).
- **Guardrails:** blocked `send_*`, deny rate, cite coverage, zero
  people-broker fetches.
- **Shipped ≠ Measured:** gate wrappers = Shipped; Measured only on
  `hire_confirmed`.
- Until Amplitude keys: local
  `die-packet-brief-status/metrics/lightfield-funnel.jsonl`.

Does **not** count: ticket drafts, ranks, invoice drafts, weekly
publishes, opens.

---

## 4. Primary URLs

| Claim | Primary |
| --- | --- |
| HumanLayer npm SDK | https://www.npmjs.com/package/@humanlayer/sdk |
| HumanLayer workshop §11 | https://github.com/humanlayer/12-factor-agents/blob/d20c7283/workshops/2025-05/sections/11-humanlayer-approval/README.md |
| Factory Autonomy Level | https://docs.factory.ai/autonomy-and-safety/auto-run |
| Factory Agent Safety & Controls | https://docs.factory.ai/enterprise/llm-safety-and-agent-controls |
| Horton recommend-into-queue | http://john-joseph-horton.com/papers/employer_search.pdf |
| Parallel Task enrichment | https://docs.parallel.ai/task-api/examples/task-enrichment |
| Exa company vertical | https://exa.ai/docs/reference/verticals/company-for-coding-agents |
| Clay waterfall enrichment | https://www.clay.com/guides/waterfall-enrichment |
| Stripe invoicing integration | https://docs.stripe.com/invoicing/integration |
| Amplitude funnel analysis | https://amplitude.com/docs/analytics/charts/funnel-analysis/funnel-analysis-build |
| Amplitude Wave (Shipped ≠ Measured) | https://amplitude.com/blog/wave |
| Deck approval gates & kill switches | https://deck.co/blog/design-approval-gates-kill-switches-ai-agents |

---

## 5. Done when

- [x] Top 5 steals named (HumanLayer, Factory blocklist, Horton
      queue, company waterfall, Stripe draft→send)
- [x] Stage allow / ask / block table
- [x] Lightfield hire measure funnel
- [x] Honesty: local draft factory ~34/100, not production E2E
- [x] Primary URLs only
- [x] Link from `research/README.md` and `docs/README.md` Demigod /
      DIE matching
- [x] Docs lock test
- [x] Hands-off Quill, dasha-lobby HTML, wrangler, people-data, Ask T0xx,
      Phase 0 `#8`/`#9`

*End. Optimize steals for production-shaped gates. Measure one
Lightfield hire.*
