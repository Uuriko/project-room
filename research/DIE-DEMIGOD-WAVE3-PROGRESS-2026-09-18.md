# DIE + Demigod — Wave 3 progress

18 September 2026. **Docs only.** No people-data. Company-only.

Companion to the Wave 1–3 plan already in Room via
[#548](https://github.com/Uuriko/project-room/pull/548):
[DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md](DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md).
This note does **not** re-add that plan. It records Wave 3 land
(W3.2 / W3.3 / opt-in stub / cron honesty) only.

Wave 2 START already landed via
[#551](https://github.com/Uuriko/project-room/pull/551):
[DIE-DEMIGOD-WAVE2-PROGRESS-2026-09-18.md](DIE-DEMIGOD-WAVE2-PROGRESS-2026-09-18.md).

Also: [MATCH-STATE-PROPOSALS-2026-09-18.md](MATCH-STATE-PROPOSALS-2026-09-18.md),
[STRIPE-INVOICE-KILL-SWITCH-2026-09-18.md](STRIPE-INVOICE-KILL-SWITCH-2026-09-18.md),
[OPT-IN-FORM-SHIP-PLAN-2026-09-18.md](OPT-IN-FORM-SHIP-PLAN-2026-09-18.md),
[WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md](WATCHLIST-OBSERVE-NEVER-RUN-2026-09-18.md),
[DUAL-YES-CONSENT-2026-09-18.md](DUAL-YES-CONSENT-2026-09-18.md).

Stay-outs: Quill · dasha-lobby HTML · wrangler publish · people-data ·
Ask T0xx · Phase 0 `#8` / `#9` · auto-DM · live Stripe create/send ·
email send · live DIE `MATCH_STATES` mutation.

Project Room stays separate from Desk, Demigod/DIE, and Dasha.
Compute ≠ Room. DIE matching ≠ Ask. This fold is **not** a Room
product change and **not** a Compute change.

---

## Honesty

Draft factory **~55/100** after Wave 3 W3.2 (2026-09-18). Still a
**local draft factory / kill-switch harness**, not production E2E.
Do **not** claim a closed hire loop or live outbound.

| Claim that is true | Claim that is false |
| --- | --- |
| Local MATCH_STATES **proposals** (`status=proposed`, `dieSoRMutation: false`) | Live DIE SoR advanced |
| Local Stripe draft → `finalized_local` harness; `send_invoice` **blocked** | Stripe wired / invoice sent / charged |
| Opt-in Worker/static **path stub**; `FIRST_PARTY` **empty** (`live: false`) | trydemigod form deployed; live talent pool |
| Lightfield measure `ticket_sent` still **pending** (gmail draft pointer only) | Ticket emailed; hire measured |
| Watchlist observe **CLI** exists; scheduled routine **never-run** until first 9:25 PT fire | Cron proven; continuous observe |

Queue is still **synthetic**. Dual-yes Lightfield demo remains
`dataMarker=SYNTHETIC`. All `send_*` stay blocked.

Measure remains **one Lightfield hire** — Shipped ≠ Measured. Flip
`ticket_sent` to `done` only after a human send.

---

## Wave 3 (what landed in the slice — recorded here)

| Item | Status |
| --- | --- |
| **W3.3 / P2-SOR** MATCH_STATES proposals | Harness writes `companies/<slug>/match-state-proposal.json` for ticketed companies. `status` stays `proposed`. `dieSoRMutation` is always **false**. Desk lists rows; buttons stay inert. Humans advance SoR outside this slice. |
| **W3.2 / P2-STRIPE** invoice path | Local 10% fee draft → revise → `finalized_local` with evidence JSON. Refuses live `STRIPE_SECRET*`. Never create/send. `kill-switches.json` → `send_invoice.blocked: true` must stay. |
| Opt-in Worker / static path | Local stub only: disabled form HTML, empty `FIRST_PARTY.empty.json` (`items: []`, `live: false`), Worker route stub that `--check`s and refuses persist. **No** trydemigod deploy. |
| Lightfield measure | Still **all pending**. `ticket_sent.evidencePath` may point at a gmail **draft**. That is not a send. Human ticket send still required. |
| Watchlist observe routine | `demigod-watchlist-observe` still **never-run** until the first scheduled weekday **9:25 PT** fire. Manual CLI runs are not cron. |
| Dual-yes | Unchanged from Wave 2: Lightfield `intro_unlocked` is **SYNTHETIC**. |

---

## What this is not

- Not a people CRM and not a people-broker ingest
- Not live Gmail send, not auto-send ticket / consent / intro / invoice
- Not a live `FIRST_PARTY` opt-in pool
- Not live Stripe create, finalize, or send
- Not silent DIE `MATCH_STATES` / role-packet mutation
- Not a proven weekday observe cron
- Not a measured Lightfield hire
- Not a claim that the #548 plan file’s execution log was rewritten
- Not production E2E

*End. Wave 3 fold. Docs only.*
