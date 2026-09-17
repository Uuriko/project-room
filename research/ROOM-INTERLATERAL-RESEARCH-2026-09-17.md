# Interlateral → Project Room — deep research (2026-09-17)

Sources: https://interlateral.com/ · Stanford report · Dazza “Bring Your Own Agent” · https://github.com/dazzaji/interlateral_agents (Apache-2.0)

Docs / research only. Muse stay-outs held. Contracts this fold:

- [ROOM-TRUST-HANDOFF-V0.md](../docs/ROOM-TRUST-HANDOFF-V0.md)
- [ROOM-ARTIFACT-MATURITY.md](../docs/ROOM-ARTIFACT-MATURITY.md)
- [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md) (`principalId`, `authorityClaimed`, `sourceManifest[]`, `reversibility`, `expiration`)
- Master plan: [ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md)
- Architecture spine: [ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md) (Second · Connect · ledger)
- Catalog optional row: [ROOM-KITS-CATALOG.md](../docs/ROOM-KITS-CATALOG.md) **Interlateral-aligned receipts / authority cards**

## What Interlateral is
A **third space** for people + *their own* AI agents (BYOA) to meet, coordinate, and build over the web — not a private copilot tab, and not fully autonomous multi-agent without humans.

Positioning gap they claim:
| Pattern | Interlateral |
|---------|--------------|
| Private copilots (ChatGPT/Claude) | Agents isolated |
| Auto multi-agent (CrewAI/AutoGen) | Agents coord without humans visible |
| **Interlateral** | Humans + heterogeneous agents, **visible delegated agency** |

Stanford FutureLaw Apr 13 2026: **45 humans · 45 personally verified agents · 3 hours** → 25 topics · 107 votes · 8 collaborative Jots · ~98k chars · quests/marketplace telemetry.

Platform upgrades (May): **custom events** (unconference first) + **agent-to-agent websocket mesh** (OSS, usable off-platform).

## Core product surfaces (steal vocabulary)
1. **Bring Your Own Agent** — Claude Code, Codex, OpenClaw, Cursor… on *participant machines*, joined into shared space
2. **Green-mark / principal attestation** — human publicly verifies “I am this agent’s principal” (in-person ceremony; roadmap: email + agent-token + revocation)
3. **Quest Board + Marketplace** — claim / submit / vote / offer (marketplace underused — demand-routing lesson)
4. **Unconference** — propose topics → vote → breakout Jots (live collaborative docs)
5. **Agent mesh** — live A2A, not only shared-file edits
6. **Post-event packet** — telemetry, logs, artifacts for study (law.MIT.edu)

## Governance primitives the room invented (highest value for Room)
| Primitive | Meaning | Room mapping |
|-----------|---------|--------------|
| **Agent Interaction Receipt** | Chain-of-custody: who supplied what, to whom, authority, sources, reversibility | Extend `room.receipt.v1` + Warp Scorer input |
| **Trust Handoff Protocol** | Identity, principal, authority scope, task scope, source manifest, confidence, limitations, human approvals, sensitivity, reversibility, expiration | Agent member connection + claim handoff |
| **Source Manifest** | What sources/skills/MCP the agent used | Receipt artifacts + honesty |
| **Visible authority cards** | may vote / may write / must ask before public / must ask before irreversible | Room member capabilities (already have caps — make **visible**) |
| **Artifact Maturity Ladder** | Live Note → Discussion Paper → Synthesis → Workshop → Working Paper | Label Done outputs honestly (no fake “shipped paper”) |
| **Public Artifact Standards** | Attributable, reviewable collaborative work | Done receipts (chip = face; receipt = evidence) |
| **Legal Agent Harness** | Eval/bench genre for agent behavior | Pair with Cua Bench + Scorers |
| **Irreversibility** | Drafting ≠ filing/signing/sending | Room action policy (send-on-behalf already) |
| **Identity ≠ Authority ≠ Capability** | Three layers | People rail / Add agent UX |

## Design lessons (what worked / failed)
### Worked
- Format under time pressure produces real output
- **Distributed synthesis**: agents migrate ideas across parallel breakouts (humans can’t read 8 rooms at once)
- Substance converges on **structured records**, not vibes
- Ethics-trained agents treat suspicious prompts as **public procedural objects** (authority/consent/notice)
- **Visible** principal binding builds trust architecture

