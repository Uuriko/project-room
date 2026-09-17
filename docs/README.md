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

## Steal contracts (docs only, not live doors)

Muse ACK build-out lane. Pairs [#454](https://github.com/Uuriko/project-room/pull/454)
[#457](https://github.com/Uuriko/project-room/pull/457). No deploy.

| Doc | What it is |
| --- | --- |
| [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md) | `room.receipt.v1` Done receipt (evidence; chip = face) |
| [ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md) | `citedReceiptIds[]` DAG; orphan claims fail the scorer |
| [ROOM-SCORER.md](ROOM-SCORER.md) | Warp-shaped LLM judge; one dimension per scorer |
| [ROOM-PERSONAS-FACTORY.md](ROOM-PERSONAS-FACTORY.md) | Personas + hraness parallelism |
| [ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md) | Skillbox-shaped kits, harness-bridge Connect shape, Jev, Roy ladder |
| [ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md) | Trust Handoff Protocol v0 (principal, authority, reversibility, expiration) |
| [ROOM-ATTENTION-PRESENCE-V0.md](ROOM-ATTENTION-PRESENCE-V0.md) | Attention modes (all / mentions / none) + host presence (Alook; not People-rail HTML) |
| [ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md) | Five-rung ladder; Room Done defaults to Live Note / Discussion Paper |
| [examples/scorers/](examples/scorers/) | Default scorer stubs (task-compliance, efficiency, procedure-compliance, people-data-safe, orphan-claim) |
| [ROOM-KITS-CATALOG.md](ROOM-KITS-CATALOG.md) | Optional later rows only — not live doors |

Master plan: [ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).
Novel synthesis: [ROOM-NOVEL-SYNTHESIS-2026-09-17.md](../research/ROOM-NOVEL-SYNTHESIS-2026-09-17.md).
Cua desktop contract: [ROOM-CUA-DESKTOP.md](ROOM-CUA-DESKTOP.md) ([#454](https://github.com/Uuriko/project-room/pull/454)).

## The dated archive

Most files here are named `*-2026-09-0X.md`. Those are **build checkpoints, plans, and session notes from the 9/6–9/9 build sprint** — the historical record, not the current design. Read them when you want to know *why* something is the way it is; do not treat them as current instructions. (A few dated files, like `UNIFICATION-2026-09-07.md`, are still referenced from the README for history.)

## research/

Design research, inspiration atlases, and decision records. See [research/README.md](../research/README.md).
