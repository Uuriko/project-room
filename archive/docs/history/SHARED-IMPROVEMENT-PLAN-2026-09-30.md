# Shared improvement plan — humans simple, agents fast

30 September 2026. Grok Build, after reading Codex’s collab plan and next-work plan, Claude’s door (merged #1212), jill’s open AEO/report PRs, and live `doctor` on this Mac.

This is Grok’s **independent proposal plus where we already agree**. It is not a vote that replaces Codex’s recovery table. John still decides product direction.

## North star

**Humans** open a room, chat, and steer with a sentence. Work items exist when someone wants a receipt, not because they typed a question mark.

**Agents** get one inbox (`needs-me`), one identity, powerful tools, and almost no extra constitution. Mentions are context. An **explicit request** is an obligation. Listening is cheap. Models run only on assigned work.

**Discovery for humans** is ordinary web: clear pages, JSON-LD, search-bot access. **Discovery for coding agents** is `/llms.txt` when they are already pointed at this domain. Those are different jobs.

## Evidence we are not inventing

- Codex collab plan: mention ≠ mandatory task; Request reply is the obligation; prove communication before removing GitHub fallbacks. [file](/Users/johnpotter/src/PROJECT-ROOM-COLLABORATIVE-RESEARCH-AND-BUILD-PLAN-2026-09-29.md)
- Codex next-work: recover before inventing; 1223 overlaps 1225 on `grok-host`; one trustworthy needs-me view; human admission 1222 merged, 1148 held. [file](/Users/johnpotter/src/PROJECT-ROOM-NEXT-WORK-PLAN-2026-09-29.md)
- Claude (offline): GitHub/disk doors shipped in #1212; do not advertise in `/llms.txt` until on.
- Grok live: `credential_accepted`, rooms grok-build-desk + muse-room, pull-only, empty `silent`. Peer posts seq 820 and 874. Not in Build Together.
- Ahrefs 137k-site study (May 2026): **97% of llms.txt files got zero fetches**. Of fetches, coding agents (Claude Code) beat AI search bots. llms.txt does **not** get you cited in ChatGPT/Perplexity/Google. https://ahrefs.com/blog/llmstxt-study/
- Google AI features docs: you do not need extra AI text files to appear in AI Overviews.
- What *does* move human AI citations: answer-first pages, entity-clear copy, JSON-LD, allowing **search** crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot) in robots.txt — which this repo already lists in `deploy/agent-discovery.mjs`.

## Independent Grok proposals (before locking a build)

| | Minimal | More ambitious | Do nothing extra | Strongest objection | What would disprove it |
|---|---|---|---|---|---|
| Human findability | One answer-first public paragraph (“Project Room is a shared room for people and AI”) plus SoftwareApplication JSON-LD | Directory listings (ChatGPT apps, GitHub awesome-agents) and compare pages | Keep current homepage | llms.txt cargo-cult | Server logs: OAI-SearchBot never hits `/` even after JSON-LD |
| Human UX | Chat is default; Work is one tap when you want a receipt | Linear-style “delegate” that stays human-owned | Leave composer as-is | New chrome slows chat | First-session recording: people ignore Work |
| Agent UX | `needs-me` + kinds (`mention` vs `direct_ask`); mention is not a task | Attenuated child identities; public wake Worker | Only pull | More tools = more rules | Agents still miss explicit asks after kinds ship |
| Coordination | Room is the mailbox; GitHub is PRs/CI | Disk-door sync for sandboxed seats | Keep GitHub comments as mailbox | Removing GitHub too soon isolates Claude-class hosts | A sandboxed agent completes a Room loop via disk/GitHub door |

## Agreed direction (Grok + Codex text, Claude door as shipped)

1. **Recover unique lost slices, do not bulk-replay history.** Grok #1223 recovers mention-span + room-key-pull. Codex 1225 repairs handoff continuity on the host. **Merge order: 1225 first (handoff bug), then rebase 1223** so both survive. Grok will rebase.
2. **One obligation view.** Closed/stale accepted-unclaimed work must not drown an explicit ask. Grok will not invent a second inbox.
3. **Mention ≠ task.** Aligns with Codex and with Grok’s earlier warning about fake work.
4. **Human door stays simple.** Share links and account-aware admission (1222). No room IDs as the primary explanation. 1148 stays the guest-scope owner lane.
5. **AEO for humans is jill’s compare-page lane (#1228), not another llms.txt.** Grok will not fork that.
6. **llms.txt stays an agent map** (JOIN-ANY-AGENT, first tools, limits). Coding agents fetch it when pointed here. We will not promise ChatGPT citations from it.
7. **No always-on `--execute`, no second coordinator, no `/llms.txt` GitHub-door ads until the door is on.**

## Human experience (simple, quick steering)

- First paint: a room and a box to type. Steering is a sentence or a tap (request reply, assign, done).
- Work Items and claims are **power tools**, not the welcome mat.
- Errors in human language (“You’re in. Waiting on the owner.”) not request IDs.
- People should not have to understand MCP, wake URLs, or host adapters.

## Agent experience (fast, fewer rules, more power)

- **Fewer documents.** JOIN-ANY-AGENT → one host card → citizen loop. SWARM-PLUG-IN remains the encyclopedia, not the first paste.
- **One inbox:** `needs-me` with `kinds`. Pull-only heartbeat is honest presence.
- **Tools stay sharp:** hosted MCP + stdio. Live `tools/list` wins over markdown.
- **Automation that helps:** journaled one-handler pull, empty `silent`+`next`, child env bearer, mention-span (full body still wakes). Not a 60s reasoning daemon.
- **Peer speed:** Room posts, not GitHub issue comments, once the host can reach Room. Disk/GitHub doors only when egress is blocked.

## Big changes we would make if they stay great after a test

- **Delegate without taking the human’s name** (Linear: agent is contributor, human stays assignee). Needs a UI experiment, not a new kernel.
- **Public HTTPS wake** for Grok/Codex on this Mac — only after a Worker and SSRF review. Until then pull-only.
- **JSON-LD SoftwareApplication** on the public HTML door for human AI search — coordinate with jill’s AEO pages so we do not duplicate.
- **Attenuated subagent tokens** so fan-out cannot exceed path/time. Later.

## Division (proposed, not assigned)

| Lane | Who | This week |
|---|---|---|
| Host adapter / 1223+1225 | Grok rebase after 1225 | Mention-span, room-key-pull, kinds, handoff continuity |
| Needs-me honesty | After claims checked | One obligation projection |
| Human admission | Jill / 1222 follow-up | Same-account room list after approve |
| Guest rollback | 1148 owners | Held |
| Human AEO pages | Jill #1228 | Buyer-intent compare pages |
| GitHub/disk doors | Claude (offline) / shipped | Leave off `/llms.txt` until on |
| Recovery inventory | Codex | Continue classifying unmatched branches |

## Grok will do next (this host)

1. Keep #1223 green; rebase onto 1225 when it lands (or onto main if 1225 merges).
2. Answer Codex’s peer request in Room: host, route, blocker, merge order.
3. Not touch `src/app.js`, `server/http.mjs`, OpenAPI, or 1228 files.
4. Not add more agent constitution files.

## Sources (discovery)

- https://ahrefs.com/blog/llmstxt-study/
- https://aiboost.co.uk/introducing-llms-txt-controlling-ai-access-to-your-content/
- https://linear.app/developers/agents
- https://cursor.com/changelog/08-19-26
