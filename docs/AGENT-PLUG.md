# Plug agents in the way they actually run

10 September 2026. Isolated Worker only. Not Desk. Not DIE Track Room.
Overlay `/room` waits until `foot-latest.js` is idle. Durable Object not reset.
Does not auto-enroll, write `~/.grok/config.toml`, start a model, or mint a
remote MCP URL.

## Why this is useful

The product thesis is: humans talk in one room; AI agents and tools join as
**named members**. Add agent already issues a digest-only key. The dialog then
hands everyone the **same** four-step `pbpaste | import` recipe.

That is slow and shallow:

- Instinct and Muse can contribute **today with no key** (Use my AI → paste).
  Create access is optional identity, not the first step.
- Grok Build needs **MCP on this Mac** (TOML into `config.toml`). The snippet
  exists in `room-roster.mjs --snippet` but not in the dialog.
- Claude Desktop, Cursor, Claude Code, Gemini CLI use **`mcpServers` JSON**,
  already documented in [AGENT-HOSTS.md](AGENT-HOSTS.md), hidden from the UI.
- Grok Bot needs the **Node client on its computer**, not this Mac’s MCP.
- After a key exists, the list is name + expiry. There is no “what can it do”
  and no reconnect recipe without revealing the old secret.

Slack 2026 ships **several install paths** for the same Slack MCP (Claude
plugin, Cursor HTTP, local npx). Discord MCP docs do the same (Cursor,
Claude Desktop, Docker). We already have three real routes. Show them.

## Research this round

| Source | Lesson |
| --- | --- |
| Slack MCP 2026 (Claude Code plugin, Cursor HTTP, korotovsky npx) | One identity, **several host configs**. Do not pretend OAuth remote MCP exists here. |
| 29 MCP hosts (BankBridge 2026-07) | Claude Desktop, Cursor, Copilot, Windsurf, Codex, Gemini CLI, Raycast all consume stdio or HTTP. We have stdio. Print both TOML and `mcp.json`. |
| AGENT-HOSTS.md (already in-tree) | Shortest route by **capability**: packet / MCP / Node / HTTP. Remote MCP/OAuth **not implemented**. |
| Discord MCP INSTALL.md | Multiple install paths in one page; verify with a first tool. Ours: `room_check_access`. |
| OpenClaw / Hermes 2026 | Agents hear **explicit @ only**. Connecting is identity + tools, not “it lives in the thread so it hears everything.” |
| ROOM-ROSTER.md | Four named assistants, three routes (`packet`, `mcp`, `direct`). Dialog currently ignores that after Create access. |

## Product decision

Keep one owner-browser enrollment. Add a **How they connect** control and
fill the rest from it. Advanced holds the extra host snippets.

1. **How they connect** (visible select, not a buried paragraph):
   - **Chat packet — no Room key** (`packet`). Instinct / Muse default.
   - **MCP on this Mac** (`mcp`). Grok Build default. Also Claude/Cursor.
   - **Node client on its computer** (`direct`). Grok Bot default.
2. Roster buttons still fill name + access; they also set the recommended
   route. A custom name defaults to MCP (they clicked Create access).
3. Packet on the form: show Use my AI steps first. Create access stays
   **optional** (later identity if the host can import). Never put a key in
   iMessage / WhatsApp / Muse chat.
4. After Create access, the checklist is **route-specific** (import + check
   + first tool). MCP also shows copyable TOML and `mcp.json` placeholders
   (absolute paths, **no token**).
5. **What they can do** follows Access: chat / contribute / review. Always
   says addressing does not start a model.
6. Existing connections: one reconnect note (Replace key re-issues setup;
   same three routes). No schema change. No auto-write of host config.

Gated: remote MCP URL, OAuth, writing `config.toml`, auto-enroll, hosted
runner, Desk, DO reset, overlay door.

## Checklist — this change

- [x] Pure helpers: `capabilitySummary(access)`, `setupChecklist({ route,
      configDir })`, `placeholderSnippetPaths(configDir)` feeding existing
      `grokBuildToml` / `mcpJson`. No tokens in output.
- [x] Add-agent: `#agent-connect-route`, capabilities, packet-today panel,
      host snippets details. Roster sets route.
- [x] After Create access, checklist comes from `setupChecklist`.
- [x] Tests: helpers; roster HTML; browser Muse→packet, Grok Build→MCP
      snippets. HOW-TO-TEST: How they connect.

## How to test

1. People → Add agent. Instinct: route is Chat packet; Use my AI steps show;
   Create access is optional.
2. Grok Build: route MCP. Create access → import/check list plus TOML and
   JSON snippets. No key in the snippets. First tool `room_check_access`.
3. Custom name: MCP by default. Catch-up stays closed. No model starts.
   `~/.grok/config.toml` is not written.
