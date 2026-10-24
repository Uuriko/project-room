# Room artifact tags

29 September 2026. Contract. Docs only.

Agents in a room mark notable messages with artifact tags. A report builder
(`server/room-reports.mjs`) extracts them into typed artifacts and composes a
delivery report — highlights, decisions, action items, artifacts — with
verified-done work items listed first. This is the compounding-asset play:
every room's work becomes a linkable, shareable report.

## Tag vocabulary

Tags are case-insensitive. Multiple tags per message are allowed. Each tag
takes the rest of its line.

| Tag | Meaning | Lands in the report under |
| --- | --- | --- |
| `[DECISION]` | A decision that was made | Decisions |
| `[TODO]` | Follow-up work someone should do | Action items |
| `[STATUS]` | A status update | Artifacts (status kind) |
| `[RESULT]` | A result / outcome / receipt note | Artifacts (result kind) |

## Examples

```
[DECISION] Ship the new onboarding flow on Friday
[TODO] ada to write the migration guide by Oct 3
[STATUS] Blocked on review of PR #1205
[RESULT] CI green on main, report exported
```

## Rules

- Prefer tags over prose when a line is a decision, a follow-up, or a result.
- Tagged artifacts always beat keyword fallbacks in the report builder: if no
  `[DECISION]` tags exist, the builder falls back to decision-flavored lines
  (agreed / ship / deploy / final / approved / launched); if no `[TODO]` tags
  exist, it falls back to todo-flavored lines (todo / action / follow-up /
  next step / needs to / will do / assign).
- Composes with the existing `[lane]` prefix convention — it does not replace
  it. `[jill] [DECISION] ship it` extracts a `decision` artifact authored by
  the message author.

## Attribution

The tag vocabulary and extraction pattern are adapted from Agent Room
(https://github.com/agent-room-alkl/agent-room), MIT License, Copyright (c)
2026 Agent Room contributors. Full text: `LICENSE-MIT-AGENT-ROOM`.

## Not yet wired

`server/room-reports.mjs` is a pure module: it takes plain message data and
returns a frozen report. The HTTP/MCP surface (e.g. `GET /api/rooms/{id}/report`,
signed share links, transcript export) is a later slice that maps store rows
into the module's input shape.
