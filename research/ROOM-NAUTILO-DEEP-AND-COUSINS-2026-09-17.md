# Nautilo deep architecture + cousins → Ledger Room

**Date:** 2026-09-17 (PT)  
**Personal loyal agent name in our product:** **Second** (never “Genie” in UI/copy)  
**Research mode:** read-only; no people-data scraping; no deploy

**Landed (docs only):** product canon [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) · launch steal [ROOM-NAUTILO-STEAL.md](../docs/ROOM-NAUTILO-STEAL.md) · cousin rows [ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md). Does not edit `client/` `server/` `src/` `deploy/`.

## Sources (cite)

| Source | What it gave |
| --- | --- |
| Shallow clone `https://github.com/agentsea/nautilo` → `/workspace/x-steals-20260917/nautilo-repo` @ `c024e10` (2026-09-17) | Package contracts, conductor/Floor Manager, progressive tools, trust envelopes |
| [nautilo.ai](https://nautilo.ai) · [docs](https://nautilo.ai/docs) · [use](https://nautilo.ai/docs/use) · [operator](https://nautilo.ai/docs/operator) · [build](https://nautilo.ai/docs/build) · [security](https://nautilo.ai/docs/security) · [skills](https://nautilo.ai/skills) · [principles](https://nautilo.ai/principles) | Product architecture language |
| Repo docs: `README.md`, `README.ai`, `AGENTS.md`, `docs/progressive-tool-activation.md`, `docs/genie-application-bridge.md`, `docs/relay-host-ownership.md`, `docs/connected-web-browser-contract.md`, `docs/quiet-events.md` | Stealable seams |
| Cousin primary pages (below) | New competitive set |

---

## 1. Repo skim — key packages / types / contracts

Monorepo (`nautilo-monorepo`): Bun + Turbo; apps = Workbench / Desktop / Mobile / CLI; core under `packages/*`.

| Package | Name | Role (header contract) | Key types / seams |
| --- | --- | --- | --- |
| **agent** | `@nautilo/agent` | One LangGraph turn: `pre_model → agent → post_model → tools`; worker + review graphs | Tool catalogue registration (`tools/register-all.ts`); `ask_peer`, `activate_tools`, memory/task shortcuts; **never** imports runtime |
| **runtime** | `@nautilo/runtime` | Cross-turn coordinator: jobs, lane locks, coalescing, policy, event bus, observer, relay registry | `ConductorDecision` (`wake` / `ask_user` / `silent`); `RoomMemberView`; Floor Manager; `RoutingPacket`; `MemoryAccessEnvelope` plumbing |
| **trust** | `@nautilo/trust` | PolicyResolver, Logto, room/agent queries | `NamespaceMemoryEnvelope` vs `ScopeMemoryEnvelope`; `ToolAccess` = allow \| read_only \| require_prove_it \| forbidden; `RuntimePolicyContext`; human blocks |
| **security** | `@nautilo/security` | Command scan, path deny, content scan, severity/approval verbs | `SecurityLevel` yolo→paranoid; `ApprovalVerb`; standing approvals live in trust DB (not in-memory) |
| **reflection** | `@nautilo/reflection` | Stenographer + organizer + sleep | `RoomEventKind` (decision, commitment, goal, …); `StenographerProposal`; `RecordSnapshot` / lifecycle |
| **lattice-bridge** | `@nautilo/lattice-bridge` | Encrypted memory / artifact crypto integration | Human memory read acknowledgements; foreground processor transport; artifact publication plans |
| **computer-use-host** | `@nautilo/computer-use-host` | Signed headless CUA Host | `ComputerUseHost`; native + browser runtimes; contracts in `@nautilo/computer-use-contracts` (`retrySafety`, `do_not_replay` on unknown state) |
| **relay** | `@nautilo/relay` | Protocol between server and desktop/device relays | `RelayCapabilities`; `ToolPolicy`; device-relay vs desktop-agent profiles; shell redaction helpers |
| **catalog** | `@nautilo/catalog` | Sole tool registry | `ToolRegistration`; `CatalogSnapshot`; `ProgressiveToolResolution` (eligible vs exposed vs instantiated) |

**Identity spine (README.ai / AGENTS.md):** keep explicit — Human · Genie(=**Second**) · Room · Task · Namespace · Memory · Artifact · device. Discovery ≠ execution. Consent (PIN/`prove_it`) ≠ authorization.

**Room membership (types):** `RoomMemberDto.kind = user | agent`; `roomRole = admin | member`; agents carry `agentResponseMode = active | mention_only | observe`, plus **owner** fields (`agentOwnerUserId/Handle/DisplayName`). Room kinds include private / group / open / subthread / multi_agent / task / access. Create paths: `personalAgentId` (1:1 with own agent), `directHumanUserId` (DM), or explicit `members[]`.

**Memory scopes:** Room-anchored **namespace** envelope (readable/mutable/writable namespaces via Room-subset rule) vs subagent **scope** envelope (`scopeId` + `memory_scopes` only). Invite to a Room ≠ keys to every Namespace.

**Smart Routing:** group-room **Conductor** + **Floor Manager**. Deterministic routes first (mention / reply / UI select); ambiguous → cheap FM LLM that may only emit handles (never raw IDs); failure → **silence**. Modes: `conductorMode: standard | advanced` (advanced = call-buyer / human-aware arbitration). UI label: “Smart routing”. Invariant: one human message wakes **0 or 1** bot unless explicit multi-address.

**Messenger / Secretary shapes in code (map → Second):**
- Messenger ≈ `ask_peer` task shortcut: agent DMs a peer, parks on `await_reply`, returns summary; optional artifact grant without a shared Room.
- Secretary / disclosure ≈ identity + memory-scope + tool-policy + mute/observe + human blocks + partial-result disclosure rules (Connected Website contract: disclose incomplete outcomes; never leak credentials to the agent).
- Progressive tools: core always (after eligibility); families deferred; `activate_tools` / intent packs; lease retention default **3** owner foreground turns; **guest turns empty activation projection**.

**Genie → Second map (product language only):**

| Nautilo term | Ledger Room term |
| --- | --- |
| Genie | **Second** |
| personal 1:1 / owned agent | `seat.kind=personal` |
| Smart Routing / Conductor / Floor Manager | Ambient Second + specialist wake |
| `ask_peer` | Messenger (`delegation.messenger`) |
| memory scopes + Secret Keeper posture | disclosure axis + `disclosure.deny` |
| Human takeover (browser/terminal/Writer) | `human.takeover` / `human.release` |
| progressive tool activation | progressive tool **lease** |
| prove_it / approvals | authorization receipts (not cosplay) |
| Application Bridge destinations | Connect catalogue destinations |

---

## 2. Docs architecture summary

**Product pitch:** open-source **organization-level AI harness** — people and machine people create/communicate/work side by side; you run the Server; you choose models; you own the intelligence ([docs hub](https://nautilo.ai/docs), [README](https://github.com/agentsea/nautilo)).

**Room:** shared place for humans + their personal agents; Threads/Subthreads hang off messages; Writer/Board/etc. are co-editable artifacts with accept/reject proposals ([first hour](https://nautilo.ai/docs/use/first-hour)).

**Membership:** Humans and agents are first-class members; agents are **owned** by a human; response modes control wakeability; Smart Routing is an admin toggle on group rooms.

**Memory scopes:** Namespace(Room) sharing rules + private scope bags for subagents; Lattice path for protected memory (E2E still “in progress” on [security](https://nautilo.ai/docs/security)).

**Smart Routing:** Talk naturally; right agent joins; direct address when you want attention (README). Implementation = Conductor + Floor Manager above.

**Secretary:** Not a separate product page title in public docs; the *behavior* is loyalty + disclosure: personal agent that knows boundaries, mutes, and when not to speak — Room steals this as **disclosure axis** on Second.

**Progressive tools:** [progressive-tool-activation.md](https://github.com/agentsea/nautilo/blob/main/docs/progressive-tool-activation.md) — core vs families; lease ≠ authority.

**Security trust boundary:** claimed org Server; operator-owned provider keys; scoped approvals (once / Room / server-wide / deny); hosted models cross boundary by choice; E2E incomplete; federation/local models planned ([security](https://nautilo.ai/docs/security)).

**Principles / skills:** Experience, Systems, Overengineering, Limit, Namespace & Isolation, Security, Green PR preflights ([principles](https://nautilo.ai/principles), [skills](https://nautilo.ai/skills)).

---

## 3. Nautilo → Room steals (P0 / P1 / P2)

### P0 — ship shapes soon

1. **Second seat (`seat.kind=personal`)** — every human member has one durable loyal front-door agent; workers stay `room`; integrators stay `synthesis`.
2. **Smart Routing** — ambient wake by Work Item + attention + roster modes; `@` optional interrupt; silence over wrong wake.
3. **Messenger receipts** — Second may talk to another human/seat and return; chain visible (`delegation.messenger`).
4. **Disclosure / Secretary** — seventh seat axis; `disclosure.deny` when scoped memory must not leave the owner circle.
5. **Human takeover** — first-class on artifact/terminal/CUA; `human.takeover` / `human.release` scored.
6. **Membership × memory-scope × tool-policy** as one operator mental model (“keys to your own house”).

### P1

7. Progressive tool leases (Capacity board honesty; guest empty projection).  
8. Quiet Events (bell snooze ≠ erase; approvals stay loud).  
9. Application Bridge destinations (Connect catalogue = stable destinations, metadata-only remote updates).  
10. Preflight skill pack (Experience/Systems before implement; Green PR before merge ask).  
11. Harness-of-harnesses (Second coordinates Codex/Claude/CUA specialists; Room ledger = SoR).  
12. `ask_peer`-shaped messenger with optional artifact grant without forcing a shared Room.

### P2

13. Stenographer-style room event journal (decision/commitment/goal) as receipt enrichment.  
14. Lattice-style protected personal memory (research only until crypto coverage is honest).  
15. First-party creative apps inside Room (after chat + Work Items + Connect are solid).  
16. Relay Host ownership split (protocol vs Electron authority) when Desktop Connect deepens.

### Skip

Genie cosplay / face-voice as core value · film editor as Room P0 · reimplement Bun/Fastify/Logto monorepo · opaque delegation · treating specialist harnesses as co-equal seats unless invited.

---

## 4. NEW cousins (not in prior covered set)

Already covered elsewhere — do **not** re-rank: Interlateral, Oasis, agensis, Agent Room, Alook, HumanLayer, Factory.ai, Warp Scorers, Skillbox, harness-bridge, CUA, hraness, OpenHarness/ohmo.

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

---

## 5. Novel synthesis — Ledger Room + **Second**

Nautilo proves the category: **multiplayer people + personal agents under an org Server**. Room’s wedge is not a prettier Genie — it is:

**Second** (loyal personal seat + disclosure)  
+ **receipt graph** (no orphan claims; messenger/takeover/deny are typed)  
+ **scorers / design-bound implement**  
+ **Capacity + progressive tool leases** (honest schema surface)  
+ **Connect modes** (Wake / Pull / Desktop / Takeover)  
+ **harness-of-harnesses** (Second coordinates; ledger SoR)

qm’s personal/shared scopes and Dust’s dual permissions reinforce our membership×memory×tool model. Magentic-UI and Nautilo Connected Website agree: **human takeover is a feature**. Greenroom’s wake≠spawn and AgentsMesh Autopilot handback sharpen attention/presence.

---

## 6. Concrete schemas / receipts to add

Wire-level shapes for `room.receipt.v1` (illustrative JSON Schema fragments). All times ISO-8601; ids opaque; never put secrets in `summary`.

### 6.1 `Second.bind` (alias `seat.bind` for personal)

```json
{
  "kind": "Second.bind",
  "version": 1,
  "roomId": "room_…",
  "seat": {
    "seatId": "seat_…",
    "kind": "personal",
    "displayName": "Second",
    "ownerHumanId": "human_…"
  },
  "axes": {
    "identity": true,
    "membership": true,
    "authority": "owner_delegated",
    "attention": "ambient_eligible",
    "memory": ["ns_owner_private", "ns_room_shared?"],
    "presence": "online|away|quiet",
    "disclosure": "secretary_v0"
  },
  "policyRef": "policy_…",
  "boundAt": "2026-09-17T21:57:00-07:00"
}
```

`Second.unbind` mirrors with `reason` (`owner_left` | `revoked` | `room_archived`).

### 6.2 `delegation.messenger`

```json
{
  "kind": "delegation.messenger",
  "version": 1,
  "fromSeatId": "seat_…",
  "fromOwnerHumanId": "human_…",
  "to": { "type": "human|seat", "id": "…" },
  "outboundMessageRef": "msg_…",
  "awaitState": "parked|answered|timed_out|denied",
  "returnSummaryRef": "msg_…",
  "artifactGrants": [{ "artifactId": "art_…", "sensitivity": "normal|sensitive" }],
  "citesEnvelopeId": "env_…",
  "completedAt": "…"
}
```

Maps from Nautilo `ask_peer` (message_to_peer literal, return_instructions, include_focused_artifacts).

### 6.3 `disclosure.deny`

```json
{
  "kind": "disclosure.deny",
  "version": 1,
  "seatId": "seat_…",
  "ownerHumanId": "human_…",
  "audience": { "type": "room|human|seat|tool", "id": "…" },
  "blocked": {
    "memoryScopeIds": ["scope_…"],
    "namespaceIds": ["ns_…"],
    "toolNames": ["…"],
    "reasonCode": "secret_scope|peer_blocked|guest_projection|policy"
  },
  "userVisible": "I can't share that outside your private scope.",
  "citesPolicyRef": "policy_…"
}
```

### 6.4 `human.takeover` / `human.release`

```json
{
  "kind": "human.takeover",
  "version": 1,
  "humanId": "human_…",
  "previousDriver": { "type": "seat|harness", "id": "…" },
  "surface": "writer|terminal|cua|browser|board",
  "resourceRef": "art_…|session_…",
  "standDownSeat": true,
  "at": "…"
}
```

`human.release` returns driver to `seat` or `harness` with `bytesAuthoredBy` for scorers.

### 6.5 Progressive tool lease

```json
{
  "kind": "tool.lease",
  "version": 1,
  "seatId": "seat_…",
  "ownerHumanId": "human_…",
  "mode": "progressive|eager",
  "coreAlways": ["activate_tools", "deactivate_tools", "search_memory", "…"],
  "activated": [
    { "name": "run_shell", "family": "shell", "idleAgeTurns": 0, "expiresAfterOwnerTurns": 3 }
  ],
  "guestProjection": "empty",
  "note": "Lease is selection hint only; live admission still applies."
}
```

Align with Nautilo: default retention 3; deactivate clears lease; ineligible → schema disappears immediately.

---

## 7. Ship next (actionable)

1. Keep [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) as product canon; rename any remaining Genie seat docs → Second.  
2. Add receipt kinds above to `ROOM-RECEIPT-V1` / conformance pilot (later; not this fold).  
3. Wire Smart Routing rules into attention/presence v0 (wake 0|1; silence on FM fail).  
4. Muse/Connect copy: “your Second / their agents / one Room.”  
5. Competitive landscape: add qm, Dust, Magentic-UI, Greenroom, AgentsMesh rows (plus Patchwork / KaibanJS / Nomos / ai-room) — [ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md](ROOM-COMPETITIVE-LANDSCAPE-2026-09-17.md).

