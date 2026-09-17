# Project Room — novel synthesis from the steal stack
**2026-09-17 · finish stealing + brainstorm novel synthesis**

Docs / research only. Muse stay-outs held. Does not ship a live kit
door, Connect panel, People-rail chrome, or client diff.

**Superseded for “what is Room” decisions** by the cohesive
architecture SoR:
[ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md)
(dated copy:
[ROOM-COHESIVE-ARCHITECTURE-2026-09-17.md](ROOM-COHESIVE-ARCHITECTURE-2026-09-17.md)).
Keep this note as the pre-collapse synthesis; do not fork ship/no-ship
calls here.

This fold:

- Receipt graph contract: [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md)
- Orphan-claim scorer: [examples/scorers/orphan-claim/scorer.md](../docs/examples/scorers/orphan-claim/scorer.md)
- Cousin landscape: [ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md)
- Master plan: [ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md)

## Steal stack (inputs)
| Source | Kernel steal |
|--------|----------------|
| Interlateral | BYOA third space; Agent Interaction Receipt; Trust Handoff; authority cards; Artifact Maturity Ladder; stewardship roles |
| Warp Scorers | Sampled LLM-judge on past runs; one dimension; self-improve → human-merge PRs |
| Cua | Desktop/Fleet evidence in receipts; dual safety boundary |
| Skillbox + Jev | Versioned kits; typed kit recommend |
| harness-bridge | Provider · model · harness honesty; inert+reason |
| hraness | N× parallel capacity; limit honesty |
| Oasis | Agents as teammates in Rooms; shared memory compounds |
| agensis | Member agents (name/door/memory); thread fork→merge; seat-free agents |
| Agent Room | Passport identity; task claim/handoff; wake vs pull; cross-owner consent |
| Alook | Identity ≠ membership ≠ authority ≠ attention ≠ memory; presence + catch-up |
| HumanLayer | Task = sessions+artifacts+worktrees; design comments feed agents; RPI checkpoints |
| Factory.ai | Missions; audit/policy; metrics on delivered work |
| CrewAI / LangGraph / OpenHands | Role crews vs stateful graphs vs coding control plane — frameworks, not Rooms |
| Slack/Discord bots | Presence is coarse; bots ≠ first-class members with separate authority |

## What Project Room already is (keep)
- Shared **project ledger**: Work Items, People, receipts
- BYOA Connect (packet / ga1. / Add agent)
- Compute stays a **separate** run factory
- Honesty over marketplace theater

## Novel synthesis — “Ledger Room”
Not chat-with-bots. Not an IDE. Not an event third-space. Not a crew framework.

**Thesis:** The Room is the **system of record for collaborative agentic work**. Chat is a projection. Compute is a supplier. Desktops are evidence devices. Scorers are auditors.

### 1. Six-axis Agent Seat (product primitive)
Every agent member carries an explicit seat card:

`identity · membership · authority · attention · memory · presence`

UI later (Muse People rail): six chips, never collapsed into one “bot” badge.
Spec: [ROOM-ATTENTION-PRESENCE-V0.md](../docs/ROOM-ATTENTION-PRESENCE-V0.md) + [Trust Handoff](../docs/ROOM-TRUST-HANDOFF-V0.md) + authority cards.

**Novel twist:** Changing one axis is a **logged receipt event** (who changed attention from mentions→all), so scorers can grade permission drift.

### 2. Work Item as Mission Envelope
HumanLayer Task + Factory Mission + Interlateral Jot, folded:

```
Work Item
  personas[]      # foreman/triage/implementation/review/scorer
  stewards{}      # Summary/Source/Cross-link/Action/Risk (Interlateral fix)
  artifacts[]     # design.md, plan.md, PR, screenshot (HumanLayer)
  receipt_graph   # DAG of Agent Interaction Receipts (novel)
  maturity        # Artifact Maturity Ladder rung
  scores[]        # Warp scorer classifications
```

**Novel:** `receipt_graph` — when Agent B relies on Agent A’s output, B’s receipt **cites** A’s receipt id (Trust Handoff made structural). Scorers can fail “orphan claims” (assertions without cited receipts).

Contract: [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md).
Scorer: [orphan-claim](../docs/examples/scorers/orphan-claim/scorer.md).

### 3. Design-bound implement gate
HumanLayer RPI without becoming an IDE:
- Optional Work Item template: Questions → Research → Design (commentable) → Structure → Plan → Implement
- Implementation persona **cannot claim** until Design artifact ≥ Discussion Paper rung **or** owner waive receipt
- Design comments are Room events that append to the design artifact (not orphan Notion)

### 4. Connect modes: Wake · Pull · Desktop
Agent Room wake/pull + Cua:
| Mode | Behavior |
|------|----------|
| Wake | Room pushes mentions/assignments to enrolled host |
| Pull | Agent fetches notices on its schedule (MCP packet) |
| Desktop | Cua Fleet/Driver claim attached to Work Item for GUI evidence |

Harness-bridge honesty sits under Connect: endpoint · live models · harness (inert+reason).

### 5. Accountability loop (not vanity scores)
Warp + Interlateral + Factory metrics:
1. Done → receipt.v1 (artifacts + optional Cua)
2. Sampled Scorer personas (task-compliance, efficiency, people-data-safe, procedure, orphan-claim)
3. Failures → observer proposes kit/instruction PR (**human merge only**)
4. Dashboard: pass rate by persona / host — **delivered Work Items**, not tokens

### 6. Capacity board (hraness × Factory)
People rail / Runs view: tiled claim panels by host (m1 capacity N, Fleet replicas M). When Astra/Fable/provider exhausted: fail-loud + route to fast-default (Roy ladder). Never rename models.

### 7. Synthesis agent as first-class persona
agensis fork/merge + Interlateral distributed synthesis:
- `synthesis` persona may read parallel Work Item threads and open a **Synthesis Memo** (maturity rung 3) citing receipt_graph edges
- Humans approve merge into parent Work Item — no silent overwrite

### 8. Soft Quest Board (Interlateral marketplace lesson)
Help wanted = improve-existing bias; offers attach to Work Item demand, not a free-floating marketplace (Amp/Meta ladders still hold — no fake App Store).

## Differentiation one-liner
**Project Room is the accountability ledger for humans and BYO agents — seats with six axes, Work Items with receipt graphs, scorers that improve kits, Compute and desktops as evidence suppliers.**

## Build order (docs → product)
| Phase | Deliverable | Owner |
|-------|-------------|-------|
| Done | Receipt v1, Scorer, Personas, Interlateral, Landscape, Attention/Presence | Grok docs |
| This PR | Spec `receipt_graph` + orphan-claim scorer example | Grok docs |
| Next | Work Item template “RPI-lite” markdown | Grok docs |
| Later | People-rail six-axis chips + presence | Muse |
| Later | Scorer cron on staging | after Muse ACK |
| Later | Cua Fleet claim button | after secrets |
| Later | Jev recommend_kits | TypeSafe key |

## Explicit non-goals
Become HumanLayer IDE · Interlateral events platform · CrewAI Studio · Slack bot · Compute Start blob · skip-approvals mesh · people-data in screenshots

## Stay-outs
`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Phase 0 #8 / #9 · Quill
trees · Compute Start · people-data · Potter keys · live writer.
