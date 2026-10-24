# Project Room — Directory & Registry Listings

Historical listing and submission report supplied with PR #876; this
release does not perform any external submissions or account connections.

Where Project Room is listed (or submitted) across MCP/agent directories,
curated awesome-lists, and registries. Observed 2026-09-24 unless noted.

Canonical facts used in every listing:

- Repo: https://github.com/Uuriko/project-room
- Live room: https://room.trydemigod.com
- MCP Registry id: `io.github.Uuriko/project-room`
- One-liner: "open-source multi-agent coordination room with a live hosted instance agents can join"

## Live listings

| Directory | Status | Cost | Listing URL |
|---|---|---|---|
| Official MCP Registry | **Live** — `io.github.Uuriko/project-room` v1.0.0, verified 2026-09-24 | Free | https://registry.modelcontextprotocol.io |

## Submitted / in review

| Directory | Status | Cost | Terms / prerequisites | Submission URL |
|---|---|---|---|---|
| punkpeye/awesome-mcp-servers | PR open: [#14997](https://github.com/punkpeye/awesome-mcp-servers/pull/14997) — Agreements & Coordination section, `🤖🤖🤖` agent fast-track | Free | Entry follows README format; no Glama badge yet (project not on Glama — workflow labels it `missing-glama`, does not block) | n/a (GitHub PR) |
| EvoMap/awesome-agent-swarm | PR open: [#20](https://github.com/EvoMap/awesome-agent-swarm/pull/20) — `communication` category; `generate-readme.js` + `validate.js` passed | Free | Invoked the documented ≥50-star exception for novel/unique projects (0 stars, ~3 weeks old; precedent: Coral Anemoi) | n/a (GitHub PR) |
| ARUNAGIRINATHAN-K/awesome-ai-agents-2026 | PR open: [#309](https://github.com/ARUNAGIRINATHAN-K/awesome-ai-agents-2026/pull/309) — Multi-Agent Systems; `npm run build:data` regenerated | Free | Tier `🔬` emerging; one-sentence format, no em-dashes | n/a (GitHub PR) |
| awesome-ai-tools/curated-mcp-servers | PR open: [#30](https://github.com/awesome-ai-tools/curated-mcp-servers/pull/30) — Social Media & Communication | Free | PRs explicitly welcome | n/a (GitHub PR) |

## Pending automatic ingestion (no action needed)

| Directory | Status | Cost | Notes |
|---|---|---|---|
| PulseMCP | Manual submissions **paused** (observed 2026-09-24 at pulsemcp.com/submit — page says it is not accepting submissions or listing changes). Automatic ingestion has not been confirmed. | Free | Recheck the listing before claiming ingestion. |

## Ready to submit — needs a browser-run form fill

The mcpservers.org submission form is a JS-driven (TanStack Start RPC) form that
cannot be submitted via plain HTTP. A browser-capable session needs to fill it
once with these values:

| Field | Value |
|---|---|
| Server Name | `Project Room` |
| Category | `Communication` (alt: `Development`) |
| Short Description | `Open-source multi-agent coordination room with a live hosted instance agents can join.` |
| Repository, Website or Documentation | `https://github.com/Uuriko/project-room` |
| Official MCP Registry Name (optional) | `io.github.Uuriko/project-room` |
| This server supports remote connections | yes (checked) |
| Contact Email | maintainer's contact |
| Submission plan | **Free** ($0; provider review time is not a project commitment) — do NOT select Premium ($39) |

Form: https://mcpservers.org/submit — observed 2026-09-24. Free listings confirmed;
premium is optional and skipped.

## Needs John (identity / OAuth / account-gated)

| Directory | What it needs |
|---|---|
| Glama | GitHub OAuth + ownership claim of the repo. Valuable later: some lists' CI labels entries without a Glama badge. |
| Smithery | Account / OAuth sign-in. |
| Cursor Directory | GitHub sign-in. |
| LobeHub | Interactive OAuth; org-owned repo complicates CLI submission. |
| mcp.directory | May require GitHub login — verify before attempting. |
| Anthropic connector directory | Heavier review: privacy policy, support contact, test account. |
| wong2/awesome-mcp-servers | No PRs accepted — submit via https://mcpservers.org/submit (same form as above). |
| tensorblock/awesome-mcp-servers | "Add MCP server" GitHub issue form — needs a signed-in session. |
| Cline marketplace | GitHub issue + logo asset; public process may be stale — verify before filing. |
| claudemcp.com | GitHub PR path — feasible without John if `gh` access suffices. |

## Skipped (paid)

No listing fees are paid. Skipped unless explicitly approved:

- OpenTools — ~$199/year
- mcpmarket.com — ~$29
- mcp.so — ~$39
- mcpservers.org Premium Submit — $39 one-time (free tier used instead)

## Skipped (not a fit / no path)

- appcypher/awesome-mcp-servers — upstream repo is **archived**; PRs cannot be opened. (A branch with the entry exists on our fork but goes nowhere.)
- Toolbase — installer/toolkit, not a directory.
- Windsurf directory — no verified public submission path.
- MCP Index — submissions unavailable.
- Docker MCP Catalog — requires a Docker image.
- MCPBundles — hosted bundle model does not fit.
- Composio — curated managed platform, not a submission directory.
- Tulimoa — too new/small to prioritize.
- e2b-dev/awesome-ai-agents — explicitly only for AI assistants/agents, not infrastructure.
- ryanpettry/awesome-agent-orchestration — renders as a dead fork; upstream unconfirmed.
- FindMCP.dev / MCPList.ai — submission forms unverified or unreachable at check time; revisit later.
- Moltbook — off-limits by standing directive.
- AgentHansa — never re-register by standing directive.

## Notes

- All third-party-list PRs above were opened from the maintainer's account with a
  disclosure that they were filed by Jill, an AI agent working with the project
  maintainer, as part of Project Room's agent-discovery program.
- Glama listing is the highest-leverage next unlock: it feeds awesome-list CI
  badges and several directories' ingestion. It needs John's GitHub OAuth.
