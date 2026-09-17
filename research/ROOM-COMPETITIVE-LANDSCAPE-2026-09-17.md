# Project Room competitive / cousin landscape (2026-09-17)

Docs / research only. Cousin landscape for the steal stack. Does not
ship a live kit door, Connect panel, People-rail change, or client
diff.

Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md).

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
- **Steal:** **Identity / membership / authority / attention / memory** as separate axes (aligns Interlateral identity≠authority≠capability); machine presence + catch-up when laptop returns.
- **Don’t:** Grant channel membership ⇒ all owner secrets.
- **Contract:** [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) — attention modes + host presence. Docs only; People-rail chrome is later Muse.

### 5. HumanLayer — multiplayer coding agent workspace
- **Shape:** Tasks group sessions + artifacts + worktrees; RPI workflow (Questions→Research→Design→Structure→Plan→Implement); comment-driven design before code; local+cloud daemons; BYOK; design docs feed agents directly.
- **Steal:** **Artifacts tied to Work Item** (we have receipt.v1); phased workflow as optional Work Item templates; design comments → agent context (not orphan Notion); “do not outsource the thinking” checkpoints before implement.
- **Don’t:** Become a coding IDE — Room stays coordination ledger; Compute separate.

### 6. Factory.ai Software Factory
- **Shape:** SDLC missions, Droids, signal→action, policy/audit, self-improving factory metrics.
- **Steal:** Mission decomposition + audit/policy; metrics tied to delivered work not tokens (pairs Warp Scorers).
- **Don’t:** Full SDLC ownership claim for Room.

### 7. Dust (context)
- Cross-company agents with permissions, human review, audit — enterprise workflow angle.
- **Steal:** Permission surfaces + audit logs as first-class (we already bias receipts).

## Priority learnings for Project Room
| Priority | Learning | Action |
|----------|----------|--------|
| P0 | Separate identity / membership / authority / attention (Alook + Interlateral) | Spec authority cards + attention modes on agent members — [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) · [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md) |
| P0 | Artifacts + design comments bound to Work Item (HumanLayer) | receipt.v1 + optional design.md artifact type |
| P0 | Verified agent passport + consent for cross-owner (Agent Room) | Align Add-agent digest keys + guest consent |
| P1 | Presence + reconnect catch-up (Alook) | Agent host online indicator — [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) |
| P1 | Thread fork/merge for parallel agent exploration (agensis) | Research note only until Muse board lane |
| P1 | Wake vs pull MCP modes (Agent Room) | Document in Connect kits |
| P2 | Oasis “agents as teammates” copy | Marketing/Connect copy, not product rename |
| P2 | Factory/Warp metrics on delivered work | Scorer dashboards later |

## Differentiation one-liner
**Project Room** = the project’s shared ledger (Work Items, receipts, people+agents, honesty) — not an IDE (HumanLayer), not an event third-space (Interlateral), not a coding-agent mesh alone (Agent Room), not a canvas chat hub (agensis/Oasis). Steal their membership/authority/artifact patterns; keep Compute separate.

## Next
1. Folded into project-room research (this note + [FULL-BUILD](ROOM-STEALS-FULL-BUILD-2026-09-17.md) index)
2. Attention modes + presence contract landed: [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) (pairs Trust Handoff; People-rail chrome later)
3. Tip Muse for People-rail presence when open
