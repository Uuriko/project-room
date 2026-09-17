# Project Room competitive / cousin landscape (2026-09-17)

Docs / research only. Cousin landscape for the steal stack. Does not
ship a live kit door, Connect panel, People-rail change, or client
diff.

Architecture spine:
[ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md)
(Second · Connect · ledger). Nautilo steal + Second product canon land
in [#467](https://github.com/Uuriko/project-room/pull/467) and hang off
that spine.

Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md).
Novel synthesis (Ledger Room; superseded for decisions by the SoR):
[ROOM-NOVEL-SYNTHESIS-2026-09-17.md](ROOM-NOVEL-SYNTHESIS-2026-09-17.md).
Receipt graph:
[ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md).

Goal: find startups & products similar to Project Room (people + agents on one ledger: Work Items, receipts, Connect-an-agent, BYOA) and extract learnings.

## Already in our steal stack
| Product | Steal |
|---------|-------|
| Interlateral | BYOA third space, receipts, trust handoff, authority cards, maturity ladder |
| Warp Scorers | LLM-judge past runs, sample rate, self-improve PRs |
| Cua | Driver/Fleet desktop evidence |
| Skillbox | Versioned skills + Jev router |
| harness-bridge | endpoint · model · harness honesty |
| hraness | N× parallel factory capacity honesty |
| Nautilo (agentsea/nautilo, MIT) | Closest open multi-user + multi-agent Room peer; Nautilo Genie loyalty → Room **Second**; Smart Routing; harness-of-harnesses; Secretary; privacy ladder — deep architecture + cousins: [ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md](ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md) |

## New cousins (this pass)

### 1. Oasis (Product Hunt) — *Where humans and agents come to work*
- **Shape:** Shared workspace; deploy ecosystem agents (Claude Code, Devin, OpenClaw, HeyGen, MCP) into **Rooms** = group chat for humans + agents as equal teammates.
- **Pain they name:** agents fragmented across tabs/IDEs; teammates can’t see context or reuse agents.
- **Steal:** Room = shared context compounder; “agents as teammates not tools”; one-click MCP agent deploy shelf (ours stays catalog-honest, not fake App Store).
- **Don’t:** Become an agent marketplace before Connect works.

### 2. agensis — *where agents come to work* (agensis.io)
- **Shape:** Channels/threads/DMs + persistent agent identity + presence + **shared canvas**; agents are members not sidebar; invite agents with their skills/subagents; fork thread then merge synthesis; agents free of seat cost; self-hostable.
- **Steal:** Agents hold **name + door + memory**; presence visible; thread-fork/merge for parallel exploration; seat economics (agents ≠ billable seats).
- **Don’t:** Copy seat-zero as a pricing claim without product truth.

### 3. Agent Room (tryagentroom.com / agent-room.com)
- **Shape:** MCP room for Claude Code, Codex, Cursor, Gemini; @mention; verified passport identity; shared task board; file share; cross-owner consent; wakeable agents vs pull-mode MCP clients.
- **Steal:** **Verified passport identity**; task claim/handoff board; consent gate for cross-owner collab; wake vs pull modes (matches our enrolled-key vs packet).
- **Closest name collision** — differentiate: Demigod Project Room = project ledger + People; Agent Room = coding-agent mesh.

### 4. Alook — humans + agents in one room
- **Shape:** Discord-like channels; distinct agent identities; owner still controls runtime; membership ≠ secret access; attention modes (all / mentions / none); machine presence + unread catch-up on reconnect.
- **Steal:** **Identity / membership / authority / attention / memory** as separate axes (aligns Interlateral identity≠authority≠capability); machine presence + catch-up when laptop returns; **local agents into a shared room** (BYOA host stays owner-controlled).
- **Don’t:** Grant channel membership ⇒ all owner secrets.
- **Contract:** [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) — attention modes + host presence. Docs only; People-rail chrome is later Muse.

### 5. HumanLayer — multiplayer coding agent workspace
- **Shape:** Tasks group sessions + artifacts + worktrees; RPI workflow (Questions→Research→Design→Structure→Plan→Implement); comment-driven design before code; local+cloud daemons; BYOK; design docs feed agents directly.
- **Steal:** **Artifacts tied to Work Item** (we have receipt.v1); phased workflow as optional Work Item templates; design comments → agent context (not orphan Notion); “do not outsource the thinking” checkpoints before implement. Receipt graph cites prior agent receipts so design/implement claims are not orphan — [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md).
- **Don’t:** Become a coding IDE — Room stays coordination ledger; Compute separate.

