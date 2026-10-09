# Transports: mcp-stdio.mjs, text-plug.mjs, claude-channel.mjs, grok-host.mjs

## mcp-stdio.mjs — hosted MCP over stdio

**Purpose.** `serveRoomMcp({client, roomId, memberId, input, output, timeoutMs, attention, channel})` exposes the room tool surface (`roomTools` + `attentionTools`) as MCP over stdio for hosts like Claude Code/Desktop. `MCP_VERSION = "2025-11-25"` (previous `2025-06-18` also accepted).

**Data flow.** JSON-RPC requests on stdin → `validRoomToolArguments(name, args)` (per-tool validators: bounds, id shapes, enum sets, e.g. `room_acknowledge_wake` needs 1–50 unique signal ids) → `buildDraftCommand` → client call → JSON-RPC response on stdout.

**Invariants.** Argument validators are pure boolean functions — they never throw on hostile input (fuzz A5: XSS, 51 ids, `__proto__`, 10 MB strings, 8k-deep nesting, unknown tool → all clean booleans, no pollution, no hang). Version negotiation only accepts the two supported versions.

**Gotchas.** The single-signal boundary (`length >= 1`) is load-bearing for wake acks; the `> 1` mutant (rejecting a lone signal) survives the suite (test gap M15) — a one-line regression test on `room_acknowledge_wake` with exactly one id would pin it.

## text-plug.mjs — SMS/iMessage/WhatsApp command parser

**Purpose.** One short text line → `match` | `claim` | `pull` | `done` | `progress` | `blocked` | `handoff` | `holders` | `collisions` | `reply` | `tags`. `parseRoomText(text)` parses; `leaseHoursFromUntil(iso, now)` computes 1–720h lease windows.

**Invariants.** Verbs and motives are closed sets (`VERBS`, `MOTIVES`); ids are length-bounded with no whitespace; failures throw coded errors (`invalid_text_plug`), never partial parses.

**Gotchas.** Does not send SMS, mint identities, or hold leases — it only produces the *next* action for the matcher/claim route. Fuzz C5: 10 MB input, null, unicode-heavy text all handled (reject or parse, no hang).

## claude-channel.mjs — Claude host channel

**Purpose.** Long-running host loop for Claude-based operators: heartbeat registration via `AgentWakeClient`, wake polling, `roomEventPointer` extraction (pointer only — message bodies stay in the room until a tool read), and MCP serving for the agent session.

**Invariants.** `roomEventPointer` returns null unless the signal belongs to the room; only `signalId`/`roomId`/`messageId`/`workItemId`/`requestId` are carried — no bodies, no secrets.

## grok-host.mjs — Grok host adapter

**Purpose.** Room attention → journaled run plans. `attentionKey(item)` builds stable keys (handoffs reuse work-item id; message wakes stay message-based since they can lack seq); `parseNeedsMeBody` validates the needs-me payload (used by `agent-resume.mjs`).

**Invariants.** Kind ≤64 chars, ids ≤128; `GrokHostError` carries codes; "Reads are not execution. Secrets never belong in prompts, journals, or stdout."
