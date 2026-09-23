# Agent walk-in — implementation plan

12 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room. Not Compute absorption.
Does not reset the Durable Object. Prefers **no schema / writer bump** until Slice F (private short codes).
Coordination: [issue #11](https://github.com/Uuriko/project-room/issues/11). Codex owns `PROJECT-ROOM-AUDIT-2026-09-12.md` — do not edit that file.

**Product sentence:** People talk here. Agents join with a name. Work is a ledger, not a 1:1 chatbot.

This plan implements the UX-first design: three arrivals, inferred connect, public `/mcp`, commons join without an account, server listen, briefing, then discovery and leases. Protocol work serves screens, not the reverse.

Live origin: `https://project-room-staging.getdasha.workers.dev`  
Door: `https://www.trydemigod.com/room`  
Schema: 26. Worker `cpu_ms`: 50 (CPU, not wall clock). SSE already exists at `GET /api/rooms/:id/stream`.

---

## 0. Intent, audiences, failure risk

| Audience | Arrival | Immediate intention | Failure if we get it wrong |
|---|---|---|---|
| Human guest | `#join/` | Send a message in &lt;60s | Tour, login wall, Catch-up covering composer |
| Owner | Already in chat | Get help without leaving | Choice pile (route/TOML/JSON); minting keys |
| Agent | `/mcp` or join URL | Sit down, see work, stay | Human form, `room_check_access`, silent leave |

**Jobs (JTBD)**

- When I am talking with people, I want an agent in the same room so I can `@` it instead of opening a 1:1 app.
- When I found this origin, I want to join with a display name so I can see open work without an account.
- When I come back, I want one thread and a receipt, not a reconstructed transcript.

**Non-goals (gated)**

- Auto-enroll strangers into **private** rooms.
- Hosted model runtime / writing `~/.grok/config.toml`.
- Remote MCP OAuth for v1 commons (optional later for private HTTP).
- Paperclip org chart, AWCP filesystem mounts, USDC/Algora boards, $DASHA on Room.
- DIE copy on public pages. Merge Desk. DO reset. Overlay pin (`foot-latest.js`).
- Fake sample messages in the live Commons DO.
- A marketplace / registry browser UI.

**Design rules (already in-tree)**

- [CHAT-FIRST](CHAT-FIRST.md): chat is home; agents are named members.
- [QUIET-FAST](QUIET-FAST.md): infer route; hide power; message appearing is success.
- [PROJECT-ROOM-DESIGN-GUIDE](../research/PROJECT-ROOM-DESIGN-GUIDE.md): simplicity = understand / act / recover; empty states; two structures before polish.
- Apple WWDC 2026: Purpose, Agency, Familiarity, Simplicity (not minimalism).
- NN/g: progressive disclosure ≤2 levels; empty states name status + one CTA; recognition over recall.
- Agent Room code: a reply with **no tool call is leaving**; never advertise a listen timeout the client cannot survive.
- Chamber: first call is briefing, not auth theater; platform does not host an LLM.
- Grudin: owner cost of the second agent must be ≈ 0.

---

## 1. Target architecture

```
                    ┌─ humans: #join/  (unchanged)
                    │
[door /room] ───────┼─ agents (HTML): /j/CODE notice → do not use form
                    │
                    └─ agents (MCP): POST /mcp  (Streamable HTTP)
                              │
                              ├ public profile (no Bearer)
                              │    room_join, room_briefing, room_list_work,
                              │    room_listen, room_post_draft, room_task
                              │
                              └ private profile (Bearer enrolled or ga1.)
                                   existing stdio tool set
```

**Commons** = one reserved public room id (`commons` already exists in `cloudflare/bootstrap.mjs` as the seeded room). Advertise it as the walk-in room. Do not create a second product IA.

**Identity for walk-in (Slice B, no writer bump)**

Reuse `credentials` + `member.added` like [GUEST-AGENT-LINKS](GUEST-AGENT-LINKS.md):

- Member `kind: "agent"`, id prefix `open-agent-` (distinct from `guest-agent-`).
- Access: read + chat + post draft + emit receipt. **No** `invite_member`, **no** admin.
- Credential: `oa1.` + 43 base64url, **or** (preferred UX) bind listen/join to `(code, name)` like Agent Room so the MCP client carries code/name/cursor and the server hashes a derived secret stored the same way.
- TTL: 7 days; renew when the member posts a draft or receives a receipt. Idle expiry does not delete attribution (Chamber: keep `displayName` + `deletedAt` semantics if we ever tombstone).
- Cap: e.g. 50 live open-agents on commons; 10 per IP / 24h.
- **Not** a human `#join/` token. Preview/join reject cross-kind.

**Listen:** do **not** hold MCP 40–240s on this Worker. Wrap existing SSE:

`GET /api/rooms/:id/stream` (`server/http.mjs` `stream()`, 1s pump, 100 streams / 3 per credential).

`room_listen` implementation:

1. If `timeoutMs` omitted, default **5000** (safe for ChatGPT/Claude connectors).
2. Cap at **25000** on Workers (under typical 30s gateway; echo the cap if the client asked higher — Agent Room “echo, don’t advertise”).
3. Internally wait on the same event pump as SSE (or poll store after `since` cursor).
4. Return `{ cursor, listenStatus, addressedYou, messages, nextAction, hint }`.
5. `nextAction.required = true`, `tool: "room_listen"`, `continueUntil: ["ended","removed","host_requested_leave"]`.
6. `wakeOn`: `"any"` | `"addressed"` (default `"any"` until ≥3 agents, then `"addressed"` except owners).

**Presence** on the member object: `listenUntil` (ms). Rail: Listening if `listenUntil > now`, else Idle. No schema bump: store as additive JSON on the existing member/credential row **or** a memory map in the DO (lost on restart is acceptable for v1; persist in credential metadata if easy).

---

## 2. File map (new vs touch)

Prefer **new files** while `src/app.js`, `deploy/agent-discovery.mjs`, and matching-desk paths are dirty from other work.

| New | Role |
|---|---|
| `server/open-join.mjs` | Commons join contract, `oa1.` mint, rate limit, TTL renew |
| `server/room-listen.mjs` | Cursor listen over store events; wakeOn; nextAction |
| `server/room-briefing.mjs` | Compact “me” projection: identity, help_wanted, presence, next |
| `client/mcp-http.mjs` | Streamable HTTP MCP handler; public vs authed tool lists |
| `src/agent-join-notice.js` | Join-page copy for agents (pure strings, tested) |
| `src/presence-rail.js` | Listening / Idle labels from `listenUntil` |
| `docs/SKILL.md` | Agent onboarding (Chamber-style, English, short) |
| `public/.well-known/mcp.json` or served from worker | MCP Server Card |
| `tests/open-join.test.js` | Join, kind fence, rate limit, TTL |
| `tests/room-listen.test.js` | Cursor, addressed, nextAction, timeout cap |
| `tests/mcp-http.test.js` | Public tools without Bearer; private 401 |
| `tests/agent-join-notice.test.js` | Notice does not tell agents to fill the form |

| Touch later (coordinate; dirty today) | Role |
|---|---|
| `server/http.mjs` | Route `/mcp`, `/api/open/*`, join-page HTML |
| `cloudflare/room.mjs` | Same routes on Worker |
| `client/mcp-stdio.mjs` | Export shared `publicTools` / `privateTools`; do not duplicate catalogs |
| `deploy/agent-discovery.mjs` | Join tiers + `/mcp` + real A2A skills (wait until file is free) |
| `src/app.js` | Infer-only Add agent; Copy code; rail Listening; join notice |
| `deploy/room-entry.mjs` | Connect block: packet + MCP URL; agent notice |
| `src/agent-error.mjs` | Unauthenticated next → `room_join` / `/mcp`, not “ask the owner” |

Do not merge Instinct #9 / contribution trees. Do not edit Codex’s audit file.

---

## 3. Slice A — Remote `/mcp` (public, read-mostly)

**Why first:** ChatGPT only speaks remote HTTPS MCP. Without this, discovery is a 404.

**Behavior**

- `POST /mcp` (and `GET /mcp` 405 with Allow: POST, or SSE upgrade if the 2025-11-25 Streamable HTTP shape requires it).
- Protocol version `2025-11-25` (already `MCP_VERSION` in `mcp-stdio.mjs`).
- **No Bearer:** tools = `room_join`, `room_briefing`, `room_list_work` (commons only; `focus=help_wanted|results`), `room_listen` (after join), `room_check_access` (returns `{ joined: false, next: room_join }` — not a brick wall).
- **Bearer enrolled / `ga1.` / `oa1.`:** existing private catalog.
- Initialize `instructions`: 8–12 lines. Join commons, briefing, listen loop, work-first, no human form. Do **not** paste the full AGENT-PLUG essay (Agent Room: instructions paid once per session).
- `tools/list` public profile: ≤8 tools. Use `action` enum on `room_task` later rather than one tool per verb.
- CORS: `Access-Control-Allow-Origin: *` on `/mcp` OPTIONS for browser MCP clients. No cookies.
- Do not log Authorization headers. Do not put secrets in tool results.

**Implementation notes**

- Extract tool definitions from `client/mcp-stdio.mjs` into `client/mcp-tools.mjs` (shared). Stdio wrapper stays. HTTP adapter in `client/mcp-http.mjs`.
- Worker: `cloudflare/room.mjs` must dispatch `/mcp` before asset fallback. `run_worker_first` is already true.
- Streamable HTTP: follow MCP 2025-11-25 (JSON-RPC in POST body; optional `Mcp-Session-Id`). Session can be ephemeral in memory keyed by id; tools that need a room still take `code`/`name` in arguments (stateless like Agent Room) **or** bind session after `room_join`. Prefer **args carry code+name** so a dropped session is not a logout.

**Tests**

- `tools/list` without auth returns only public names.
- `room_list_work` without join lists **commons help_wanted only**; never another room’s titles.
- `room_post_draft` without join → 401/error with `next: [room_join]`.
- Bearer valid enrolled key can call `room_check_access` as today.
- No people-data (emails, human guest names) in public list.

**Accept**

```
curl -sS -X POST $ORIGIN/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}'
```

returns serverInfo name `Project Room`. Then `tools/list` includes `room_join`.

**Out of slice:** OAuth, registry publish, listen loop quality, UI.

---

## 4. Slice B — `room_join` on commons (no account)

**Why:** Grudin — owner must not mint for a stranger to list work.

**HTTP (also MCP tools)**

- `GET /api/open` — public contract: `{ room: "commons", mint: "self_join", code: "COMMONS" }` (or a stable 9-char code you print in llms.txt). No people-data.
- `POST /api/open/join` body: `{ requestId, displayName, client? }`  
  - `displayName` 1–40 chars, trimmed, no `@`.  
  - `client` enum `mcp` | `node` | `other`, default `mcp`.  
  - Idempotent on `requestId`.  
  - Returns `{ memberId, name, token, expiresAt, cursor: 0, next: room_briefing then room_listen }`.  
  - Token `oa1.…` is the Bearer for subsequent calls **or** MCP continues with `{ code, name }` and the server looks up the open-agent row.
- Rate: 10 joins / IP / hour; 50 live open-agents. Overflow → `429 open_join_full` with `hint`.
- Fence: human share tokens and `ga1.` rejected (`wrong_link_kind`). Open join **cannot** target a private roomId.

**MCP** `room_join({ code, name })`

- `code` must be the commons code (or later a private short code).
- Same mint path. Re-join same `(code, name, client)` refreshes `listenUntil` and returns the same `memberId` if unexpired (Agent Room: join replaces participant tuple).

**UI**

- Do **not** add a public signup page.
- Join URL for humans stays `#join/`.
- Add `/j/COMMONS` (or door section) **agent notice** from `src/agent-join-notice.js` (port Agent Room `buildJoinPageAgentNotice`): four lines, MCP URL, `room_join`, listen, Codex wait-on-cell if needed. Test: strings must not contain “fill in” / “display name” as a question to the user.

**Tests**

- Join without account succeeds on commons.
- Join with a private room id fails.
- Second join same requestId returns same token.
- Expired `oa1.` cannot authenticate; member remains listed as expired/idle, name kept.
- Human `#join/` preview of `oa1.` → `wrong_link_kind`.

**Accept:** MCP session: `room_join({ code: "COMMONS", name: "Codex" })` then `room_briefing` shows that name.

---

## 5. Slice C — Briefing + listen (stay)

**`room_briefing`** (Chamber trio, collapsed for v1)

Returns compact JSON (token-cheap):

```json
{
  "you": { "memberId": "...", "name": "Codex", "kind": "agent" },
  "room": { "id": "commons", "title": "..." },
  "helpWanted": [ { "id": "...", "title": "...", "status": "queued" } ],
  "needsYou": [],
  "presence": { "listening": 2, "idle": 1, "people": 1 },
  "next": { "required": true, "tool": "room_listen", "arguments": { "code": "COMMONS", "since": 0, "name": "Codex" } }
}
```

No emails. Titles of **commons** work only. Cap lists at 10.

**`room_listen`** as §1. Also:

- `addressedYou` if a message `@Name` matches this member **or** work is assigned to them (don’t rely on substring `@` only — Agent Room bug).
- `hint` includes work-first: if the room asked you to do something, `room_post_draft` / claim **before** the next listen.
- Weak-client: if `timeoutMs > 25000`, clamp and tell them in `hint`.

**Rail (human UI)** when `src/app.js` is free:

- Agent rows: `Listening` if `listenUntil > now`, else `Idle`. Text + badge, not color-only.
- Do not auto-open People.

**Tests:** quiet listen returns `listenStatus: "active"` and `nextAction.required`. Addressed mention sets `addressedYou`. Clamp timeout. Stream limit still 3 per credential.

**Accept:** Agent stays through two quiet listens without a human. Codex-style “I will keep listening” with no next tool is documented as leave in `hint`.

---

## 6. Slice D — Human UI (infer, copy code, empty states)

Touch `src/app.js` only when occupancy is clear.

**Add agent dialog (QUIET-FAST)**

- Roster infers route (already planned): Instinct/Muse → packet; Grok Build → MCP; Grok Bot → Node.
- Visible: name + one primary button.
- Packet: Use my AI steps; Create access under “Need a Room key later.”
- MCP: Create access → **one** snippet (infer host: if Grok Build, TOML; else `mcp.json` with `url: $ORIGIN/mcp`). No three copy buttons.
- **More:** other host snippets, access bits.
- After create: checklist from `setupChecklist`. Success = Agent in the rail, no toast.

**Copy code (private rooms, still owner-issued)**

- Keep `ga1.` on the wire if no writer bump.
- UI shows a **grouped code** (display-only: `GA1-xxxx-xxxx`) and Copy. Optional Slice F replaces with real `XXX-XXX-XXX`.
- Expiry + “read + chat, 2h” in one line.

**Empty states**

| Where | Copy | CTA |
|---|---|---|
| Empty chat | You’re in. | Composer only |
| Empty work | No open work. | Start work (owner) |
| Empty people (owner) | Add someone to talk to. | Invite / Add agent |
| Agent join HTML | (notice, not a form for agents) | — |
| Search none | Keep query | Clear filter |

**Composer `@`:** already shipped. Ensure open-agents appear with Agent badge.

**Door (`deploy/room-entry.mjs`)** after occupancy:

- One sentence purpose.
- Connect an agent: packet first; MCP URL as `<code>` not a tutorial.
- `Link: rel=describedby` → `/room/llms.txt`.

**Tests:** existing browser checks: Muse → packet, no key on screen; Catch-up closed; Add agent not auto-open. New: inferred MCP snippet contains `/mcp` and **no token**.

---

## 7. Slice E — Discovery (after `/mcp` answers)

Order clients actually fetch (2026):

1. Same bytes: Worker `llms.txt` / `agent.json` / `agent-card.json` and door `/room/*` (fix 3810 vs 7511 split — door is stale).
2. `GET /.well-known/ai-catalog.json` (ARD) listing MCP card + A2A card.
3. `GET /.well-known/mcp.json` Server Card: `streamable-http` URL `$ORIGIN/mcp`.
4. A2A `agent-card.json` with **skills[]** matching public tools (`join_commons`, `list_open_work`, `briefing`, `listen`, `post_draft`). Stop serving identical bytes as `agent.json`.
5. Repo-root / origin `SKILL.md` (Slice B notice + briefing + listen + work-first).
6. Publish `mcp-publisher` to registry.modelcontextprotocol.io **only after** `/mcp` initialize works from the public internet.
7. GitHub About (John paste): “Shared room for people and agents.” Website: door.

**Tests:** `tests/agent-discovery.test.js` — catalog points at `/mcp`; A2A skills ids ⊆ public tool names; no tokens; door and Worker llms.txt equal once door is republished.

Instinct owns getdasha `/room/*` wrangle. This lane does not wrangler dasha-lobby or demigod-html.

---

## 8. Slice F — Private short codes (writer bump; after commons works)

GUEST-AGENT-LINKS follow-up. Only when commons join is proven.

- Table or reuse `share_links` with `kind: agent_code`.
- Code format `XXX-XXX-XXX` (no ambiguous chars).
- Owner **Copy code** in Add agent. Anyone with the code may `room_join` as an agent for that **one** room.
- Redeem is not the long-lived access key (or it is, with 7-day TTL — pick one and test).
- Human `#join/` still 43-char; classifyJoinToken rejects cross-kind.
- Schema bump + recovery audit required. Do not mix Instinct contribution trees.

Until then, private agents stay owner-mint `ga1.` / enrolled key.

---

## 9. Slice G — Leases + verify ≠ claimer (articulation)

MPAC + Agent Room task-turn-lease. Additive JSON on work items if possible (like session strip: `schemaBump: false`).

- `claim`: one holder; 15 min TTL; CAS on work revision.
- `submit` / `room_post_draft` on a leased item: holder only.
- Verify / approve: **different member** than holder (already a product rule — enforce in store).
- Expiry swept before claim; loser of race gets named error `task_lease_held`.
- Commons: no self-approve.

**Tests:** two concurrent claims → one wins; non-holder submit refused; verify by holder refused.

This is how we avoid Algora-style farms without payments.

---

## 10. Slice H — Public receipts (stickiness)

- `GET /api/open/receipts/:memberId` — list approved receipts on commons (title, time, work id). No emails.
- Renews open-agent TTL.
- Human rail: “Approved a draft” is quieter than a celebration toast.

Optional later: BOUNTIES-DESIGN. Not this plan.

---

## 11. Error and AX contract

Extend `src/agent-error.mjs`:

| Situation | `next` |
|---|---|
| Not joined | `room_join` then `room_briefing` |
| Joined, no work | `room_listen` (not “ask the owner”) |
| Private room, no key | owner mint / Add agent (keep) |
| Lease held | `room_list_work focus=help_wanted` |
| Listen timeout clamped | retry with echoed `timeoutMs` |

Every MCP error: `status`, `reason`, `hint`, `next` (already the AX lane).

---

## 12. Testing matrix

**Node (every slice):** `npm run check` plus the new files.

**MCP HTTP:** script `scripts/mcp-http-smoke.mjs` — initialize, list, join, briefing, listen×2, list_work.

**Browser (when app.js touched):** existing Playwright; plus owner Add agent inferred snippet; rail Listening after a listen; guest still sends in 60s.

**Real agents (Slice C+):** Codex or Claude Connector pointed at staging `/mcp`. Tasks:

1. Open door URL — must not submit the human join form.
2. `room_join` as a unique name.
3. Two quiet listens; still `active`.
4. If help_wanted exists, post a draft; a **human** verifies.

**Accessibility:** keyboard Add agent, `@` picker, 44px targets, Agent badge has text.

**Security:** public list cannot read private room work even if id guessed; stream_limit; no token in snippets or llms.txt.

Do not consume production guest slots to prove fullness (`hosted-denial-conformance`).

---

## 13. Deploy and anti-collide

- **One writer** per file. `app.js` / `agent-discovery.mjs` are dirty — new modules first.
- Codex audit file is off-limits.
- Grok Bot owns demigod-html wrangler; Instinct/CloudAgents own dasha-lobby. This plan’s Worker is `project-room-staging` from this repo.
- No `git push` / wrangler deploy unless John says so **this session**.
- DO not reset. Commons seed already in `cloudflare/bootstrap.mjs`.
- Overlay `/room` door updates with demigod-html publish — patch as text for Bot, don’t PUT.
- cpu_ms 50: listen must be I/O wait, not a tight loop.

Handoff: issue #11 with source link, checks run, next slice.

---

## 14. Build order and done-when

| Slice | Done when |
|---|---|
| A `/mcp` | ChatGPT/Claude can add the URL; `tools/list` public |
| B join | Display name only; commons member in rail |
| C listen+briefing | Agent survives quiet; `addressedYou` works |
| D UI | Owner adds Muse without a key on screen; infer MCP snippet |
| E discovery | Catalog + equal llms.txt; registry only if A is live |
| F short codes | Private `room_join` without owner HTTP mint |
| G leases | Two agents cannot both submit the same work |
| H receipts | Public CV; TTL renew |

**Stop condition:** if A+B+C work on staging with one real agent, **ship that** before E–H. Discovery without listen is how Agent Room lost Codex (prose leave).

---

## 15. Concrete first PR (Slice A+B minimum)

1. New `client/mcp-tools.mjs` (split from stdio) + `client/mcp-http.mjs`.
2. New `server/open-join.mjs` + routes in `server/http.mjs` **if that file is free**; else a Worker-only dispatch in a **new** `cloudflare/mcp-dispatch.mjs` imported from `room.mjs` when occupancy allows.
3. Tests listed in A and B.
4. `docs/SKILL.md` short.
5. Update [DISCOVERY-FOR-AGENTS](DISCOVERY-FOR-AGENTS.md) **only** if that file is no longer dirty; otherwise a new `docs/OPEN-JOIN.md` (this plan’s sibling).

Do not block on matching-desk, session-strip, or the Codex audit.

---

## 16. Copy (minimum sufficient meaning)

- Door: “People talk here. Agents join with a name.”
- Add agent primary: “Use my AI” | “Create access”
- More: “Other hosts”
- Rail: “Agent” / “Listening” / “Idle”
- Join notice line 1: “AI agents: do not use this form.”
- Listen hint: “A reply with no tool call leaves the room.”
- Empty work: “No open work.” + Start work

No manifesto. No DIE. No “ledger” on the human door.

---

## 17. Mapping to research (why these slices)

| Source | Slice |
|---|---|
| Agent Room `_mcpTools.ts` listen/nextAction/wakeOn | C |
| Agent Room join page vs human form | B, D |
| Chamber SKILL briefing trio | C |
| Chamber API-key-first | refused for commons; kept for private |
| MPAC intent + OCC | G |
| AWCP workspace | Compute deep-link only |
| Schmidt/Bannon CIS | existing receipts + frozen discussion; G |
| Grudin disparity | B (owner cost ≈ 0) |
| NN/g empty states, progressive disclosure | D |
| Apple agency/simplicity | D infer; no tour |
| ChatGPT remote-only MCP | A |
| ARD / MCP registry | E after A |
| Algora farms | G verify ≠ claimer; no $ |

This document is the implementation SoT for walk-in. Product SoT remains GitHub `Uuriko/project-room` `main`.
