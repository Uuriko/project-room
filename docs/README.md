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
| [DEMIGOD-E2E-OPTIMIZE-2026-09-18.md](../research/DEMIGOD-E2E-OPTIMIZE-2026-09-18.md) | Optimize steals (HumanLayer, Factory blocklist, Horton queue, company waterfall, Stripe draft→send); stage allow/ask/block; Lightfield hire funnel; ~34/100 draft factory honesty |

## Steal contracts (docs only, not live doors)

**Architecture spine:** [ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md)
(Second · Connect · ledger). Dated research copy:
[ROOM-COHESIVE-ARCHITECTURE-2026-09-17.md](../research/ROOM-COHESIVE-ARCHITECTURE-2026-09-17.md).
Prefer the docs SoR when deciding what ships.

Muse ACK build-out lane. **Muse ACK on Connect:** Wake · Pull · Desktop ·
Takeover are one surface; Muse owns Connect chrome / People-rail chips —
this lane is docs/spec only. Pairs
[#454](https://github.com/Uuriko/project-room/pull/454)
[#457](https://github.com/Uuriko/project-room/pull/457)
[#466](https://github.com/Uuriko/project-room/pull/466)
[#467](https://github.com/Uuriko/project-room/pull/467). No deploy.

| Doc | What it is |
| --- | --- |
| [ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md) | **SoR** — collapses steal stack into one product (Second · Connect · ledger) |
| [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md) | `room.receipt.v1` Done receipt (evidence; chip = face) |
| [ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md) | `citedReceiptIds[]` DAG; orphan claims fail the scorer |
| [ROOM-SCORER.md](ROOM-SCORER.md) | Warp-shaped LLM judge; one dimension per scorer; Jev cheap closed-set rung |
| [ROOM-PERSONAS-FACTORY.md](ROOM-PERSONAS-FACTORY.md) | Personas + hraness parallelism + same-rung spawn + named specialists + meter honesty |
| [ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md) | Skillbox-shaped kits, harness-bridge Connect shape, Jev (recommend / scorer / pre-Ask), Roy ladder |
| [ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md) | Trust Handoff Protocol v0 (principal, authority, reversibility, expiration) |
| [ROOM-ATTENTION-PRESENCE-V0.md](ROOM-ATTENTION-PRESENCE-V0.md) | Attention modes (all / mentions / none) + host presence (Alook; not People-rail HTML) |
| [ROOM-NAUTILO-STEAL.md](ROOM-NAUTILO-STEAL.md) | Nautilo (agentsea) P0–P2 steals: **Second**, Smart Routing, messenger receipts |
| [ROOM-SECOND-V0.md](ROOM-SECOND-V0.md) | Second product spec v0 — personal loyal seat; never Genie in product copy |
| [ROOM-PERSONAL-GENIE-SEAT-V0.md](ROOM-PERSONAL-GENIE-SEAT-V0.md) | Redirect — **Second** is canonical |
| [ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md) | Five-rung ladder; Room Done defaults to Live Note / Discussion Paper |
| [ROOM-PLAN-TREE-V0.md](ROOM-PLAN-TREE-V0.md) | Ledger Plan Tree — Mission Envelope as governed plan tree; accept before tools |
| [ROOM-DEBATE-MODE-V0.md](ROOM-DEBATE-MODE-V0.md) | Proposer vs challenger (+ optional judge) → action-plan receipt |
| [ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md) | Needle-shaped tool honesty — `confidence` + `suppressed_calls`, trigger regex, ladder as leases; not an Ask chat model |
| [ASK-QUIET-SHELL-V3.md](ASK-QUIET-SHELL-V3.md) | Ask quiet-shell P0 — chrome ≤15%, model in composer, hover actions; tip #246/#249 must deploy first |
| [ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md](../research/ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md) | T086 — Ask Export thread format (cite T044 #496); markdown download vs copy; headers / model / receipt lines that ship |
| [ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md](../research/ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md) | T087 — Ask receipt / lastPaidReceipt whisper (cite T045 #496); when `#ask-receipt` shows Job id; never a capacity dash |
| [ASK-MODEL-CMDK-SPEC-2026-09-17.md](ASK-MODEL-CMDK-SPEC-2026-09-17.md) | Ask ⌘K / slash model menu — Speed / Mid / Quality whisper pill (T032; implement T033) |
| [ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md](ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md) | T042 — hover Regen with… another Community / Hosted ladder model; keep A4 truncate |
| [ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md](ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md) | T043 — hover Continue after Stop; append, do not duplicate the partial |
| [ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md](../research/ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md) | T082 — Stop / Regen / Copy / Edit keyboard map (Esc / R / C / E); cite Ask v2 #249 + quiet-shell §3.4; picker keys stay T032 |
| [ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md](../research/ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md) | T084 — New chat / Clear thread confirm (cite Ask v2 #249 A7); quiet confirm if thread has turns; never wipe without Esc/cancel |
| [ASK-ARTIFACTS-LITE-2026-09-18.md](../research/ASK-ARTIFACTS-LITE-2026-09-18.md) | Ask Artifacts-lite P0 — collapse long fences → opt-in side/bottom panel (research; implement later on dasha-lobby) |
| [ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md](../research/ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md) | T085 — `#ask-thread` GFM subset (fences, lists, bold, inline code); links stay plain; cite T041 tip canary #269 |
| [examples/scorers/](examples/scorers/) | Default scorer stubs (task-compliance, efficiency, procedure-compliance, people-data-safe, orphan-claim) |
| [ROOM-KITS-CATALOG.md](ROOM-KITS-CATALOG.md) | Optional later rows only — not live doors |

Jev + Codex same-rung spawn (research): [ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](../research/ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md).
Jev compaction + Reflex on-device (research; sibling of #477): [ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md](../research/ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md).
Master plan: [ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).
Novel synthesis (pre-collapse): [ROOM-NOVEL-SYNTHESIS-2026-09-17.md](../research/ROOM-NOVEL-SYNTHESIS-2026-09-17.md)
— superseded for “what is Room” decisions by the cohesive architecture SoR.
Cua desktop contract: [ROOM-CUA-DESKTOP.md](ROOM-CUA-DESKTOP.md) ([#454](https://github.com/Uuriko/project-room/pull/454)).
Second + Nautilo steal specs land in [#467](https://github.com/Uuriko/project-room/pull/467)
(`ROOM-SECOND-V0`, `ROOM-NAUTILO-STEAL`) and hang off this spine.
Planning / thinking cousin pass: [NOVEL-PLANNING-THINKING-BUILDS-2026-09-17.md](../research/NOVEL-PLANNING-THINKING-BUILDS-2026-09-17.md)
(Ledger Plan Tree + Debate Mode).
Needle steal (tool/extract, not Ask chat): [ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md](../research/ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md).
Ask / Compute / Room anti-noise: [UX-CLEAN-LESS-NOISE-2026-09-17.md](../research/UX-CLEAN-LESS-NOISE-2026-09-17.md).
Ask Artifacts-lite (long fences, P0): [ASK-ARTIFACTS-LITE-2026-09-18.md](../research/ASK-ARTIFACTS-LITE-2026-09-18.md).
Ask Artifacts-lite implement gate (T081, cite #493/#507; claim blocked until live quiet-shell + Quill off HTML):
[ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md](../research/ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md).
Ask markdown render scope (T085, research; cite T041 tip canary #269; fences / lists / bold / inline code ship; links stay plain):
[ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md](../research/ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md).
Bonsai 24GB soft limit + vs gemma3-27b ladder (T060+T065, research):
[ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md](../research/ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md).
Bonsai Mac provider OpenAI error paths (T067, research; thinking off; kit Stop obsolete):
[ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md](../research/ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md).
Pause-on-battery Provide + Prefer AC copy (T068+T069, research; no lecture):
[ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md](../research/ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md).
Provide soft-battery UX copy brief (T083, research; cite #515 T068/T069; quiet `On battery · paused`; no lecture; no blocking Ask):
[ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md](../research/ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md).
PrismML Bonsai id map (T064, research; public ↔ PQ2_0 / PTQ1_0 / MLX):
[ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md](../research/ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md).
Ask ladder Advanced grouping + network honesty line (T071+T072, research; Advanced empty; cite #270/#269 canaries):
[ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md](../research/ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md).
Ask vs Provide surface boundary (T074, research; Ask never hosts Provide / Host / Marketplace / capacity dash / providers table; cite #268/#270/#255 tip canaries; T073 lobby canary spinning):
[ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md](../research/ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md).
Ask quiet-shell follow-ons (T044–T046, distinct from Artifacts-lite / regen / Bonsai RAM): [research/ask/](../research/ask/).
Ask Export thread format (T086, research; cite T044 #496; markdown download vs copy; headers / model / receipt lines that ship):
[ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md](../research/ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md).
Ask receipt / lastPaidReceipt Job whisper (T087, research; cite T045 #496; when `#ask-receipt` shows Job id; never a capacity dash):
[ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md](../research/ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md).
Ask Advanced ladder UX brief (T075, research; Speed/Mid/Quality picker placement; never dump a model essay on the empty canvas; cross-link #518):
[ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md](../research/ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md).
Ask Stop / Regen / Copy / Edit keyboard shortcuts (T082, research; cite Ask v2 #249 + quiet-shell §3.4; picker keys stay T032; no empty-canvas cheatsheet):
[ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md](../research/ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md).
Ask New chat / Clear thread confirm (T084, research; cite Ask v2 #249 A7 New; quiet confirm if thread has turns; never wipe without Esc/cancel):
[ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md](../research/ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md).

## The dated archive

Most files here are named `*-2026-09-0X.md`. Those are **build checkpoints, plans, and session notes from the 9/6–9/9 build sprint** — the historical record, not the current design. Read them when you want to know *why* something is the way it is; do not treat them as current instructions. (A few dated files, like `UNIFICATION-2026-09-07.md`, are still referenced from the README for history.)

## research/

Design research, inspiration atlases, and decision records. See [research/README.md](../research/README.md).
