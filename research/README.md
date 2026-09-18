# Research (Codex ChatGPT project mirror)

These notes lived next to the local checkout, not in git. They are copied here so
GitHub is the single Project Room place. They are **plans and comparisons**, not
proof that a mailbox, payout, or hosted agent is live.

Start with [PROJECT-ROOM-BLUEPRINT.md](PROJECT-ROOM-BLUEPRINT.md). Implementation
truth is in [`docs/`](../docs/), especially [CURRENT-ROOM.md](../docs/CURRENT-ROOM.md).
Architecture SoR (steal stack collapsed):
[ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md)
(Second · Connect · ledger). Dated brief:
[ROOM-COHESIVE-ARCHITECTURE-2026-09-17.md](ROOM-COHESIVE-ARCHITECTURE-2026-09-17.md).

## Demigod / DIE matching

Project Room stays separate from Desk, Demigod/DIE, and Dasha.
Docs only. No people-data. First slice `die-packet-brief-status`.

| Note | What it is |
| --- | --- |
| [DEMIGOD-E2E-AUTOMATION-2026-09-18.md](DEMIGOD-E2E-AUTOMATION-2026-09-18.md) | Fully automated matching desk stage machine; Lightfield packet → brief → blocked sends; measure one Lightfield hire |
| [DEMIGOD-E2E-SLICE-CLI-2026-09-18.md](DEMIGOD-E2E-SLICE-CLI-2026-09-18.md) | Now-slice CLI map for `die-packet-brief-status` (script names + kill-switches; local prototype; companion to #531) |
| [DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md](DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md) | Six human kill-switches (send_ticket → invoice + freeze-band ack); local blocked send_* via state-machine.json + kill-switch-ledger.mjs; measure one Lightfield hire |
| [DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md](DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md) | Next operator desk: ticket-draft schema (KILL_SWITCH send_ticket; no people fields); freeze-band ack human gate; consent/intro/invoice stay draft; Now→Next→Later; measure one Lightfield hire (Shipped ≠ Measured) |
| [DEMIGOD-E2E-OPTIMIZE-2026-09-18.md](DEMIGOD-E2E-OPTIMIZE-2026-09-18.md) | Optimize steals: HumanLayer gates, Factory blocklist, Horton queue, company waterfall, Stripe draft→send; stage allow/ask/block; Lightfield hire funnel; honesty ~34/100 draft factory (not production E2E) |
