# Demigod E2E — human kill-switches (operator companion)

18 September 2026. **Docs only.** Companion to
[DEMIGOD-E2E-AUTOMATION-2026-09-18.md](DEMIGOD-E2E-AUTOMATION-2026-09-18.md)
(#531) and
[DEMIGOD-E2E-SLICE-CLI-2026-09-18.md](DEMIGOD-E2E-SLICE-CLI-2026-09-18.md)
(#532). Names the **six human kill-switches** on the DIE matching desk
and how the local Now prototype enforces blocked `send_*`.

Parent note owns the stage machine, steal/reject, and measure.
Slice-CLI note owns script names + artifacts. This note owns
**kill-switch inventory + enforcement pointers**.

Stay-outs (same as parents): Quill · dasha-lobby HTML · wrangler ·
people-data · Ask T0xx · Phase 0 `#8` / `#9` · auto-DM · Stripe live ·
email send.

---

## 0. One line

Software drafts. A human sits on six irreversible gates. Local
prototype keeps every outbound `send_*` **blocked** via
`state-machine.json` + `kill-switch-ledger.mjs`. Measure is **one
Lightfield hire** — Shipped ≠ Measured.

---

## 1. The six human kill-switches

| # | Kill-switch | Human must | Machine must not |
| --- | --- | --- | --- |
| 1 | **`send_ticket`** | Press send on a named role ticket | Auto-email / auto-DM the company or talent |
| 2 | **`send_consent_request`** | Both sides opt in to the exact company, role, and base-cash band | Infer consent from a public profile click |
| 3 | **`send_intro`** | Approve the warm both-sides intro | Send the intro because the queue scored high |
| 4 | **`send_trial_invite` / `approve_trial_start`** | Invite and approve SF EOR / W-2 trial start | Treat trial as 1099 or auto-start without human ack |
| 5 | **`send_invoice`** | Send the 10% invoice after a hire starts | Auto-bill on "shipped" or on intro |
| 6 | **freeze-band ack** | Explicitly freeze the role base-cash band (cheap talk locked) before consent / intro proceed | Quietly rewrite the band mid-flow, or seek salary history |

FAQ lock ([trydemigod.com/faq](https://www.trydemigod.com/faq)):
software compares evidence; a human proposes; both sides approve
before any intro; no public pile; talent free; startup fee is 10% of
first-year cash when a hire starts.

`send_queue_digest` (slice CLI) stays blocked too; it is not a human
kill-switch on this six-gate list — the desk never auto-blasts a
queue digest.

---

## 2. Local prototype enforcement

| Artifact | Role |
| --- | --- |
| `state-machine.json` | Every `send_*` transition is `blocked` + carries `killSwitch` |
| `kill-switch-ledger.mjs` | Append-only ledger of armed / blocked / human-acked gates |
| `validate-state-machine.mjs` | Guard: every `send_*` must be `blocked` + `killSwitch` (exit 0) |

Canonical green for the Now slice remains `run-slice.mjs` exit 0
(see slice-CLI companion). Drafts may exist; outbound send does not.

Do **not** hard-require a box absolute path. Relative layout under the
local `die-packet-brief-status` prototype is enough.

---

## 3. Measure (Shipped ≠ Measured)

[Amplitude Wave](https://amplitude.com/docs/wave/opportunities):
**Shipped ≠ Measured.**

The first measured outcome is **one Lightfield hire** — a person
starts (EOR / W-2 trial if the role is SF), after both-sides consent,
freeze-band ack, and a human-sent intro.

Do not report docs shipping, a green `run-slice.mjs`, or a blocked
status file as Measured.

---

## 4. Hard never

| Ban | Why |
| --- | --- |
| **people-data** | Company packets only. No contact waterfall, no public talent pile. |
| **auto-DM** | Ticket / consent / intro / trial / invoice are human gates. No blast. |
| **salary history** | [CA Labor Code §432.3](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=432.3.) — band is role cheap talk, not prior pay. |
| **SF trial as 1099** | San Francisco trial hire is EOR / W-2 employment. Not a contractor dodge. |

---

## 5. Stay-outs

Hands-off Quill · dasha-lobby HTML · wrangler · people-data · Ask T0xx ·
Instinct Phase 0 `#8` / `#9`. No Worker. No live email. No Stripe send.

---

## 6. Done when (this companion)

- [x] Six kill-switches named (incl. freeze-band ack)
- [x] Local enforcement: `state-machine.json` + `kill-switch-ledger.mjs`
- [x] Measure: one Lightfield hire (Shipped ≠ Measured)
- [x] Hard never: people-data · auto-DM · salary history · SF trial as 1099
- [x] Link from `research/README.md` and `docs/README.md` Demigod / DIE matching
- [x] Docs lock test
- [x] Hands-off Quill, dasha-lobby HTML, wrangler, people-data, Ask T0xx, Phase 0 `#8`/`#9`

*End. Kill-switches stay human. Measure one Lightfield hire.*
