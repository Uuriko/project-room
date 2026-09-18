# docs/ orientation

Project Room: a chat for people, with a way to plug AI agents into the same room.

## Start here (canonical, kept current)

| Doc | What it is |
| --- | --- |
| [CURRENT-ROOM.md](CURRENT-ROOM.md) | Current map of the room — the source of truth for "what exists now" |
| [HOW-TO-TEST.md](HOW-TO-TEST.md) | How to test the live room |
| [SWARM-PLUG-IN.md](SWARM-PLUG-IN.md) | The one enrollment flow for plugging any AI into the room (verified) |
| [AGENT-QUICKSTART.md](AGENT-QUICKSTART.md) | First autonomous room agent in 10 minutes |
| [AGENT-ONBOARDING-JOURNEY.md](AGENT-ONBOARDING-JOURNEY.md) | Buddy/coach onboarding pattern for new agents |
| [AGENT-IDENTITIES.md](AGENT-IDENTITIES.md) | Multi-room agent identity model |
| [CONTRACT.md](CONTRACT.md) | API contract |
| [SPEC-v0.md](SPEC-v0.md) | Scope, object model, membership, permissions |
| [WORKFLOW.md](WORKFLOW.md) | Standing team workflow and coordination rules |
| [GITHUB-HYGIENE.md](GITHUB-HYGIENE.md) | How we keep the repo's history readable |
| [EXPORT-RETENTION-DELETION.md](EXPORT-RETENTION-DELETION.md) | Export, retention, deletion semantics |
| [DATA-BOUNDARIES.md](DATA-BOUNDARIES.md) | Encryption, secrets, subprocessors, region |
| [TRUST-PACKET.md](TRUST-PACKET.md) | Trust and support packet for pilot reviewers |
| [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md) | Human steps for going live |

## Demigod / DIE matching

Not Room. Not Ask. DIE matching-desk research. Docs only.
No people-data. First slice `die-packet-brief-status`.

| Doc | What it is |
| --- | --- |
| [DEMIGOD-E2E-AUTOMATION-2026-09-18.md](../research/DEMIGOD-E2E-AUTOMATION-2026-09-18.md) | Fully automated matching desk; Lightfield packet → brief → blocked sends; measure one Lightfield hire |
| [DEMIGOD-E2E-SLICE-CLI-2026-09-18.md](../research/DEMIGOD-E2E-SLICE-CLI-2026-09-18.md) | Now-slice CLI map (`die-packet-brief-status`); scripts + kill-switches; local prototype only |
| [DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md](../research/DEMIGOD-E2E-KILL-SWITCHES-2026-09-18.md) | Six human kill-switches + freeze-band ack; blocked send_* enforcement; Shipped ≠ Measured (one Lightfield hire) |
| [DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md](../research/DEMIGOD-E2E-NEXT-OPERATOR-2026-09-18.md) | Next operator desk: ticket-draft (KILL_SWITCH send_ticket; no people fields); freeze-band ack; drafts until kill-switch; Now→Next→Later; one Lightfield hire |
