# Stripe invoice kill-switch (Wave 3 · W3.2 / P2-STRIPE)

18 September 2026. **Docs only.** Company-only. No people-data.

**Goal:** Local draft → revise → `finalized_local` path for
placement-fee invoices — **never** live Stripe create/send from
this slice.

**Hard nevers:** no `STRIPE_SECRET*` live create · no charge ·
no email · no people-data · never unblock `send_invoice` from
automation.

Project Room stays separate from Desk, Demigod/DIE, and Dasha.
Compute ≠ Room. DIE matching ≠ Ask.

Parents: [DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md](DIE-DEMIGOD-WAVE3-PROGRESS-2026-09-18.md),
[DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md](DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md)
(W3.2),
[DEMIGOD-E2E-OPTIMIZE-2026-09-18.md](DEMIGOD-E2E-OPTIMIZE-2026-09-18.md)
(Stripe draft→send steal).

---

## What this slice writes (local only)

| Path | Role |
| --- | --- |
| `companies/<slug>/invoice-draft.json` | Local 10% fee calc (`feePercent: 0.1`) |
| `companies/<slug>/stripe-invoice-draft.json` | Stripe-shaped fixture (`auto_advance: false`, `collection_method: send_invoice`) |
| `kill-switches.json` → `send_invoice` | **`blocked: true`** (must stay) |

Harness (slice, not Room): `stripe-invoice-path.mjs`
(`--check` / `--dry-run` / `--apply` / `--finalize-local --evidence`).
`--check` asserts `send_invoice.blocked=true`, refuses if live
Stripe env is set, and writes nothing. `--finalize-local` marks
**local** status `finalized_local` only when an evidence JSON
exists and is not `invented: true`. That is **not** Stripe API
finalize.

Any of `STRIPE_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_API_KEY`,
`STRIPE_LIVE_SECRET`, `STRIPE_LIVE_KEY` set → refuse.

---

## Local status meanings

| Local status | Meaning |
| --- | --- |
| `draft` / DRAFT ONLY | Fixture on disk; not emailed; not charged |
| `finalized_local` | Operator marked local finalize with evidence path; Stripe `finalized` / `sent` still **false** |
| live Stripe open / paid | **Out of scope** for this slice |

Desk may show a quiet invoice chip (`draft` / `finalized_local`).
Send-invoice button stays disabled (`KILL_SWITCH: send_invoice`).

`fee_invoiced` measure stage is a separate operator flip. Draft ≠
charged.

---

## Operator flip order (after `hire_confirmed`)

Do **not** flip `send_invoice` until the hire funnel has a real
start date. After measure `hire_confirmed`:

1. **Hire verified** — `hire_confirmed` with `start_date` evidence. Refuse invent.
2. **Base salary confirmed** — operator fills real first-year base; revise 10% fee.
3. **Local draft review** — human checks fee math + company identity from the packet.
4. **Local finalize (optional)** — disk-only `finalized_local`. Not Stripe finalize.
5. **HumanLayer** — request/decide `send_invoice` on disk. Approval ≠ send.
6. **Kill-switch lift (human only)** — unblock `send_invoice` only after steps 1–5. Automation must never flip this.
7. **Live Stripe create + send** — separate operator step **outside** this slice. Keep `auto_advance: false` until hire start verified.

Lightfield measure is still **pending** a human ticket send. This
path does not skip that funnel.

---

## Honesty

Shipping this path does **not** mean Stripe is wired. Green
`run-slice` proves guards + local draft / `finalize_local`
harness only. `send_invoice` stays blocked.
