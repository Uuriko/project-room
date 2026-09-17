# ROOM-SECOND-V0 — Personal loyal agent for Project Room

**Status:** product spec v0 (2026-09-17 PT)  
**Name:** **Second** — never use “Genie” (or familiar/cosplay names) in product UI, onboarding, or marketing examples.  
**Seat:** `seat.kind = personal`  
**Sources (research, not branding):** Nautilo personal-agent + Smart Routing + progressive tools + human takeover; qm personal/shared scopes; Magentic-UI co-tasking/takeover; Dust dual permissions. Room owns the language and the receipt graph.

---

## 1. One line

Every human Room member has a **Second** — a durable, loyal, disclosure-aware front-door agent that coordinates specialists, talks for them only when allowed, and leaves receipts.

---

## 2. Voice (product copy — use these)

| Do say | Don’t say |
| --- | --- |
| “Meet your Second.” | Anything with Genie / familiar / cosplay pet names as the product noun |
| “Send your Second.” | “Spawn a worker to impersonate you” |
| “Your Second brought it back.” | Opaque “the agent handled it” |
| “Take over — your Second stands down.” | “Abort the bot” as the only framing |
| “Your Second won’t share that outside your private scope.” | Silent drop with no receipt |
| “Smart routing woke the right seat.” | “@ everyone until someone answers” |

**Tone:** calm, loyal, competent secretary — not a mascot. Personality customization (name/voice) is optional skin; the product noun stays **Second**.

---

## 3. Seat model

| Field | v0 value |
| --- | --- |
| `seat.kind` | `personal` |
| Owner | Exactly one human (`ownerHumanId`) |
| Lifetime | Durable across Rooms on the same org Server |
| Display default | “Second” (user may rename locally; system kind unchanged) |
| vs `room` seats | Mission-scoped workers; not loyal-for-life |
| vs `synthesis` seats | Cross–Work Item integrators; never orphan claims |

### Axes (extends six-axis Agent Seat)

1. **identity** — Second is a first-class actor, owned by one human  
2. **membership** — present in Rooms the owner joins (or is invited into as the owner’s Second)  
3. **authority** — only what owner + Room policy grant; discovery ≠ execution  
4. **attention** — ambient eligibility + mute/observe modes  
5. **memory** — private owner scopes + Room namespaces per policy  
6. **presence** — online / away / quiet (Quiet Events ≠ mute approvals)  
7. **disclosure** — **Secretary**: what Second may say to whom (`disclosure.deny` when blocked)

---

## 4. Loyalty

Loyalty means:

- Prefer the **owner’s** interests, secrets, and standing instructions over peer pressure in a shared Room.  
- Do not widen authority when invited into a larger membership.  
- When asked to share secret-scoped memory, **refuse with a receipt** (`disclosure.deny`) rather than hallucinate compliance.  
- When the owner takes over a surface, stand down cleanly (`human.takeover`) and resume only on `human.release`.  
- Never treat a specialist harness (coding CLI, CUA, browser) as a co-equal “peer human”; they are tools Second coordinates under the ledger.

Loyalty does **not** mean: lying for the owner, bypassing org policy, or hiding messenger activity from the receipt graph.

---

## 5. Disclosure / Secretary

**Secretary** is the disclosure behavior of Second, not a second product.

Rules:

1. Default speak only what Room-shared namespaces and the active Work Item allow.  
2. Owner-private memory stays private unless the owner explicitly grants a share (and the grant is receipted).  
3. Guest / non-owner turns get an **empty progressive-tool projection** and no owner lease aging.  
4. Peer blocked by owner → no messenger, no soft leak via summary.  
5. Partial or uncertain tool outcomes must be labeled incomplete (borrow Connected Website honesty).  
6. Every hard refuse emits `disclosure.deny` with a user-visible one-liner and a machine `reasonCode`.

Copy example: “I can’t share that outside your private scope.”

---

## 6. Smart Routing

**Goal:** multi-human + multi-seat Rooms without an `@` ritual.

| Rule | Behavior |
| --- | --- |
| Default | One inbound human message wakes **0 or 1** seat |
| Explicit | Mentions / UI select / reply-to may wake the addressed seat(s) |
| Ambient | Work Item + attention + `agentResponseMode`-like flags (active / mention_only / observe) |
| Ambiguity | Ask user or stay silent — never wake the wrong Second |
| Failure | Prefer **silence** over a confident wrong wake |
| Admin | Room may toggle advanced routing; non-admins see status only |

`@Second` remains available as an interrupt, not a requirement to be heard.

---

## 7. Messenger

Second can be sent to another human or seat:

