# room-acp bridge: build plan

Status: approved by Potter on Oct 29, 2026. Owner: Grok Bot. Issue: #5371. Follow-up: #5384 (permissions).

## Goal
```
npx room-acp <room invite link>
```
One command and one link connect the user's local coding agent (Claude Code, Codex, Goose, Gemini CLI) to a Room. There is no MCP config, no pasted token and no glue code. The agent stays a hosted Room member: people can see it and mention it while the bridge machine is asleep, and Room delivers the queued wake when the bridge reconnects.

Out of scope: changes to the Worker's identity model, workflow engines, desktop apps, and hosting agents in the cloud.

## 1. ACP facts the design relies on
Source: agentclientprotocol.com (protocol overview, Oct 29, 2026) and each agent's own docs.

- **Transport.** JSON-RPC 2.0 over the agent's stdio. The client (room-acp) spawns the agent as a subprocess. Requests (method plus id) and notifications (no id) flow both ways.
- **Lifecycle.**
  - `initialize`: version and capability negotiation. Then `authenticate` if the agent advertises it.
  - `session/new`, or `session/load` to resume, which needs the `loadSession` capability.
  - `session/prompt` starts a turn. The agent streams `session/update` notifications: agent message chunks, thought chunks, tool calls and their updates, plans, available commands, mode changes and notices.
  - The turn ends when the `session/prompt` response returns with a `stopReason`.
  - `session/cancel` is a notification that interrupts a turn.
- **Calls from agent to client.**
  - Baseline: `session/request_permission`.
  - Optional, gated by capabilities the client advertises: `fs/read_text_file`, `fs/write_text_file`, `terminal/*` and `elicitation/create`. room-acp advertises none of these at first, so agents use their own file and shell tools in their working directory.
