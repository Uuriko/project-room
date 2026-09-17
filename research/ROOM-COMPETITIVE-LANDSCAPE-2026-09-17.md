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
| Nautilo (agentsea/nautilo, MIT) | Closest open multi-user + multi-agent Room peer; Nautilo Genie loyalty → Room **Second**; Smart Routing; harness-of-harnesses; Secretary; privacy ladder |

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

### 7. Dust (context)
- Cross-company agents with permissions, human review, audit — enterprise workflow angle.
- **Steal:** Permission surfaces + audit logs as first-class (we already bias receipts).

### 8. Nautilo (agentsea/nautilo) — open org harness
- **Shape:** MIT, alpha ([nautilo.ai](https://nautilo.ai) · [agentsea/nautilo](https://github.com/agentsea/nautilo)). Self-hosted org harness: every human gets a radically loyal personal Nautilo Genie; people + Nautilo Genies share Rooms; Desktop / Web / Android / iPhone. Smart Routing (right agent joins from context; `@` optional). Harness-of-harnesses (Nautilo Genie coordinates Codex / Hermes / Claude Code). Secretary / Secret Keeper (know when to shut up). Privacy model ladder 1–10 (sensitive subtasks route to the most-private model).
- **Pain they name:** 1:1 harnesses bolted onto chat; bots treated as spam on WhatsApp/Signal; no first-class multi-user + multi-agent space.
- **Steal:** **Closest open multi-user + multi-agent Room peer.** **Second** (`seat.kind = personal`, loyalty / disclosure axis); ambient Smart Routing; visible `delegation.messenger` from your Second; `human.takeover` on live artifacts; progressive tool leases; quiet Events; preflight skill pack. Specs: [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md) · [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md).
- **Don’t:** Personality / face / voice as the core value prop; film editor as P0; reimplement their Bun/Fastify/Drizzle/Logto monorepo; opaque delegation; **Genie** as Room product language (Potter: Second only).
- **Closest cousin** — differentiate: Nautilo leads with loyal Nautilo Genie + org harness UX; Project Room stays the **accountability ledger** (receipt graph, scorers, design-bound implement, capacity honesty). Room name for that seat: **Second**.

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
| P0 | Second + Smart Routing + visible messenger (Nautilo shape) | [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) · [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md) |
| P1 | Progressive tools, quiet Events, preflights, privacy ladder (Nautilo) | Capacity-board honesty + attention preference + implement-gate skills — docs only |

## Nautilo delta (Ledger Room)

Nautilo proves the market wants *multiplayer people+agents in a Room with personal loyalty*. Ledger Room’s edge remains the **receipt graph + scorers + design-bound implement + capacity honesty**.

Specs (this PR, docs only):

- [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md)
- [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md)

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
**Project Room** = the project’s shared ledger (Work Items, receipts, people+agents, honesty) — not an IDE (HumanLayer), not an event third-space (Interlateral), not a coding-agent mesh alone (Agent Room), not a canvas chat hub (agensis/Oasis), not a Nautilo Genie org harness. Steal their membership/authority/artifact/**Second** patterns; keep Compute separate. Folded synthesis: [Ledger Room](ROOM-NOVEL-SYNTHESIS-2026-09-17.md) — six-axis seats, Work Items with receipt graphs, scorers that fail orphan claims.

## Next
1. Folded into project-room research (this note + [FULL-BUILD](ROOM-STEALS-FULL-BUILD-2026-09-17.md) index)
2. Attention modes + presence contract landed: [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) (pairs Trust Handoff; People-rail chrome later)
3. Tip Muse for People-rail presence when open
4. Ledger Room fold: [ROOM-NOVEL-SYNTHESIS-2026-09-17.md](ROOM-NOVEL-SYNTHESIS-2026-09-17.md) · [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md) · [orphan-claim](../docs/examples/scorers/orphan-claim/scorer.md)
5. Nautilo steal specs: [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md) · [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) (docs only; no People-rail / Connect HTML). Room language: **Second**, never Genie.

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
