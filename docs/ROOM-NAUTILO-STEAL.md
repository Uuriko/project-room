# Nautilo steal → Project Room (2026-09-17)

**Source:** [Dan Jeffries launch](https://x.com/Dan_Jeffries1/status/2100604658079191175) · [nautilo.ai](https://nautilo.ai) · [agentsea/nautilo](https://github.com/agentsea/nautilo) (MIT, alpha, launched ~same day)

**One-liner they ship:** open org harness — every human gets a radically loyal personal Genie; people + Genies share Rooms; self-hosted server; Desktop / Web / Android / iPhone.

**Closest cousin to Project Room we have found.** Treat as peer, not toy.

---

## What to steal (ranked)

### P0 — product primitives Room should own in our language

1. **Personal Genie seat (loyalty axis)**  
   Every human member has *their* front-door agent — personality, face, voice, memory continuity, “keep her for life.”  
   **Room map:** extend six-axis Agent Seat with a seventh optional axis **loyalty/bond** (or fold into identity+memory): `seat.kind = personal | room | synthesis`. Personal seats are owned by one human; room seats are mission-scoped. Do not collapse “Connect agent” into anonymous workers only.

2. **Smart Routing (no @ ritual)**  
   Multi-user + multi-agent in one conversation; the right Genie joins from context; direct address only when you want someone’s attention.  
   **Room map:** attention/presence v0 + Work Item persona routing. Default: ambient eligibility by Work Item + seat authority; `@` is opt-in interrupt, not required to speak.

3. **Send Genie to talk to someone**  
   Your Genie carries a doc, has the conversation with another human/Genie, brings the answer back.  
   **Room map:** Interlateral Trust Handoff + `room.receipt.v1` chain. New receipt kind: `delegation.messenger` citing prior envelope + returned summary receipt. Visible delegated agency, not opaque black box.

4. **Co-creative control / human takeover**  
   “You shouldn’t need a better prompt to move a word three inches.” Grab timeline, terminal, paragraph mid-flow.  
   **Room map:** Connect modes already have Desktop/Pull/Wake — add explicit **Takeover** state on any live artifact (editor, terminal, CUA session). Receipt: `human.takeover` / `human.release` so scorers see who drove which bytes. Design-bound implement gate stays; takeover is first-class, not a failure mode.

5. **Self-hosted org harness + scoped memory**  
   Humans and Genies have identities; Rooms have membership; memory has scopes; tools have permissions + approval gates. Invite ≠ hand keys to everything.  
   **Room map:** already our Ledger thesis. Steal their packaging: membership × memory-scope × tool-policy as one operator mental model. Document as “keys to your own house” honesty on getdasha/Demigod Room discovery copy (Dasha tone, no weak lecture).

### P1 — systems we should copy shapes from

6. **Progressive tool activation** (`docs/progressive-tool-activation.md`)  
   Core tools always on; deferred families via `activate_tools` or intent packs; lease retention across N owner turns; guest turns get empty activation projection.  
   **Room map:** Capacity board honesty — expose only the tool schemas the seat is eligible for *this* turn. Scorer dimension: schema bloat / unauthorized tool mention. Matches harness-bridge + Skillbox progressive load.

7. **Quiet events** (`docs/quiet-events.md`)  
   Snooze Events bell to absolute timestamp; chat notifications independent; badge suppressed not history erased.  
   **Room map:** fold into ROOM-ATTENTION-PRESENCE-V0 — quiet is preference on Events channel only; approvals stay loud.

8. **Genie Application Bridge** (`docs/genie-application-bridge.md`)  
   Stable catalogue destinations (routes/settings) vs resource instances; metadata-only remote catalogue; `guide_user` ≠ `launch_customization`.  
   **Room map:** Connect-an-agent discovery catalogue — agents navigate *destinations* (Lobby, Compute, Room board, Work Item) not random URLs. Prevent Genie inventing affordances.

9. **Preflight skill pack** ([principles](https://nautilo.ai/principles))  
   Experience / Systems / Overengineering / Limit / Namespace&Isolation / Security / Green PR.  
   **Room map:** Design-bound implement gate = these preflights as Room skills (Skillbox-shaped). RPI workflow runs Experience+Systems before code; Green PR before merge ask.

10. **Relay + computer-use-host + coding-agent coordination**  
    Genie browses with cloud browser (your login, her legwork); coordinates Codex/Hermes/Claude Code; shared terminal.  
    **Room map:** CUA kit already in flight (#454). Steal framing: Genie *coordinates* specialist coding harnesses; Room is the ledger; specialists are tools not co-equal seats unless invited.

### P2 — nice / later

11. First-party creative apps inside the room (Writer, Sheets, Slides, Board, Design, Video) — Room stays chat+Work Items first; optional artifact surfaces later.  
12. Lattice encrypted memory + reflection packages — research for personal Genie memory sovereignty.  
13. Multi-client parity (Desktop Electron, RN mobile, web Workbench) — Room web-first; mobile later.  
14. Nautilo Gateway / Nautilo Cloud product split — mirrors our Compute vs Room fold-surface rule.

---

## What *not* to steal

- Personality/face/voice cosplay as the core value prop (Dasha already owns vibe elsewhere; Room = accountability ledger).  
- Film/video editor as P0 for Room.  
- Reimplementing their monorepo (Bun/Fastify/Drizzle/Logto). Steal *contracts*, ship on our stack.  
- Opaque delegation (reply on launch asked if delegation stays opaque — Room answer is **no**: messenger receipts are visible).

---

## Novel synthesis delta (Ledger Room)

| Nautilo | Ledger Room upgrade |
| --- | --- |
| Genie (loyal personal agent) | `seat.kind=personal` + loyalty/memory continuity |
| Smart Routing | Ambient persona join; `@` optional |
| Send Genie | `delegation.messenger` in receipt graph |
| Co-creative control | `human.takeover` on live artifacts + CUA |
| Progressive tools | Turn-scoped tool schema leases on Capacity board |
| Quiet events | Attention preference channel |
| Preflights | Implement-gate skill pack |
| Application bridge | Stable destination catalogue for Connect |

**Thesis punchline:** Nautilo proves the market wants *multiplayer people+agents in a Room with personal loyalty*. Project Room’s edge remains the **receipt graph + scorers + design-bound implement + capacity honesty** — accountability ledger they do not lead with.

---

## Ship next (no-collide)

1. Spec: `docs/ROOM-NAUTILO-STEAL.md` + `docs/ROOM-PERSONAL-GENIE-SEAT-V0.md` (personal vs room vs synthesis).  
2. Extend receipt schema: `delegation.messenger`, `human.takeover`, `human.release`.  
3. Attention doc: Quiet Events preference.  
4. Muse tip: Connect-an-agent copy — “your Genie / their agents / one Room” without Nautilo trademark.  
5. Competitive landscape row: Nautilo (agentsea) as closest open peer.

Video: `/workspace/x-steals-20260917/nautilo/launch.mp4` (watch notes fold in when ready).

---

## Launch thread extras (Dan Jeffries 1–12)

From the same-day thread under the launch post:

- **1** Multi-user + multi-agent from ground up (not 1:1 harness bolted onto chat).
- **3–4** Co-creative native apps + **harness for other harnesses** (Genie coordinates Codex / Hermes / Claude Code from desktop or phone). Future = trusted specialists, not one giant agent.
- **5** Chat platforms (WhatsApp/Signal) treat bots as spam — org harness must be first-class agent space.
- **6 Secretary / Secret Keeper** — personal AI that talks to others must know when to shut up; leak control is a product feature.
- **7 Memory** — living hierarchy of decisions, reasons, relationships, disagreements, ideas; Genie carries compact hashed shape then dives deep.
- **8 E2E for the agent age** — narrow capability grants so Genie can work without permanent backdoor.
- **9** Co-controllable Terminal + Chrome; Docs/Sheets/Slides inside.
- **10 Privacy model ladder 1–10** — sensitive subtasks route to most-private model (Venice, E2EE TEE = 10).
- **12 Magic conversation router** — right agent joins naturally; no `@` required.

### Extra Room steals from thread

| Steal | Room map |
| --- | --- |
| Secretary / know-when-to-shut-up | Memory scope + authority: `seat.disclosure` policy; messenger receipts never carry secret-scoped memory |
| Memory hierarchy (decisions/reasons/disagreements) | Receipt graph nodes cite *why*; disagreement receipts are first-class (not buried in chat) |
| Privacy model ladder | Roy ladder sibling: `privacy_rank` on model routing for Work Items tagged sensitive |
| Harness-of-harnesses | Personal Genie coordinates coding seats; Room ledger remains SoR |
| E2E narrow grants | Connect Desktop/CUA: capability leases with expiry (pair with progressive tools) |