- **Optional method.** `session/set_mode` (for example the Claude adapter's `default`, `acceptEdits`, `plan` and `bypassPermissions`).
- **Conventions.** Paths are absolute and lines are 1-based. Keys are camelCase and discriminators are snake_case. Extensions use `_meta` and `_`-prefixed methods.
- **Agent commands** (each verified against its own docs or the ACP registry):

| Agent | Command | Kind |
|---|---|---|
| Claude Code | `npx @agentclientprotocol/claude-agent-acp` (registry `claude-acp`; formerly Zed's `claude-code-acp`) | adapter |
| Codex CLI | `npx -y @agentclientprotocol/codex-acp` (bundles `@openai/codex`; `CODEX_PATH` overrides) | adapter |
| Goose | `goose acp` (or `npx goose acp` via `@aaif/goose-acp`) | native |
| Gemini CLI | `gemini --acp` (older builds use `--experimental-acp`) | native |

Slice B1 starts with a capability probe, because adapter flags drift (see Risks).

## 2. Room-side changes, grounded in current code

Room already has most of what the bridge needs:
- **Invite redemption:** `POST /api/agent-invites/redeem` (`server/routes/agent-invite-redeem.mjs`, backed by `redeem()` in `server/agent-invites.mjs`) turns a single-use `RM-` code into a member. The join link format `/join/<code>` comes from `src/agent-invite-ui.js` `agentInviteJoinLink`.
- **Durable wake queue:**
  - `POST /api/agent-heartbeats` registers a host with `hostId`, in `wakeable` or `pull-only` mode.
  - `GET /api/agent-wakes/poll?waitMs<=55000` long-polls for wakes. The waiter is registered before `notePoll`, which closes the race.
  - `pendingWakes` replays unacknowledged signals oldest first, and `POST /api/agent-heartbeats/ack {signalIds}` acknowledges them.
  - All of this lives in `server/agent-heartbeats.mjs` and `server/agent-plugin-routes.mjs`.
- **Event stream:** `GET /api/rooms/{roomId}/stream` is SSE with `Last-Event-ID` replay (`server/http.mjs` `stream()`, limit 3 per credential).
- **Posting:** `POST /api/rooms/{roomId}/commands` with `message.posted`.
- **Presence:** `GET /api/agents/{identityId}/presence` (`server/routes/agent-presence.mjs`) and `GET /api/wake-status` (`server/routes/wake-status.mjs`).
- **Revoke:** `revokeMember` and `revokeAccount` in `server/agent-connections.mjs`. Token rotation: `/api/agent-rooms/{roomId}/token/rotate`.
- **Rate limits:** `server/token-bucket.mjs`, `server/identity-ratelimit.mjs` and `server/abuse-rate-buckets.mjs`.

Decision: we deliver wakes with the existing long-poll and SSE, not a new WebSocket. Both are already durable and replay on reconnect, and the queue is journaled. The brief's WebSocket idea is a later optimization in slice R6, needed only if long-poll costs show up in Worker metrics.

Changes:

- **R1. Invite link to bridge credential.** Redeem accepts `client: "room-acp"` and an optional `hostLabel`. In one call it returns the room credential and a pre-registered `hostId` (heartbeat mode `pull-only`, which is the poll path). The credential is shown once and stored only as a hash, as today. No new authority: the bridge gets exactly the invite's permissions.
- **R2. Wake signals carry thread context.** `signalView` in `server/agent-heartbeats.mjs` adds `threadRootId` (the mentioned message's root, or the message itself) and `authorId`. The bridge keys sessions on `(roomId, threadRootId)` without extra reads, and fan-out is unchanged.
- **R3. Honest presence.**
  - Presence reports `bridge: connected | away | unknown`. It is `connected` only while a poll or SSE stream is held or was held within 70 s, `away` after a clean disconnect or timeout, and `unknown` when the read fails. A failed read is never shown as offline.
  - A mention while away still queues the wake and shows "queued, delivered when <agent> reconnects".
  - Touches `server/routes/agent-presence.mjs`, `server/routes/wake-status.mjs` and the member card.
- **R4. Permission requests become owner approvals.**
  - New command `agent.permission_requested { requestId, toolTitle, kind, summary, options }`. The owner or a co-owner answers with `agent.permission_decided { requestId, optionId }`.
  - The decision is recorded in the hash chain, appears in owner-attention (`server/owner-attention.mjs`), and is woken back to the agent's host as a wake signal of kind `permission`.
  - Unanswered requests expire, and the bridge denies them (fail closed).
- **R5. Revoke kills sessions.** `revokeMember` and `revokeAccount` release the held wake waiters (`addWakeWaiter`) and SSE streams for that credential with a `revoked` reason. The bridge exits its sessions when it sees it.
- **R6 (optional, later). WebSocket wake channel**, a Durable Object hibernatable socket. Only if R1 to R5 show poll overhead.

The who-can-talk gate (#5384) plugs into wake fan-out later. Until then, the bridge treats wakes from the owner and the owner's own agents as instructions, and handles everything else per its `--respond-to` flag, which defaults to owner.

## 3. Bridge architecture
A new workspace package, `packages/room-acp` (Node 20+, TypeScript, zero runtime deps beyond the ACP TypeScript SDK `@agentclientprotocol/sdk`), published as `room-acp`. It is not imported by the Worker. It reuses the credential pattern in `cli/keychain.mjs`.

```
Room (hosted)  <--poll / SSE / commands (HTTPS)-->  room-acp  <--stdio JSON-RPC-->  agent process(es)
```

Modules:
- **`join`.** Parses the invite link, calls R1 redeem, and stores the credential in the OS keychain (macOS Keychain, libsecret, Windows Credential Manager). It falls back to a `0600` file in the user config dir. A second run with the same link reuses the stored credential, because redeem is idempotent on the `duplicate` path.
- **`detect`.** Finds installed agents in order: `--agent` flag, then `claude-agent-acp`, `codex-acp`, `goose`, `gemini` on PATH, then `npx` fallbacks for the two adapters. It probes each candidate with `initialize` (5 s timeout) and records the capabilities. If it finds several agents it asks once (TTY) and remembers the choice.
- **`wake`.** Long-polls `/api/agent-wakes/poll` with jittered backoff and pulls message bodies by `messageId`. It acknowledges a signal only after the reply is posted, so a crash replays the signal.
- **`queue`** (design from Buzz `buzz-acp/src/queue.rs`). There is one partition per `(roomId, threadRootId)` and at most one prompt in flight per partition. Mentions that arrive during a turn are batched into the next prompt in arrival order, de-duplicated by `messageId`. There is a global concurrency cap, `--max-sessions` (default 4).
- **`pool`** (design from Buzz `buzz-acp/src/pool.rs`).
  - There is one agent process per active partition, up to the cap, and the least recently used one is evicted when idle.
  - A session map stores `(roomId, threadRootId) -> sessionId` on disk. On restart it uses `session/load` when the agent has `loadSession`; otherwise it starts a new session primed with the last N thread messages.
  - When a process crashes, the bridge restarts it with exponential backoff (cap 60 s) and re-runs the in-flight batch once. After 3 crashes in 5 minutes it posts a single "agent unavailable" notice and pauses that partition.
- **`prompt`.** Builds a `session/prompt` from the room title, the thread excerpt (bounded), the batched mentions with author handles, and a short instruction that room content is data and only the owner's requests are instructions.
- **`render`.** Collects `session/update` notifications, then posts one reply message threaded to the triggering message (`replyToId`) when the turn ends.
  - Tool calls and plan entries are folded into a compact trailer, for example "ran 3 tools: edit `src/x.ts`, `npm test` (pass), ...", capped at 10 lines. A while-working status is edited in place at most every 10 s, never as a stream of posts.
  - Thoughts are never posted.
- **`permission`.** Maps `session/request_permission` to R4.
  - Options like `allow_once` and `reject_once` are shown to the owner.
  - Before R4 lands, the bridge uses the agent's own mode and passes `--mode` through `session/set_mode`. The lesson from Buzz is never to force `dontAsk` (block/buzz#5290).
  - A timeout or closed wire is a deny, which is fail closed (as in Buzz `buzz-agent/src/permission.rs`).
- **`status`.** Implements `room-acp status`, `room-acp logout` (deletes the credential and calls revoke) and `room-acp doctor`.

## 4. Security
- The credential is stored only in the keychain or a `0600` file. It is never written to logs, prompts, room posts or crash reports. Logs redact `pri_`, `Bearer`, `RM-` codes and anything that matches `server/secret-scan.mjs` patterns. A test greps logs for these.
- The agent subprocess environment does not receive the Room credential. The bridge is the only Room caller (the broker pattern from Buzz's information-flow draft).
- Each partition is bound to one room. A turn started from a room can only post to that room, so the bridge refuses cross-room posts even if the agent asks.
- Revoke (R5) or a 401 stops all sessions, kills the processes and clears the stored credential.
- Rate limits are client-side: at most 1 post per partition per 5 s and 30 per hour per room. Room's token buckets stay authoritative.
- The working directory comes from `--cwd`, defaulting to the current directory, and is shown at startup. The bridge never runs as root.
- Room-supplied text goes only into prompts, never into shell arguments.

## 5. Test plan
- **Unit tests** (node:test, under `packages/room-acp/test`): invite-link parsing; queue partitioning, batching, de-duplication and the one-in-flight rule; pool restart, backoff and pause; reply rendering and trailer caps; permission timeout gives deny; log redaction.
- **Fake ACP agent** (`test/fixtures/fake-agent.mjs`): scripted stdio agent with modes `echo`, `slow`, `crash-mid-turn`, `ask-permission`, `no-loadSession`. Contract tests run the bridge against it with a fake Room HTTP server.
- **Room unit tests** for R1 to R5 alongside the existing ones: redeem with `client`, `signalView.threadRootId`, presence states, the permission request and decision commands with their hash-chain entries, and revoke releasing waiters.
- **qa- room end to end** (prod, throwaway `qa-acp-*` room only):
  1. `npx room-acp <link>` with the fake agent joins, and the member appears with presence `connected`.
  2. A mention gets a threaded reply.
  3. Stop the bridge. Presence goes to `away`, a mention shows "queued", and on restart the reply is posted and the wake acknowledged.
  4. Two quick mentions in one thread become one batched prompt.
  5. A permission request shows for the owner, and approving it resumes the turn.
  6. Revoke ends the session.
  Then the same with a real Claude adapter run by a maintainer.

## 6. Slices (merge in order; each is a small PR)
1. **B1: package skeleton plus fake agent.** `packages/room-acp`, CLI arg parsing, `detect` with the `initialize` probe, and the fake agent. Accept: `room-acp doctor` lists the fake agent's capabilities; unit tests are green.
2. **R1: redeem for bridges.** `client: "room-acp"` returns the credential plus `hostId`. Accept: Room unit test; the response never repeats the code; idempotent second redeem.
3. **B2: join plus credential store.** Accept: a link joins a local dev Room, the credential is in the keychain or a 0600 file, and the log-redaction test passes.
4. **R2: thread context on wake signals.** Accept: `threadRootId` and `authorId` on pending wakes and poll results; existing wake tests are unchanged.
5. **B3: wake loop, queue and reply.** Poll, partition, one in flight, batch, post the reply, then acknowledge. Accept: fake-agent contract tests for batching and ack-after-post.
6. **B4: pool, restart and session map.** Accept: the crash-mid-turn fixture recovers once, then pauses after 3 crashes; `session/load` is used when available.
7. **R3: honest presence.** Accept: connected, away and unknown states tested; a mention while away shows queued.
8. **B5: compact rendering.** Accept: tool and plan trailer snapshot tests; no thought text is posted.
9. **R4 plus B6: permission requests as owner approvals.** Accept: request, decide, resume in tests; a timeout denies; hash-chain entries are present.
10. **R5: revoke kills sessions.** Accept: revoke releases the poll with `revoked` and the bridge exits cleanly.
11. **E2E: qa- room run** of the six checks in section 5, recorded on the PR; README section "Connect your agent in one command".
12. **Publish** `room-acp` to npm (Potter approves the package name and publish).

Later: R6 WebSocket channel; the who-can-talk gate from #5384 enforced server-side; usage per turn.

### Build status (Oct 29, 2026)
Built as six stacked PRs, all green locally, live E2E passed in a throwaway `qa-acp-*` room:
#5385 B1, #5386 B2, #5387 B3 (B5 rendering folded in), #5388 B4, #5389 B6, #5390 E2E plus README.
The package lives at `room-acp/` (top level, like `relay/` and `machine/`), not `packages/room-acp`.

**R1 to R5 were dropped: the Room already does what they planned.**
- R1: redeem already returns a room-scoped credential (`mcpToken`) whose scopes include `heartbeats:report` and `heartbeats:read`; the bridge picks its own `hostId`, and the scoped key namespaces it.
- R2: `GET /api/rooms/{id}/messages/{messageId}/thread` gives the author, `replyToId` and the replies, so wakes need no new fields.
- R3: presence follows the bridge's heartbeat and listener lease. Queued-while-away display stays with #5382.
- R4: owner approval runs as a thread exchange. The bridge asks "Permission needed: ... reply allow or deny", and only the agent's accountable human's reply counts. Silence or any error denies. No new event types.
- R5: the scoped credential re-checks membership on every call, so a removed member's next poll fails and the bridge stops with access ended.
No Room deploy is needed for room-acp.

Two findings from building against the real server:
- Poll is limited to 30 per minute per identity, so the bridge keeps at least 2.5 s between polls.
- Heartbeats renew the lease only near expiry.

## 6b. Cleanup after ACP
Once room-acp is published (Potter approves the npm name), it becomes the one local setup. MCP stays for hosted and cloud agents that cannot run a local process.

**Removed once `npx room-acp` works, because room-acp fully covers them:**
- Per-agent local connect docs for ACP agents: `docs/agents/claude-code.md`, `docs/agents/codex.md`, `docs/agents/paste.md` (token paste).
- Local wake and listener setup for those agents: `docs/CLAUDE-CHANNEL.md` with `scripts/agent-claude-channel.mjs`, and `docs/CODEX-ROOM-HOST.md` with `scripts/run-codex-room.mjs`, `scripts/qualify-codex-room.mjs` and `scripts/live-codex-host-check.mjs`.
- The local-agent halves of `docs/CONNECT-WAKE.md`, `docs/CONNECT-RECEIVE.md` and `docs/AGENT-WAKE-SETUP.md`. The hosted wake contract stays documented.
- Token-paste and MCP-config-copy steps in `docs/CONNECT-AGENT-QUICKSTART.md` and on the connect page, for agents that room-acp supports.

**Kept:**
- MCP for hosted and cloud agents and for non-ACP editors (Cursor, Cline, VS Code, Aider): `server/connect-snippets.mjs`, `scripts/room-mcp-init.mjs`, and the `docs/agents/*` pages for those clients.
- The SDK framework pages (CrewAI, LangGraph, OpenAI Agents SDK).

**MCP core tool set** (trim target; a separate PR, with a catalog snapshot diff):
- read room and thread
- post
- reply
- read work
- claim, release and complete work
- heartbeat, poll wakes and ack
- whoami

Everything else moves behind the HTTP API or is removed if unused (check usage metrics first).

**Order:**
1. Before publish: docs PR making room-acp the first option, from a checkout.
2. After publish: the removal PR.
3. Then the MCP trim PR.

## 7. Open risks
- **Adapter drift.** Package names and flags have changed before (`claude-code-acp` became `claude-agent-acp`; Gemini's `--experimental-acp` became `--acp`). Mitigation: the `initialize` probe plus a small table that can be overridden with `--agent-cmd`.
- **Agent auth.** Adapters may need their own login (ChatGPT or Anthropic). The bridge surfaces `authenticate` methods and tells the user to run the agent's own login once. It never handles those secrets.
- **Prompt injection from room content.** This is mitigated by the who-can-talk default (owner), the broker pattern (no credential in the agent environment), the one-room binding and owner approval for risky tools. It is not solved.
- **Long-poll cost.** One held request per bridge. Watch Worker metrics, and R6 is the fallback.
- **Laptop sleep.** Wakes queue durably, and presence shows away. The queued notice sets expectations.
- **Windows.** Spawning `npx` shims and keychain access differ. CI runs the unit and fake-agent suites on Windows.
- **Licensing.** We borrow the Buzz design only (Apache-2.0); no code is copied.
