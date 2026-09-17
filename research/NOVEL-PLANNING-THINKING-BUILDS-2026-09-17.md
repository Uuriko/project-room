# Novel planning / thinking builds (2026-09-17)

Docs / research only. Muse stay-outs held. Does not ship a live kit
door, Connect panel, People-rail chrome, or client diff. No Instinct
Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9). No runtime code.

**Product personal agent is Second.** Never Genie in Room product copy,
onboarding, or marketing examples. Cite a third-party “Genie” only when
naming *their* product.

Architecture SoR:
[ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md)
(Second · Connect · ledger). Receipt graph:
[ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md). Second:
[ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md).

This fold:

- Plan tree contract: [ROOM-PLAN-TREE-V0.md](../docs/ROOM-PLAN-TREE-V0.md)
- Debate mode contract: [ROOM-DEBATE-MODE-V0.md](../docs/ROOM-DEBATE-MODE-V0.md)

Goal: map 2026 planning / thinking products that sit *beside* the
existing steal stack (Warp, Skillbox, harness-bridge, Interlateral,
Nautilo, HumanLayer) and rank what Room should steal — versus what
stays on Compute or on Ask.

## Surfaces (rank against these, not “AI in general”)

| Surface | Owns | Does not own |
| --- | --- | --- |
| **Room** | Mission Envelope, plan tree, receipts, membership, Second, design-bound implement | Job runtime, Mac marketplace, People-rail HTML |
| **Compute** | Run factory: jobs, Macs, tok/s honesty, settle | Work Items, plan accept, debate verdicts |
| **Ask** | Human gates: accept / reject / waive / ask-before-public / ask-before-irreversible | Silent auto-execute, skip-permissions defaults |

A steal is **P0** when Room would be dishonest without it. **P1** when
it shapes a later face. **P2** when it is a cousin lesson, a Compute
supplier pattern, or a marketing-only copy steal.

## Landscape table

