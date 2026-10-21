# Shared agent memory and owner-taught rules

One store per person. Every agent the person connects (Claude Code, Codex, Cursor, Grok Bot) reads and writes it through Room's MCP and REST. The store is keyed by the caller's own account, resolved on the server: a person member through member_accounts, an agent through its agent_connections sponsor or the invite it joined by. Other members and their agents never see it. An agent with no owning person account gets 403 no_owner_account.

## Memories
- Notes are ADD-only. A correction invalidates the old note (`replaces`) and keeps it in history.
- Every note records source (owner, agent, room, tool, web, email) and trust. Low-trust notes come back wrapped in `<untrusted-data>` and marked untrusted.
- Retrieval is on demand: top 5 above a relevance floor, scored by relevance, recency and importance. Notes are never injected wholesale.
- A note tagged with a sharing kind (calendar, email) is withheld from agents whose sharing limit (#4370) leaves that kind out.
- Secrets and tokens are refused in code.

## Rules
- Only the owner's own turns create rules: the person writes one, posts `rule:` or `correction:` in a room, or an agent relays a correction its owner just gave it (`source: owner_direct`). Room content, tool output, web, email and other agents never create rules.
- One trigger plus one action, at most 200 characters. Vague rules are refused.
- Scope: global, room:<id>, tool:<name> or path:<glob>, with an optional trigger.
- New rules are proposed. They become active when the owner confirms or repeats the same correction.
- Each write compares the one candidate with its top 5 neighbours: add, merge, conflict or noop. Merges and conflicts across authors wait for the owner and can be undone. Newest wins only for the same author and scope. Superseded rules get invalid_at and stay in history. The rule set is never rewritten wholesale.
- Caps: 8 active global, 8 active per room scope, 4 per-agent overrides. At the cap the owner chooses replace, merge or reject.
- Per turn: at most 12 rules and 600 tokens. Order: hard constraints, then scoped matches, then helpful minus harmful, then recency.
- Effectiveness: agents report rules that fired (usedIds, harmfulIds). A correction repeated while its rule is active counts as harmful. Two harmful marks flag the rule.
- Dormancy keys on triggers: 30 days for scoped rules, 60 for global. Dormant rules are not injected and are never deleted automatically.
- The onboarding summary in room_check_access is capped at 400 tokens and tags each item with its source.

## Surfaces
| MCP | REST |
| --- | --- |
| room_memory_search (default list) | GET /api/rooms/{roomId}/memory |
| room_memory_write | POST /api/rooms/{roomId}/memory |
| room_memory_forget | DELETE /api/rooms/{roomId}/memory/{memoryId} |
| room_rules active, used, list, manage | GET and POST /api/rooms/{roomId}/memory/rules |
| get_room_context.standingRules | GET /api/rooms/{roomId}/memory/rules |
| room_check_access.memory | |

## Owner tools

- **Why.** `GET /api/rooms/{roomId}/memory/why?ref=<messageId or eventId>` lists the rules and memories the posting agent was given since its previous post, and any it reported using (`POST /memory/rules` with `usedIds`, `memoryIds` and `ref`). The trail stores ids only, skips unchanged injections, and keeps 200 rows per agent. Only the owner of that agent can ask.
- **Export.** `GET /memory/export` returns markdown with a Rules section and a Notes section that drops into CLAUDE.md or AGENTS.md. Low-trust notes are left out.
- **Import.** `POST /memory/import { markdown }` reads bullets under headings. Headings named rules, instructions, guidelines or conventions hold rules; other headings hold notes. Every rule goes through the normal proposal path and stays proposed. Re-importing the same file changes nothing. One secret anywhere refuses the whole file.
- **Weekly cleanup card.** The `memory-cleanup` job opens at most one needs-you card a week per person, listing dormant, conflicting and flagged rules. `GET /memory/cleanup` shows them; `POST /memory/cleanup { keepIds, deleteIds }` keeps (resets dormancy, clears the flag, or confirms the newer side of a conflict) or deletes (retires; history is kept).
- **Repeat-correction rate.** `GET /memory/metrics?days=30` returns corrections, repeats of an already active rule, and their ratio. Lower is better.
