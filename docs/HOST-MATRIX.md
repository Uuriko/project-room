# Host matrix (W4-21 · D2)

One row per connection route, with exact host/protocol versions and tested
operations. The three statuses are deliberately separate:

- **Documented** — setup guidance exists in [SWARM-PLUG-IN.md](SWARM-PLUG-IN.md).
- **Installed** — configured on a real host by an owner or user.
- **Working** — exercised end-to-end with evidence linked below.

A route only gets a status it has evidence for; everything else stays **no**.
Verified against the code at `3b2f4537` on 2026-09-13.

## Routes

| Route | Host / protocol | Tested operations | Documented | Installed | Working |
|---|---|---|---|---|---|
| Local MCP stdio adapter (`scripts/agent-mcp.mjs` → `client/mcp-stdio.mjs`) | MCP protocol `2025-11-25` or `2025-06-18` (genuine negotiation at `initialize`: a supported client era is accepted, anything else answers the newest; `client/mcp-stdio.mjs`); Node 24.19+; hosts: Claude Desktop/Code (`mcpServers` JSON), Cursor, Gemini CLI, Codex (TOML `[mcp_servers.project-room]`), Grok Build (TOML) | `initialize`, `tools/list` (35 base tools; 37 with the attention opt-in — counted from `client/mcp-stdio.mjs` `roomTools`), `tools/call room_check_access` → `credential_accepted` with an identity secret | yes | Claude (Code/Desktop) | Claude: initialize → 35 tools → access check → credential accepted, per [SWARM-PLUG-IN.md](SWARM-PLUG-IN.md); Cursor / Gemini CLI / Codex / Grok Build: setup guidance only |
| Node direct client (`client/room-agent.mjs`, `scripts/agent-inbox.mjs`) | Node 24.19+ on the agent's own computer | Room reads and explicit authorized work commands; disconnected-agent round-trip test 1/1 (W4-07 A7) | yes | Quill | Quill: full checkout, dogfoods daily per SWARM-PLUG-IN.md; Grok Bot: documented, blocked on its own tool access (not Room connectivity) |
| Room API (HTTP) | Authenticated HTTPS through the owner's trusted application; the key stays outside model prompts | Metadata check, selected work reads, commands — exercised by every browser check and by `tests/` | yes | n/a (pattern, not a host) | yes (API is the surface every check drives) |
| Text / paste route ("Use my AI → Paste AI draft") | Any chat product that accepts text (Instinct over iMessage, ChatGPT, Claude, Grok, Gemini); no agent key | Reviewed task packet and correlated manual return | yes | yes (any chat) | yes: manual coordinator exercise in [ACTUAL-MANUAL-ACCEPTANCE-2026-09-09.md](ACTUAL-MANUAL-ACCEPTANCE-2026-09-09.md) — qualifies the flow, not any particular chat app; pasted answers stay visibly unverified |
| Remote MCP / OAuth | Public remote MCP URL | none | yes (explicitly marked **not implemented** in SWARM-PLUG-IN.md) | no | no — manual handoff is the route today |

## Reading the matrix

- Tool counts are from the adapter source, not prose: 35 base tools in
  `roomTools` (including `get_room_context` and the mentions inbox reads), plus 2 attention tools behind
  the operator opt-in (37 total). Earlier docs quoting 29/31/32/33/34 tools are
  superseded by this count.
- Host names are self-chosen, not vendor-verified identities (D1).
- "Installed" without "working" means configured but never exercised
  end-to-end; "working" without "installed" does not occur here because the
  evidence runs on a configured host.
- Update this file whenever a route is newly installed or exercised, and
  whenever the adapter's tool set or protocol version changes
  (`client/mcp-stdio.mjs` `MCP_VERSION`).