1. Carry a literal message (and optional artifact grant).  
2. Park awaiting reply.  
3. Return a summary to the originating Room / Work Item.  
4. Emit `delegation.messenger` citing the prior Mission Envelope / receipt.

Visible delegated agency — not a black box. Scorers can see outbound, await state, and return.

---

## 8. Harness-of-harnesses

Second is the **coordinator**, not a replacement for coding/desktop harnesses.

| Layer | Owns |
| --- | --- |
| Room ledger | Work Items, receipts, membership, scorers |
| Second | Routing, disclosure, messenger, progressive tool selection, human handoff |
| Specialist harnesses | Codex / Claude Code / CUA / browser / shell — invoked under policy |
| Connect modes | Wake / Pull / Desktop / **Takeover** |

Remote catalogues may refresh labels; they must not invent executable destinations. Stable destinations only (Lobby, Compute, Room board, Work Item, Settings).

---

## 9. Progressive tools

- **Core** schemas always eligible after admission (discovery, memory search, activate/deactivate, turn control).  
- **Deferred families** (shell, filesystem, browser, desktop, …) via activation or reviewed intent packs.  
- **Lease:** default retain across ~3 owner foreground turns; unused ages out; deactivate clears.  
- Lease is a **selection hint**, not authority — live policy/relay/health gates still apply.  
- Capacity board shows exposed vs eligible counts for honesty.

Receipt: `tool.lease` (optional v0; required when Capacity scorers ship).

---

## 10. Human takeover

Surfaces: Writer/editor, terminal, CUA session, connected browser, board.

Flow:

1. Owner grabs control → `human.takeover` (Second stands down if `standDownSeat: true`).  
2. Owner drives bytes; scorers attribute authorship to human.  
3. Owner returns control → `human.release` with next driver (`seat` or `harness`).

Copy: “Take over — your Second stands down.” / “You’re back — Second is ready.”

---

## 11. Required receipts (v0)

| Kind | When |
| --- | --- |
| `Second.bind` / `seat.bind` | Personal seat attached to owner in a Room |
| `Second.unbind` / `seat.unbind` | Detach / revoke / archive |
| `delegation.messenger` | Messenger round-trip (or timeout/deny) |
| `delegation.spawn` | Second or factory `foreman` mints a named specialist `room` seat (same-rung allowed). Cites parent receipt. Not a second personal agent. Never Genie. Research: [ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](../research/ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md) |
| `disclosure.deny` | Secretary block |
| `human.takeover` | Owner grabs surface |
| `human.release` | Owner returns surface |
| `tool.lease` | Progressive activation set changes (P1) |

All cite prior envelopes where applicable. No orphan claims.

---

## 12. Onboarding (first hour shape)

1. Human joins Server / Room.  
2. System binds **Second** (`Second.bind`) if missing.  
3. Optional: rename/voice — skin only.  
4. Open a Room with Second; send a plain message (Smart Routing path).  
5. Create or open one artifact; ask Second to propose; accept/reject.  
6. Optional: Send Second (messenger) or Take over once to prove handoff.

Success = durable work + receipts, not a settings tour.

---

## 13. Non-goals (v0)

- Face/voice avatar cosplay as the core value prop  
- Film/video editor as Room P0  
- Reimplementing any third-party monorepo  
- Opaque delegation  
- Replacing org policy with “loyal means above the law”  
- Using the word Genie in product copy examples

---

## 14. Acceptance checks

- [ ] Every human member can see exactly one `seat.kind=personal` Second  
- [ ] Group Room can complete a turn with no `@` and ≤1 wake  
- [ ] Messenger produces `delegation.messenger` with return or timeout  
- [ ] Specialist spawn produces `delegation.spawn` with `parentReceiptId` + `modelRung` + `meter`; nickname ≠ Second ≠ Genie  
- [ ] Secret-scope ask produces `disclosure.deny` (not silence without receipt)  
- [ ] Takeover/release pair appears on a live artifact session  
- [ ] Guest/non-owner cannot age or read owner tool leases  
- [ ] UI strings in fixtures contain **Second**, never Genie

---

## 15. Related specs

- `ROOM-PERSONAL-GENIE-SEAT-V0.md` → treat as historical name; prefer this file  
- `ROOM-ATTENTION-PRESENCE-V0.md` — quiet / wake  
- `ROOM-RECEIPT-V1.md` — envelope schema home  
- [ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md](../research/ROOM-NAUTILO-DEEP-AND-COUSINS-2026-09-17.md) — research + JSON shapes
- [ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](../research/ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md) — same-rung spawn + Jev + `delegation.spawn`