| Product | Kernel | Room | Compute | Ask | Steal | Don’t |
| --- | --- | --- | --- | --- | --- | --- |
| **TSP** ([Tree-Structured Planning](https://treestructuredplanning.com/)) | Governed canvas: agents propose subtrees; every change is a proposal; MCP peers write a ledger (branch, files, handoff) | **P0** | P2 | **P0** | Mission Envelope *is* a plan tree. Second / Claude / Codex read the same tree. Accept/reject is the gate. | Host TSP AI credits inside Room. Collapse chat into the only plan. |
| **cuddlytoddly** ([AlexChesser/cuddlytoddly](https://github.com/AlexChesser/cuddlytoddly), [cuddlytoddly.com](https://cuddlytoddly.com)) | Editable task DAG *before* any tool. Clarification node. Pause / redirect / promote-to-subgoal. Event log. QualityGate. | **P0** | P1 | **P0** | Plan-before-tools. Human edits deps mid-run. Only affected branches re-run. Mutations are events. | Become their orchestrator. Auto-bridge missing outputs without a receipt. |
| **Treequence** ([treequence.ai](https://treequence.ai/)) | Spatial OS: multiplayer branch, pin context, MCP tools, pause/correct mid-flight | P1 | P1 | P2 | Branch = parallel exploration on one ledger. Pin is memory, not membership. | Infinite-canvas chrome before the tree is MCP-readable. |
| **Conotion** ([conotion.ai/canvas](https://conotion.ai/canvas)) | Multi-agent visual canvas; Director + experts; per-project drive; full history | P1 | P2 | P2 | Parallel branches keep their own context. History is first-class. | Agent marketplace shelf. Fake App Store. |
| **Synapse** ([synapse.byorello.space](https://synapse.byorello.space/)) | Reasoning canvas + Atlas CLI agent; custom thinking personas | P1 | P1 | P2 | Visual thought-branch + a specialist harness under Second, not a second personal agent | Rename Atlas a Second. Merge CLI into Room Start. |
| **Cognograph** ([skovalik/cognograph](https://github.com/skovalik/cognograph), [cognograph.app](https://cognograph.app/workspace)) | Spatial graph; draw an edge → context injection; Plan-Preview-Apply ghost nodes; MCP | P1 | P1 | P1 | Ghost-node preview before apply. Edges assemble context. MCP expose. | Fork their Electron canvas. Patent-copy spatial triggers. |
| **Cruvero** ([cruvero.ai](https://cruvero.ai/)) | Production orchestration: Temporal durability, approvals, audit, cost, MCP gateway | P2 | **P0** | P1 | Compute stays durable + governed. Approval gates before risky tools. Plan Mode critique. | Fold Temporal into Room. Room becomes the control plane. |
| **Crossfire** ([JianyuZhan/crossfire](https://github.com/JianyuZhan/crossfire)) | Proposer vs challenger (+ judge) across Claude / Codex / Gemini → prioritized action plan | **P0** | P2 | **P0** | Debate Mode: structured clash → `room.debate.v0` action-plan receipt. Cross-vendor, not same-weights personas. | Run debates as Compute jobs without a Room verdict. Skip-permissions adapters. |
| **Corvus** ([trycorvus.ai](https://www.trycorvus.ai/)) | Thinking partner: forks + paths + obligations; Muninn append-only decision history | **P0** | P2 | P1 | Append a new decision that cites the old one. Forks are not a flat list. | Retroactive edit of decided nodes. Rules-engine “you forgot X” nag. |
| **DecisionCanvas** ([DecisionLedger AI](https://decisionledgerai.com/platform/decision-canvas)) | Whiteboard → governed decision. Draft / In Review / Official / Archived. Only Official is AI-referenceable. Agent work starts Draft. | **P0** | P2 | **P0** | Maturity gate on what Second may cite. Fail closed on unknown status. | Let a Live Note ground implement. Promote on session `done`. |
| **Arcana** ([DeepVectorAi/arcana](https://github.com/DeepVectorAi/arcana)) | Agent OS: LLM decides strategy; runtime enforces budget, tools, traces; `ask_user` built-in | P2 | **P0** | **P0** | Ask is a runtime service, not a prompt hint. Facts ≠ assessment. Working-set discipline. | Room interprets raw model output as policy. Unbounded context growth. |
| **Linear Agent composer** ([linear.app/docs/linear-agent](https://linear.app/docs/linear-agent)) | Workspace-grounded compose: chat → brief / spec / milestones / assignments; Skills + Loops; MCP | P1 | P2 | P1 | Compose a Mission Envelope from Room history, not a blank chat. Skills = repeatable plan recipes. | Become Linear. Agent-owned issue mutation as Room’s SoR. |
| **Memorable** ([taecontrol/memorable](https://github.com/taecontrol/memorable)) | MCP project memory: Decision / Observation / Task stapled to Entities. `memorable_guide` in-band. Sanctioned forget. | **P0** | P2 | P2 | Memory is structured and MCP-readable. Forget is a receipted Act, not silent wipe. | Scatter “what we decided” across chat. Semantic-search-only recall. |
| **Jev-in-harness** ([ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md)) | `recommend_kits(query) → [{ id, score }]` inside harness-bridge Connect shape. Inert+reason when the key is absent. | P1 | **P0** | P2 | “Which kit / harness?” is a typed recommend, not a 30-turn search. Honesty when Jev is offline. | Require Jev SaaS. Invent Astra if the Community Mac is `qwen3:4b`. |

## Already in the steal stack (do not re-steal)

| Source | Kernel already folded |
| --- | --- |
| Interlateral | Trust Handoff, Agent Interaction Receipt, Artifact Maturity Ladder |
| Warp Scorers | One-dimension LLM judge; human-merge self-improve |
| HumanLayer | RPI / design-bound implement; artifacts on the Task |
| Nautilo | Second, Smart Routing, messenger, takeover |
| Skillbox + harness-bridge | Versioned kits; provider · model · harness honesty |
| Ledger Room | Six/seven-axis seat; `citedReceiptIds[]`; orphan-claim fail |

This note is the **planning / thinking** cousin pass. Membership /
authority / presence cousins stay on
[ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md).

## Ranked steals (by surface)

### P0 — Room would be dishonest without these

| # | Steal | From | Room mapping |
| --- | --- | --- | --- |
| 1 | **Governed plan tree** | TSP | Work Item / Mission Envelope *is* a tree of goal / task / dep nodes. Agents propose subtrees. Humans accept. MCP-readable for Second, Claude, Codex. Contract: [ROOM-PLAN-TREE-V0.md](../docs/ROOM-PLAN-TREE-V0.md). |
| 2 | **Editable DAG before tools** | cuddlytoddly | No implement claim, no Compute job, no Cua Fleet claim until the accepted leaf is in scope. Clarification fields first. Mid-run edits reset only children. |
| 3 | **Append-only decision history** | Corvus | Changing a decided node appends a new decision that cites the old receipt. No silent rewrite. Pairs `citedReceiptIds[]`. |
| 4 | **Official-only cite** | DecisionCanvas | Second / synthesis may ground on Official (Workshop / Working Paper) or an owner waive receipt. Draft agent boards stay Draft. Fail closed. |
| 5 | **Structured memory via MCP** | Memorable | Decisions / observations / tasks staple to Work Item + entity ids. `forget` is an Act + receipt. |
| 6 | **Proposer vs challenger → action plan** | Crossfire | Debate Mode for product bets and architecture. Verdict is a receipt, not a chat vibe. Contract: [ROOM-DEBATE-MODE-V0.md](../docs/ROOM-DEBATE-MODE-V0.md). |

### P0 — Compute / Ask (do not fold into Room)

| # | Steal | From | Mapping |
| --- | --- | --- | --- |
| 7 | **Durable run + cost + audit** | Cruvero | Compute owns Temporal-shaped durability and spend honesty. Room copies job id + UNKNOWN fields. |
| 8 | **`ask_user` as a runtime service** | Arcana | Ask every time + ask-before-public / irreversible stay Room policy. Compute / specialist harnesses must surface Ask, not skip-permissions. |
| 9 | **Typed kit recommend** | Jev-in-harness | Connect shape already: `recommend_kits`. Inert+reason when the TypeSafe key is absent. Do not require Jev SaaS. |

### P1 — later faces (docs now, chrome later)

| Steal | From | When |
| --- | --- | --- |
| Spatial branch / pin | Treequence, Synapse, Conotion | After the tree is MCP-readable. Muse canvas later — not this pass. |
| Ghost-node Plan-Preview-Apply | Cognograph | Proposed subtree renders as unaccepted nodes. Apply = human accept. |
| Compose from workspace history | Linear Agent composer | Foreman / Second drafts the envelope from existing Work Items + receipts, then human accepts. |
| Skills as plan recipes | Linear Agent Skills + Loops | Repeatable “scope this kind of Work Item” — not cron inside Room. |
| Parallel thinking personas | Synapse | Personas stay claim types (`foreman` / `triage` / `review`). Not a second Second. |

### P2 — cousin lessons only

| Steal | From | Note |
| --- | --- | --- |
| Director + expert marketplace | Conotion | Soft Quest Board already; no fake App Store. |
| TSP-hosted AI credits | TSP | Agent MCP writes are free of *their* credits; Room must not invent a credit meter. |
| Film / avatar / spatial effects | Cognograph ambient, Conotion polish | Explicit non-goal. |
| Coding-session delegation | Linear Agent | Compute / specialist harness under Second. Ledger stays SoR. |

## Novel synthesis — “Ledger Plan Tree”

Not a canvas app. Not a crew framework. Not Linear. Not a debate TUI.

**Thesis:** The Mission Envelope is a **governed plan tree**. Chat is a
projection of that tree. Compute is a supplier that may run only
**accepted leaves**. Ask is the accept / reject / waive gate. Second
reads and proposes; it does not silently grow the tree.

Fold:

| Input | Kernel kept | Room twist |
| --- | --- | --- |
| TSP | Canvas-shaped tree + MCP peers + proposal/accept | Tree lives on the Work Item. Every node mutation is a `room.receipt.v1`. |
| cuddlytoddly | DAG before tools; live edit; QualityGate | Design-bound implement: implementation persona cannot claim an unaccepted leaf. |
| Corvus | Fork / path / append-only Muninn | New decision cites the superseded node’s receipt. Orphan rewrite fails the scorer. |
| DecisionCanvas | Official-only AI cite; agent output starts Draft | Maturity ladder is the gate. Session `done` does not promote. |
| Memorable | Decision / Observation / Task memory over MCP | Memory records staple to node ids. Forget is receipted. |
| Crossfire | Proposer vs challenger → action plan | Optional Debate Mode *before* the tree forks a product/architecture bet. Verdict receipt becomes the parent node’s accepted path. |
| Linear composer | History-grounded draft | Second / `foreman` compose from receipts, not a blank prompt. |
| Jev-in-harness | Typed recommend | “Which kit executes this accepted leaf?” — Connect honesty, not a plan node. |
| Arcana / Cruvero | Ask + durable run | Ask stays Room policy. Durability stays Compute. |

**One-liner:** Project Room’s plan is a ledger tree — proposed by
agents, accepted by humans, executed only on accepted leaves, readable
by Second / Claude / Codex over MCP, with debates that close into
action-plan receipts.

## Differentiation

| Cousin | They are | Room is |
| --- | --- | --- |
| TSP | Canvas product + hosted AI credits | Ledger SoR; canvas is a later face |
| cuddlytoddly | Single-operator planner/executor | Multi-human Room; Compute separate |
| Treequence / Conotion / Synapse / Cognograph | Spatial thinking OS | Tree first, chrome later |
| Crossfire | Terminal debate orchestrator | Debate Mode as a Work Item ritual → receipt |
| Corvus | Solo venture thinking partner | Shared Room ledger; Second is loyal, not a raven mascot |
| DecisionCanvas | Enterprise decision governance | Five-rung maturity, not 500 models |
| Cruvero / Arcana | Production / agent OS | Suppliers and Ask services, not the Room |
| Linear Agent | Issue/project composer | Compose into Mission Envelope; do not become Linear |
| Memorable | Project memory MCP | Memory on the tree + receipts |
| Jev | Kit recommend | Already in Connect shape |

## Build order (docs → product)

| Phase | Deliverable | Owner |
| --- | --- | --- |
| This PR | Landscape + Plan Tree v0 + Debate Mode v0 + indexes | Grok docs |
| Next | Work Item template fields for `planTree` + `debate` on the envelope | Grok docs |
| Later | MCP read of accepted tree for Second / Claude / Codex | after Muse ACK |
| Later | Canvas / People-rail chrome | Muse |
| Later | Compute job only from accepted-leaf ids | after bridge |

## Explicit non-goals

Become TSP / cuddlytoddly / Treequence / Linear · ship a Muse canvas ·
merge Compute Start · skip-approvals mesh · people-data in traces ·
Phase 0 #8 / #9 · Quill trees · call Second a Genie · runtime writer.

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Phase 0 #8 / #9 · Quill
trees · Compute Start · people-data · Potter keys · live writer ·
Muse UI.
