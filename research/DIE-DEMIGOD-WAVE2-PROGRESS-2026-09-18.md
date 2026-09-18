# DIE + Demigod — Wave 2 START progress

18 September 2026. **Docs only.** No people-data.

Companion to the Wave 1–3 plan already in Room via
[#548](https://github.com/Uuriko/project-room/pull/548):
[DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md](DIE-DEMIGOD-OPTIMIZE-PLAN-2026-09-18.md).
This note does **not** re-add that plan. It records Wave 2 START only.

Also: [DUAL-YES-CONSENT-2026-09-18.md](DUAL-YES-CONSENT-2026-09-18.md),
[OPT-IN-FORM-SHIP-PLAN-2026-09-18.md](OPT-IN-FORM-SHIP-PLAN-2026-09-18.md).

Stay-outs: Quill · dasha-lobby HTML · wrangler publish · people-data ·
Ask T0xx · Phase 0 `#8` / `#9` · auto-DM · Stripe live · email send.

---

## Honesty

Draft factory **~47/100** at Wave 2 START. Not production E2E. Queue
is still synthetic until a live `FIRST_PARTY` opt-in row exists. Do
**not** claim live talent, live dual-yes outreach, or a deployed
trydemigod form.

Measure remains **one Lightfield hire** — Shipped ≠ Measured.

---

## Wave 2 START (what landed)

| Item | Status |
| --- | --- |
| Dual-yes ledger | Local SoR + CLI. Lightfield `companies/lightfield/dual-yes.json` is **SYNTHETIC** (`dataMarker=SYNTHETIC` from `fixtures/opt-in-pool.json`) and is at **`intro_unlocked`**. Intro draft refresh only; `send_intro` stays kill-switched. Opaque `handleRef` only — never email/phone/linkedin. |
| Gmail `draft.create` operator path | Planned operator command from `gmail-ticket-draft.json` via MCP **draft** (not send). **0 live API calls.** Dry-run only. |
| Opt-in form | Ship plan written for trydemigod `POST /api/opt-in` → `FIRST_PARTY` rows. **Not deployed.** No wrangler publish, no Access enable, no live form HTML this fold. |
| Hosted approve desk / Stripe / hire evidence | Still Wave 2–3; not this START. |

---

## Wave 1 counts (carried into Wave 2)

| Surface | Count |
| --- | ---: |
| `openRoles` ATS JSON fills | 16 |
| `techStack` public-fingerprint batch | 15 |
| Ops research catalog companies | 40 |

Company-only. Cite-or-unknown. No people pages from ATS.

---

## What this is not

- Not a people CRM and not a people-broker ingest
- Not live Gmail, not auto-send ticket / consent / intro / invoice
- Not a live FIRST_PARTY opt-in pool
- Not a claim that the #548 plan file’s execution log was rewritten

*End. Wave 2 START fold. Docs only.*