### 6. Factory.ai Software Factory
- **Shape:** SDLC missions, Droids, signal→action, policy/audit, self-improving factory metrics.
- **Steal:** Mission decomposition + audit/policy; metrics tied to delivered work not tokens (pairs Warp Scorers).
- **Don’t:** Full SDLC ownership claim for Room.

### 7. Dust (dust.tt) — multiplayer people + agents
- **Shape:** [dust.tt](https://dust.tt). Company connectors, reusable skills, audit, dual-layer permissions (data access vs who can run an agent). Multiplayer people + agents with SaaS gravity.
- **Steal:** Dual permissions (data vs run) as a packaging of our membership × memory-scope × tool-policy model; audit as first-class (we already bias receipts); reusable skills as Skillbox-shaped kits.
- **Don’t:** SaaS gravity; replacing the Room ledger with Dust conversations.

### 8. Nautilo (agentsea/nautilo) — open org harness
- **Shape:** MIT, alpha ([nautilo.ai](https://nautilo.ai) · [agentsea/nautilo](https://github.com/agentsea/nautilo)). Self-hosted org harness: every human gets a radically loyal personal Nautilo Genie; people + Nautilo Genies share Rooms; Desktop / Web / Android / iPhone. Smart Routing (right agent joins from context; `@` optional). Harness-of-harnesses (Nautilo Genie coordinates Codex / Hermes / Claude Code). Secretary / Secret Keeper (know when to shut up). Privacy model ladder 1–10 (sensitive subtasks route to the most-private model).
- **Pain they name:** 1:1 harnesses bolted onto chat; bots treated as spam on WhatsApp/Signal; no first-class multi-user + multi-agent space.
- **Steal:** **Closest open multi-user + multi-agent Room peer.** **Second** (`seat.kind = personal`, loyalty / disclosure axis); ambient Smart Routing; visible `delegation.messenger` from your Second; `human.takeover` on live artifacts; progressive tool leases; quiet Events; preflight skill pack. Specs: [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md) · [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md).
- **Don’t:** Personality / face / voice as the core value prop; film editor as P0; reimplement their Bun/Fastify/Drizzle/Logto monorepo; opaque delegation; **Genie** as Room product language (Potter: Second only).
- **Closest cousin** — differentiate: Nautilo leads with loyal Nautilo Genie + org harness UX; Project Room stays the **accountability ledger** (receipt graph, scorers, design-bound implement, capacity honesty). Room name for that seat: **Second**.
- **Deep architecture:** packages, Conductor / Floor Manager, progressive-tool leases, trust envelopes, and receipt JSON shapes live in [ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md](ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md).

## Deep-pass cousins (Nautilo fold, 2026-09-17)

New this fold. Do **not** re-rank already-covered: Interlateral, Oasis, agensis, Agent Room, Alook, HumanLayer, Factory.ai, Warp Scorers, Skillbox, harness-bridge, CUA, hraness, OpenHarness/ohmo, Nautilo. Dust is expanded above (#7) and restated here so the deep table stays one place.

Research source: [ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md](ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md).

| # | Name | URL | Steal | Skip |
| --- | --- | --- | --- | --- |
| 1 | **qm** | [github.com/yc-software/qm](https://github.com/yc-software/qm) · [qm.ai](https://qm.ai) · [writeup](https://runany.dev/blog/qm-multiplayer-agent-harness/) | Multiplayer org harness: personal scope + shared Slack/project scopes; posture Strict/Auto/Dangerous; skills scope-owned; gateway keeps keys out of sandbox; harness-swappable (Pi/OpenCode/Codex/Claude) | Slack-as-SoR; “Dangerous” as default |
| 2 | **Dust** | [dust.tt](https://dust.tt) | Multiplayer people+agents with company connectors, dual-layer permissions (data vs who can run), audit, reusable skills | SaaS gravity; replacing Room ledger with Dust conversations |
| 3 | **Magentic-UI** | [microsoft/magentic-ui](https://github.com/microsoft/magentic-ui) · [MSR blog](https://www.microsoft.com/en-us/research/blog/magentic-ui-an-experimental-human-centered-web-agent/) | Co-planning, co-tasking, action guards, **browser takeover**, plan gallery/learning | Full Magentic-One stack as Room runtime |
| 4 | **Greenroom** | [madeit-build/greenroom](https://github.com/madeit-build/greenroom) | Cross-harness backplane; wake idle sessions (≠ spawn); decision lineage; human as peer | Tiny/early; bearer-mint open model without our receipt graph |
| 5 | **AgentsMesh** | [agentsmesh.ai](https://agentsmesh.ai) · [AgentsMesh/AgentsMesh](https://github.com/AgentsMesh/AgentsMesh) | Fleet of AgentPods; mesh channels; Autopilot with human takeover/handback; control/data plane split (gRPC + relay) | BSL license for prod; coding-pod-only framing |
| 6 | **Patchwork** | [patchwork.sh](https://patchwork.sh) · [vincelwt/patchwork](https://github.com/vincelwt/patchwork) | Agents as teammates in Slack/Linear-shaped workspace; tasks + channels + persistent runs | Experimental / may disappear; no loyalty seat |
| 7 | **KaibanJS** | [kaiban-ai/KaibanJS](https://github.com/kaiban-ai/KaibanJS) | Kanban-native multi-agent orchestration + A2A agent cards | JS framework ≠ multi-human Room product |
| 8 | **Nomos** | [project-nomos/nomos](https://github.com/project-nomos/nomos) | Personal always-on agent: wiki memory, smart model routing, skills tiers (bundled/personal/project) | Solo-first; not multiplayer membership |
| 9 | **ai-room (local MCP)** | [flaviosilveira/ai-room](https://github.com/flaviosilveira/ai-room) | Local persistent rooms + independent read cursors + `room_wait`; human auth ≠ agent messages | No org harness; harness resume not guaranteed |
| 10 | **Claude Team MCP** | [shalinda-j/Claude-Team-MCP](https://github.com/shalinda-j/Claude-Team-MCP) | Debate protocol (propose→critique→revise→judge); MCP Hub holding credentials centrally | Overlaps Agent Room; debate UX ≠ Ledger |

### 9. qm — multiplayer org harness
- **Shape:** [qm.ai](https://qm.ai) · [yc-software/qm](https://github.com/yc-software/qm). Personal scope + shared Slack/project scopes; posture Strict / Auto / Dangerous; skills are scope-owned; gateway keeps keys out of the sandbox; harness-swappable (Pi / OpenCode / Codex / Claude).
- **Steal:** Personal vs shared scopes as a packaging of membership × memory × tool; posture ladder (not “Dangerous” as default); gateway-holds-keys; harness-of-harnesses without collapsing Second into a specialist CLI.
- **Don’t:** Slack-as-SoR; Dangerous as a Room default.

### 10. Magentic-UI — human-centered web agent
- **Shape:** [microsoft/magentic-ui](https://github.com/microsoft/magentic-ui). Co-planning, co-tasking, action guards, **browser takeover**, plan gallery / learning.
- **Steal:** Human takeover is a feature (pairs Nautilo Connected Website + `human.takeover` / `human.release`); action guards; co-planning before drive.
- **Don’t:** Adopt the full Magentic-One stack as Room runtime.

### 11. Greenroom — cross-harness backplane
- **Shape:** [madeit-build/greenroom](https://github.com/madeit-build/greenroom). Wake idle sessions (≠ spawn); decision lineage; human as peer.
- **Steal:** Wake ≠ spawn (attention / presence honesty); decision lineage as receipt enrichment.
- **Don’t:** Tiny/early; bearer-mint without our receipt graph.

### 12. AgentsMesh — AgentPod fleet
- **Shape:** [agentsmesh.ai](https://agentsmesh.ai) · [AgentsMesh/AgentsMesh](https://github.com/AgentsMesh/AgentsMesh). Fleet of AgentPods; mesh channels; Autopilot with human takeover / handback; control / data plane split (gRPC + relay).
- **Steal:** Autopilot handback sharpens `human.takeover` / `human.release`; control vs data plane when Desktop Connect deepens.
- **Don’t:** BSL for prod; coding-pod-only framing.

### 13. Patchwork — agents as teammates
- **Shape:** [patchwork.sh](https://patchwork.sh) · [vincelwt/patchwork](https://github.com/vincelwt/patchwork). Slack / Linear-shaped workspace; tasks + channels + persistent runs.
- **Steal:** Persistent runs bound to tasks/channels (Work Item honesty).
- **Don’t:** Experimental / may disappear; no loyalty seat (Second stays ours).

### 14. KaibanJS — Kanban-native orchestration
- **Shape:** [kaiban-ai/KaibanJS](https://github.com/kaiban-ai/KaibanJS). Kanban board as the multi-agent orchestrator; A2A agent cards.
- **Steal:** A2A agent cards as a later Connect identity face; Kanban as a Work Item view, not the SoR.
- **Don’t:** Treat a JS framework as a multi-human Room product.

### 15. Nomos — personal always-on agent
- **Shape:** [project-nomos/nomos](https://github.com/project-nomos/nomos). Wiki memory; smart model routing; skills tiers (bundled / personal / project).
- **Steal:** Skills tiers map to owner-private vs Room-shared vs kit-bundled; smart routing is model choice, not wake (keep wake rules on [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md)).
- **Don’t:** Solo-first; not multiplayer membership.

### 16. ai-room (local MCP)
- **Shape:** [flaviosilveira/ai-room](https://github.com/flaviosilveira/ai-room). Local persistent rooms; independent read cursors; `room_wait`; human auth ≠ agent messages.
- **Steal:** Independent read cursors + wait as presence/attention honesty; human auth ≠ agent messages (membership ≠ execution).
- **Don’t:** No org harness; harness resume not guaranteed.

### 17. Claude Team MCP
- **Shape:** [shalinda-j/Claude-Team-MCP](https://github.com/shalinda-j/Claude-Team-MCP). Debate protocol (propose → critique → revise → judge); MCP Hub holds credentials centrally.
- **Steal:** Debate as an optional Work Item template (not a product rename); central credential hub = gateway-holds-keys (same as qm).
- **Don’t:** Overlaps Agent Room; debate UX ≠ Ledger.

## Priority learnings for Project Room
| Priority | Learning | Action |
|----------|----------|--------|
| P0 | Separate identity / membership / authority / attention (Alook + Interlateral) | Spec authority cards + attention modes on agent members — [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) · [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md) |
| P0 | Artifacts + design comments bound to Work Item (HumanLayer) | receipt.v1 + optional design.md artifact type + [receipt graph](../docs/ROOM-RECEIPT-GRAPH-V0.md) (`citedReceiptIds[]`) |
| P0 | Verified agent passport + consent for cross-owner (Agent Room) | Align Add-agent digest keys + guest consent |
| P1 | Presence + reconnect catch-up (Alook) | Agent host online indicator — [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) |
| P1 | Thread fork/merge for parallel agent exploration (agensis) | Research note only until Muse board lane |
| P1 | Wake vs pull MCP modes (Agent Room) | Document in Connect kits |
| P2 | Oasis “agents as teammates” copy | Marketing/Connect copy, not product rename |
| P2 | Factory/Warp metrics on delivered work | Scorer dashboards later |
| P0 | Second + Smart Routing + visible messenger (Nautilo shape) | [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) · [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md) · [ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md](ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md) |
| P0 | Human takeover as a feature (Nautilo + Magentic-UI + AgentsMesh) | `human.takeover` / `human.release` on [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) |
| P0 | Membership × memory-scope × tool-policy (Nautilo + qm + Dust) | Dual permissions / personal vs shared scopes — one operator model |
| P1 | Progressive tools, quiet Events, preflights, privacy ladder (Nautilo) | Capacity-board honesty + attention preference + implement-gate skills — docs only |
| P1 | Wake ≠ spawn (Greenroom) + Autopilot handback (AgentsMesh) | Attention / presence honesty; takeover is not abort |

## Nautilo delta (Ledger Room)

Nautilo proves the market wants *multiplayer people+agents in a Room with personal loyalty*. Ledger Room’s edge remains the **receipt graph + scorers + design-bound implement + capacity honesty**.

Specs (this PR, docs only):

- [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md)
- [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md)
- [ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md](ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md) (packages, Conductor / Floor Manager, receipt JSON shapes)

| Upgrade | Room map |
| --- | --- |
| Second | `seat.kind = personal` (called **Second**) / `room` / `synthesis`; optional loyalty / **disclosure** (Secretary) axis |
| Messenger receipts | **Send your Second** — `delegation.messenger` from Second, citing prior envelope + returned summary — visible, not opaque |
| Human takeover | `human.takeover` / `human.release` on live artifacts + CUA |
| Progressive tools | Turn-scoped tool schema leases on the Capacity board |
| Quiet events | Attention preference on the Events channel only; approvals stay loud |
| Preflights | Design-bound implement skill pack (Experience / Systems / Green PR) |

Does not take [#466](https://github.com/Uuriko/project-room/pull/466) receipt-graph source. Fold this delta into `research/ROOM-NOVEL-SYNTHESIS-2026-09-17.md` when that Ledger Room note lands.

## Differentiation one-liner
**Project Room** = the project’s shared ledger (Work Items, receipts, people+agents, honesty) — not an IDE (HumanLayer), not an event third-space (Interlateral), not a coding-agent mesh alone (Agent Room), not a canvas chat hub (agensis/Oasis), not a Nautilo Genie org harness, not Slack-as-SoR (qm), not a SaaS conversation store (Dust). Steal their membership/authority/artifact/**Second** patterns; keep Compute separate. Folded synthesis: [Ledger Room](ROOM-NOVEL-SYNTHESIS-2026-09-17.md) — six-axis seats, Work Items with receipt graphs, scorers that fail orphan claims.

## Next
1. Folded into project-room research (this note + [FULL-BUILD](ROOM-STEALS-FULL-BUILD-2026-09-17.md) index)
2. Attention modes + presence contract landed: [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) (pairs Trust Handoff; People-rail chrome later)
3. Tip Muse for People-rail presence when open
4. Ledger Room fold: [ROOM-NOVEL-SYNTHESIS-2026-09-17.md](ROOM-NOVEL-SYNTHESIS-2026-09-17.md) · [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md) · [orphan-claim](../docs/examples/scorers/orphan-claim/scorer.md)
5. Nautilo steal specs: [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md) · [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) (docs only; no People-rail / Connect HTML). Room language: **Second**, never Genie.
6. Deep architecture + new cousins: [ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md](ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md) (qm, Dust, Magentic-UI, Greenroom, AgentsMesh, Patchwork, KaibanJS, Nomos, ai-room).

## Cousin delta (this fold)

Steals only. Room product language stays **Second** (never Genie).

| Cousin | Steal |
| --- | --- |
| Alook | Local agents into a shared room; owner still controls runtime; axes already on [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) |
| Human-Agent Chatroom MCP | Room-scoped MCP credentials — membership ≠ host secrets |
| AgentSync | File claims + multi-human hub (Work Item claim honesty; no silent overwrite) |
| Fgentic | Matrix + A2A federation (cross-homeserver seats later; not this PR) |
| matrix-agents | Matrix room as agent bus — Room stays the ledger, not a homeserver |
| OpenHarness / ohmo | Open harness shape — pair with harness-bridge honesty; not a live door |
| qm | Personal vs shared scopes; posture ladder; gateway-holds-keys; harness-swappable — not Slack-as-SoR |
| Dust | Dual permissions (data vs run) + audit; do not replace the ledger with Dust conversations |
| Magentic-UI | Co-planning + **browser takeover** as a feature — pairs `human.takeover` |
| Greenroom | Wake idle sessions ≠ spawn; decision lineage |
| AgentsMesh | Autopilot takeover / handback; control vs data plane |
| Patchwork | Persistent runs bound to tasks/channels; no loyalty seat |
| KaibanJS | A2A agent cards later; Kanban is a view, not the SoR |
| Nomos | Skills tiers (bundled / personal / project); solo-first |
| ai-room | Independent read cursors + `room_wait`; human auth ≠ agent messages |
| Claude Team MCP | Debate as optional Work Item template; central credential hub |
