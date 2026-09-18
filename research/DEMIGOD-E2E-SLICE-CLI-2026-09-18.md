# Demigod E2E — Now-slice CLI map (operator companion)

18 September 2026. **Docs only.** Companion to
[DEMIGOD-E2E-AUTOMATION-2026-09-18.md](DEMIGOD-E2E-AUTOMATION-2026-09-18.md)
(#531). Points operators at the local **Now** slice CLI for
`die-packet-brief-status` without treating any box path as required
runtime.

Parent note owns the stage machine, kill-switches, steal/reject, and
measure (one Lightfield hire). This note owns **script names +
artifacts + kill-switch lines** for the local prototype.

Stay-outs (same as parent): Quill · dasha-lobby HTML · wrangler ·
people-data · Ask T0xx · auto-DM · Stripe live · email send.

---

## 0. One line

Local prototype slice name: **`die-packet-brief-status`**.
Operators run Node scripts that write packet → brief → status →
synthetic queue rank → consent/intro/trial/invoice **drafts**, with
every outbound `send_*` blocked. Canonical green: `run-slice.mjs`
exits 0.

---

## 1. Where it lives (prototype, not a deploy)

| Kind | Value |
| --- | --- |
| Slice id | `die-packet-brief-status` |
| Local prototype dirname | `die-packet-brief-status` (under whatever publish/scratch root the operator uses) |
| Company fixtures | `companies/<slug>/` (e.g. `lightfield`, `demigod-labs`) |
| Runtime | local Node only — **not** a Room Worker, **not** wrangler, **not** a Demigod site deploy |

Do **not** hard-require a box absolute path. If the slice is checked out
elsewhere, keep the relative layout: `SLICE-CLI.md`, `state-machine.json`,
`scripts/`, `companies/`, `fixtures/`.

---

## 2. Smoke

| Command | Success |
| --- | --- |
| `node scripts/run-slice.mjs` | exit **0** — guards + demigod-labs status/rank/consent/intro/trial-eor/invoice `--check` |
| `node scripts/run-pipeline.mjs --slug <slug>` | exit **0** — check-only chain |
| `node scripts/run-pipeline.mjs --slug <slug> --write` | exit **0** — writes drafts; still no email/Stripe |

---

## 3. Guards

| Script | Kill / refuse | Success |
| --- | --- | --- |
| `validate-state-machine.mjs` | every `send_*` must be `blocked` + `killSwitch` | exit 0 |
| `assert-no-people-domains.mjs` | LinkedIn `/in`, Wellfound, RocketReach, Apollo, ZoomInfo, Clearbit people | exit 0 |

---

## 4. Stage scripts (`--slug`, often `--check`)

| Script | Writes | Kill-switch line | `--check` success |
| --- | --- | --- | --- |
| `fetch-company-packet.mjs` | `packet.md` | refuses people URLs | URLs policy-ok; no write |
| `draft-brief-from-packet.mjs` | `brief.md` | `send_ticket` | packet exists |
| `status-on-stage-change.mjs` | `status.json` | never `send_*` | legal `--to` only |
| `rank-queue-dry-run.mjs` | `queue-rank.json` | SYNTHETIC-only | fixtures + brief ok |
| `draft-consent-request.mjs` | `consent-draft.md` | `send_consent_request` | queue/consent or rank present |
| `draft-intro.mjs` | `intro-draft.md` | `send_intro` | consent-draft **or** stage consent/intro |
| `draft-trial-eor.mjs` | `trial-eor-checklist.md` | `send_trial_invite` / `approve_trial_start` | consent **or** intro **or** stage intro/trial |
| `draft-invoice.mjs` | `invoice-draft.json` | `send_invoice` (`stripeCall:false`) | packet + brief exist |

Source of truth for the one-pager inside the slice checkout:
`SLICE-CLI.md` (copy essence into this research note; do not paste box
paths as runtime requirements).

---

## 5. Kill-switches (never live in this slice)

`send_ticket` · `send_queue_digest` · `send_consent_request` ·
`send_intro` · `send_trial_invite` · `approve_trial_start` ·
`send_invoice`

Every written draft carries a `KILL_SWITCH:` line (markdown) or
`stripeCall:false` / `synthetic:true` (JSON) as applicable.

---

## 6. Stay-outs

No people scrape · no email · no Stripe · no wrangler · no GitHub PR
from the slice itself · SYNTHETIC queue only.

Room docs PRs that *describe* this slice are fine; the slice CLI must
not open PRs or touch dasha-lobby / Quill / Ask T0xx.

---

## 7. Done when (this companion)

- [x] Companion note names slice `die-packet-brief-status`
- [x] Script table + kill-switch list (essence of `SLICE-CLI.md`)
- [x] Local prototype dirname called out without requiring a box path
- [x] Link from `research/README.md` Demigod / DIE matching section
- [x] Docs lock test
- [x] Hands-off Quill, dasha-lobby HTML, wrangler, people-data, Ask T0xx

*End. Operators: run the local Now slice; Room only indexes the map.*