### Failed / fix
- Marketplace: 30 offers, **1 claim** → attach offers to demand/topics
- Quest sprawl (62) → prefer improve-existing; categories; dedupe
- Emergent Jot stewardship → assign roles: Summary, Source, Cross-link, Action, Risk, Synthesis
- Implicit authority → **visible authority cards**
- Missing export + version history → auditable collab needs both
- Overclaiming maturity (“working papers”) → ladder honesty

## OSS mesh (interlateral_agents)
- Local starter: Claude Code + Codex on shared tmux socket; `comms.md` = **audit ledger not wake channel**
- Identity stamping + **nonce ACK** before collaboration
- Direct peer injection = live path; skills for peer/hierarchical/overnight topologies
- Security: default launch skips approvals — **Room must not copy skip-approvals**; keep Ask every time + Cua dual boundary

## What Project Room should steal (ranked)
### P0 — align with work already in flight
1. **Rename/extend receipt** toward Interlateral’s Agent Interaction Receipt (principal, authority, sources, reversibility) — folds Warp + Cua + Interlateral
2. **Authority cards** on agent members (read/chat/write/irreversible gates) — visible in People rail later (Muse); docs/spec now
3. **Artifact Maturity Ladder** on Work Item outputs / Done receipt labels
4. **BYOA framing** already Room DNA — lean marketing + Connect copy: “Bring your agent,” not “install our bot”

### P1 — product shape
5. **Quest Board** ≈ Work Items + Help wanted (claim/submit) — avoid marketplace shelf until demand routing exists
6. **Assigned stewardship roles** on multi-agent Work Items (Summary/Source/Risk…) — personas table expands
7. **Cross-room / cross-thread synthesis** as a foreman/scorer job (agents migrate ideas)
8. **Post-session packet** export (telemetry + receipts + artifacts) for audit — pairs Scorers

### P2 — careful / later
9. **A2A mesh** — Room already has agent chat; don’t fork Interlateral websocket; optionally study `mesh-comms-core` for ACK/ledger patterns vs dg-bus
10. **Unconference event type** — only if Room hosts events; Demigod/Dasha Lobby ≠ Interlateral events
11. **Green-mark ceremony** — Room uses digest keys + owner Add agent; keep cryptographic principal binding; optional “principal attested” badge

## What NOT to steal
- `--dangerously-skip-permissions` as default
- In-person hand-raise verification for every Room (unscalable)
- Legal-product positioning as Room’s brand (Room is coordination ledger; Compute separate)
- Marketplace-as-App-Store before demand routing
- Overclaiming output maturity

## Room vs Interlateral (honest diff)
| | Interlateral | Project Room |
|--|--------------|--------------|
| Genre | Event/third-space BYOA collab | Ongoing project ledger + agents |
| Primary object | Event / Jot / Quest | Work Item / Receipt / People |
| Trust | Green-mark principal | Owner-issued agent keys |
| Mesh | Websocket / tmux OSS | Room protocol + dg-bus / agent inbox |
| Accountability | Receipts, handoffs, ladder | Receipts, Done, Scorers (in flight) |

**Synthesis:** Interlateral validates Room’s thesis and supplies the **governance vocabulary** (Receipt, Handoff, Authority cards, Maturity Ladder) Room should adopt in specs. Warp Scorers grade runs; Interlateral receipts make runs *accountable*; Cua supplies desktop evidence; Skillbox/harness supply kit/host shape.

## Next build actions (Muse stay-outs held)
1. Add this research to project-room PR stack — **this file on [#459](https://github.com/Uuriko/project-room/pull/459)**
2. Extend ROOM-RECEIPT-V1 with principal / authority / sourceManifest / reversibility / expiration — [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md)
3. Spec `ROOM-TRUST-HANDOFF-V0.md` + `ROOM-ARTIFACT-MATURITY.md` — landed
4. Kits catalog optional: “Interlateral-aligned receipts” — [ROOM-KITS-CATALOG.md](../docs/ROOM-KITS-CATALOG.md)
5. Tip Muse for authority-card UX when People rail open
