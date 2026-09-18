# Demigod E2E — Next operator desk (founder ticket draft)

18 September 2026. **Docs only.** Companion to
[DEMIGOD-E2E-AUTOMATION-2026-09-18.md](DEMIGOD-E2E-AUTOMATION-2026-09-18.md)
(#531),
[DEMIGOD-E2E-SLICE-CLI-2026-09-18.md](DEMIGOD-E2E-SLICE-CLI-2026-09-18.md)
(#532), and
[DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md](DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md)
(#534). Essence of the local **Next** operator desk
(`NEXT-OPERATOR-DESK.md` in the `die-packet-brief-status` prototype):
a founder ticket projection that does **not** turn any draft into
outbound.

Parent (#531) owns the stage machine, steal/reject, and measure.
Slice-CLI (#532) owns Now script names + artifacts.
Kill-switches (#534) owns the six human gates.
This note owns the **Now → Next → Later** ladder and the
**ticket-draft** schema / freeze-band ack human gate.

Stay-outs (same as parents): Quill · dasha-lobby HTML · wrangler ·
people-data · Ask T0xx · Phase 0 `#8` / `#9` · auto-DM · Stripe live ·
email send.

---

## 0. One line

**Now** freezes the boundary (blocked `send_*`, freeze-band ack).
**Next** materializes a local founder `ticket-draft.json` with
`KILL_SWITCH: "send_ticket"` and **no people fields**. Consent / intro /
invoice stay drafts until their kill-switches. Measure remains **one
Lightfield hire** — Shipped ≠ Measured.

---

## 1. Now → Next → Later (short ladder)

| Rung | Operator intent | Outbound? |
| --- | --- | --- |
| **Now** | Packet → brief → synthetic queue → consent/intro/trial/invoice **drafts**; freeze-band ack; every `send_*` blocked | No |
| **Next** | Founder-facing **ticket-draft** projection (`draft-ticket.mjs`); still local, reviewable, reversible | No — `send_ticket` remains kill-switched |
| **Later** | Separately approved slice may enable human-gated consent-send UX and live gates | Only after explicit human clear + approved slice |

A green `run-slice.mjs` or a written ticket draft is **Shipped**, not
**Measured**. Measured is still one Lightfield hire.

---

## 2. Ticket-draft schema (founder ticket object)

Local write: `companies/<slug>/ticket-draft.json`, constrained by
`schemas/ticket-draft.schema.json`.

Operator commands (prototype; relative to slice root):

```bash
# Validate packet + brief and the ticket shape; no write
node scripts/draft-ticket.mjs --slug demigod-labs --check

# Materialize the local founder ticket projection
node scripts/draft-ticket.mjs --slug demigod-labs
```

Allowed top-level fields only:

| Field | Role |
| --- | --- |
| `companySlug` | Traceability to the local company OS |
| `briefPath` | Path to the engineering brief |
| `roleTitle` | Role title already present in the brief |
| `cheapTalk` | Placeholder expectations / operating preferences from the brief — not a live offer |
| `scorecardSummary` | Threshold + weighted attributes from the brief |
| `status` | Always `"DRAFT"` in this slice |
| `KILL_SWITCH` | Always `"send_ticket"` |

**No people fields.** No identity, address, inbox, profile, résumé, or
contact payload. The script reads `packet.md` + `brief.md`, validates the
source boundary, and never calls email, a ticket provider, Stripe,
wrangler, or any network service. The ticket is a founder review
surface, not a published requisition.

Primary kill-switch phrase for this Next artifact: **`KILL_SWITCH:
"send_ticket"`** (and the blocked `send_ticket` transition in
`state-machine.json`).

---

## 3. Freeze-band ack = human gate before queue freeze

Before treating the role band as frozen for the Next desk, the operator
acknowledges the freeze band:

```bash
node scripts/freeze-band-ack.mjs --slug demigod-labs --check
```

This writes only `companies/<slug>/freeze-band.json` with
`ackRequired: true` and a no-outbound note. It is an **operator
acknowledgement**, not permission to send. Freeze-band ack is one of the
six human kill-switches (#534); queue / consent / intro must not proceed
as if the band were live without that human gate.

---

## 4. Consent / intro / invoice remain draft until kill-switch

In Now and Next, these stay local drafts only:

| Draft | Kill-switch (still blocked) |
| --- | --- |
| `consent-draft.md` | `send_consent_request` |
| `intro-draft.md` | `send_intro` |
| `invoice-draft.json` | `send_invoice` (`stripeCall:false`) |

Trial invite / approve remain blocked too (`send_trial_invite` /
`approve_trial_start`). A button, keyboard shortcut, retry job, or
background worker must not bypass those gates. In this slice the final
send control is a disabled/no-op affordance or a local draft action
only — no automatic consent request, no address book, and no
identity/contact payload in the ticket draft.

---

## 5. Measure (Shipped ≠ Measured)

[Amplitude Wave](https://amplitude.com/docs/wave/opportunities):
**Shipped ≠ Measured.**

Measure is still **one Lightfield hire** — a person starts (EOR / W-2
trial if the role is SF), after both-sides consent, freeze-band ack, and
a human-sent intro.

Do **not** substitute ticket creation, a consent preview, a message
count, an invoice draft, docs shipping, or a green `run-slice.mjs` for
Measured.

Until outbound is intentionally enabled in a separately approved slice,
record only the local milestone definition and its company citation; do
not add person-level tracking.

---

## 6. Exit criteria (this companion)

- `node scripts/run-slice.mjs` exits **0** (Now still green).
- `draft-ticket.mjs --check` is green for the company slug under test.
- Ticket schema has no additional or person fields; `KILL_SWITCH` is
  `send_ticket`; `status` is `DRAFT`.
- `send_ticket`, consent send, intro send, trial invite, and invoice
  send remain blocked.
- Freeze-band ack is treated as the human gate before queue freeze.
- No wrangler, Stripe, email, network send, people-data, or Quill /
  dasha-lobby / Ask T0xx / Phase 0 `#8`/`#9` work in this PR.

---

## 7. Stay-outs

Hands-off Quill · dasha-lobby HTML · wrangler · people-data · Ask T0xx ·
Phase 0 `#8` / `#9`. No Worker. No live email. No Stripe send. No
auto-DM.

---

## 8. Done when (this companion)

- [x] Now → Next → Later ladder named
- [x] ticket-draft schema essence (founder object; `KILL_SWITCH send_ticket`; no people fields)
- [x] freeze-band ack as human gate before queue freeze
- [x] consent / intro / invoice remain draft until kill-switch
- [x] Measure: one Lightfield hire (Shipped ≠ Measured)
- [x] Link from `research/README.md` and `docs/README.md` Demigod / DIE matching
- [x] Docs lock test
- [x] Hands-off Quill, dasha-lobby HTML, wrangler, people-data, Ask T0xx, Phase 0 `#8`/`#9`

*End. Next is a local founder ticket draft. Measure one Lightfield hire.*
