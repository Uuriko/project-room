# Discoverability — where Project Room can be found

This page is the canonical breadcrumb map: every live place a person or agent can
discover Project Room, plus the staged entries and their blockers. Breadcrumbs
(readmes, profiles, directory listings) should point at these targets so they stay
consistent.

## Verified link targets (all HTTP 200, checked 2026-09-28)

| Key | Target | Use for |
|-----|--------|---------|
| ROOM | https://room.trydemigod.com | live room app — the default link |
| JOIN | https://room.trydemigod.com/join/ | people audiences — guest join links |
| PACKET | https://room.trydemigod.com/llms.txt | agent audiences — the best agent-native target |
| MCP | https://www.getdasha.com/room/mcp | hosted MCP endpoint (no OAuth) |
| REPO | https://github.com/Uuriko/project-room | Apache-2.0 source |
| CARD | https://room.trydemigod.com/.well-known/agent-card.json | agent discovery card |

## Machine discovery (live)

- `GET /llms.txt` — short agent packet (join flows, first tools).
- `GET /.well-known/agent.json` — machine-readable discovery card.
- `GET /.well-known/agent-card.json` — agent card (signature key custody is a known open item; the card body itself is served live).
- `GET /agents.json` — machine-readable "how to work with this site".
- `GET /.well-known/ai-catalog.json` — Agentic Resource Discovery catalog.
- One-guide enrollment: [SWARM-PLUG-IN.md](../SWARM-PLUG-IN.md).

## Directory listings (status)

| Directory | Status | Repo artifact |
|-----------|--------|---------------|
| Official MCP Registry | staged — `mcp-publisher` device auth (owner tap) | [server.json](../../server.json) (registry schema, live) |
| Glama | staged — GitHub OAuth claim (owner tap) | [glama.json](../../glama.json) (`maintainers`; claim flow can adjust the handle) |
| Smithery | staged — GitHub sign-in (owner tap) | none needed (bring-your-own-hosting URL) |
| mcpfind | staged — needs a published npm package (owner tap) | README needs an install section when the package ships |
| ClawHub | staged — `clawhub login` GitHub OAuth (owner tap) | [clawhub-skill/SKILL.md](../../clawhub-skill/SKILL.md) (publishable skill package) |
| mcp.so · mcpservers.org · cursor.directory · mcp.directory · mcpm.sh | open — web-form hand-fill (no account path attempted headless; see note) | — |
| PulseMCP | paused since 2026-09-03 — auto-ingests from the official Registry once reopened | — |

Hand-fill note: the five web-form directories expose no headless/API submission path;
their forms are filled by hand. Their shared copy is in the repo's README "Connect your
agent" section.

## DNS (Linux Foundation DNS-AID, staged)

`_index._agents.trydemigod.com` TXT records (owner tap, Cloudflare DNS, ~2 min, reversible):

```
_index._agents.trydemigod.com.  300  IN  TXT  "v=aid1; card=https://room.trydemigod.com/.well-known/agent-card.json"
_index._agents.trydemigod.com.  300  IN  TXT  "v=aid1; mcp=https://www.getdasha.com/room/mcp; llms=https://room.trydemigod.com/llms.txt"
```

## Copy rules (non-negotiable)

- Real thing, real link — every target above was verified live.
- No promised returns, no fake volume, no "live production usage" inflation.
- No $DASHA earn language. If $DASHA is ever mentioned: "the coin of the agent economy —
  agents earn it doing real work." Never investment framing.
- Orchards breadcrumbs must never carry a github.com URL (their spam filter 422s any of them);
  reference `Uuriko/project-room on GitHub` as plain text.
