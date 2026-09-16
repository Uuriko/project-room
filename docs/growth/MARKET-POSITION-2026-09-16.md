# Where Project Room actually stands

16 September 2026. Claude (Cowork) growth lane. New file. No deploy, no push.

## Why this exists

Everything in [GROWTH-ENGINE-2026-09-15.md](GROWTH-ENGINE-2026-09-15.md) was derived
from inside the repo: the live first run, the event model, the Room's own plans.
None of it had been checked against what else shipped this year. That was the
largest untested assumption in the growth work, so this document tests it.

The short version: one of the claims in that document is now wrong, the product
is still differentiated, and the differentiation is narrower and more specific
than what was written.

## The finding that matters

OpenAI shipped **workspace agents** in ChatGPT earlier this year. They are shared
organisational agents, not one-to-one assistants. They can be "added to Slack
channels so the team can ask it questions and collaborate around its outputs".
They run in the cloud, "so they can keep working even when you're not". Coworkers
browse and reuse each other's agents through what VentureBeat describes as "a
kind of team directory: a place where agents built by coworkers can be reused
across a workspace". Admins govern who may build, run and publish. Pricing moved
to credits after 6 May 2026, on ChatGPT Business and above.

That is agents as addressable members of a shared team chat, with a hosted
runtime and a reuse directory, shipped by the largest player, inside the chat app
teams already have.

## What this invalidates

The growth engine document says the agent witness loop is "the wedge" and that
"no ordinary chat product can run it". **That is now false and I am retracting
it.** Someone watching a coworker's agent work in `#user-insights` and then
reusing it from the workspace directory is the witness loop, running in Slack,
with a shorter path from sighting to adoption than Project Room offers, because
the directory removes the "ask the owner how they did it" step.

The loop is still real and still worth measuring. It is no longer a moat.

## What is actually still different

Four things survive the comparison. Only the last two look durable.

| Claim | Honest assessment |
| --- | --- |
| Agents are members of a shared room | **Gone.** OpenAI does this inside Slack. |
| Any vendor's agent can join | **Weak.** Slack has always taken third-party bots, and this Mac already runs Claude in Slack alongside Codex and Grok. |
| No hosted runtime | **Real, and cuts both ways.** It is why a house agent cannot be supplied, and it is also why there is no credit meter, no vendor lock, and nothing of yours running on someone else's servers. The agent is yours, on your keys. |
| Conversation that leaves an accountability record | **Real.** Work items, designated verifiers, owner decisions, evidence-linked receipts and exact-version checks are the product, and the agent card says so: `"kind": "ledger"`, `"not": "run factory"`. Workspace agents are a run factory. |

Agent accountability is not an empty category: AgentLedger, AGLedger and
AuditBadger are all selling audit trails for agent work this year, and
AuditBadger's pitch ("AI agents propose, humans approve, and the audit trail
proves it") is close to this Room's own model. The difference is shape rather
than novelty. Those are compliance tools bolted beside the work. Here the record
is a byproduct of the conversation people were having anyway, which is the only
version of an audit trail that gets kept.

## The beachhead this implies

Stop competing for "teams who want AI in their chat". OpenAI has that, distributed
through Slack, priced into a seat people already buy.

The underserved user is the **multi-agent operator**: someone running several
agents from different vendors at once who has no neutral ground and no record of
what each one did. That person exists, is findable, and is currently improvising
with shared files and a homemade bus. The owner of this repo is one, running
Codex, Grok Build, Cursor, Claude in Slack, Instinct and Muse simultaneously, and
the coordination layer holding that together is a markdown board and a JSONL
channel on one Mac.

That segment is structurally unserved by the obvious competitors. OpenAI wants the
fleet to be ChatGPT agents. Slack treats an agent as an app install with admin
approval and no accountable person attached. Neither will build a neutral room
where a rival's agent is a first-class member with a named human answerable for
it, because neither benefits from it.

This also changes who the first users are. Not teams. Operators. And the referral
path is operator to operator, which is a smaller graph than team-to-team but a far
denser one.

## Two decisions that are yours, not mine

**A2A.** The agent card says `"a2a": false` with the note "Custom discovery only.
No A2A message or task transport is implemented." As of Q1 2026 MCP, A2A and ACP
are all under Linux Foundation oversight, and the two-layer split of MCP for
tools and A2A for agent-to-agent coordination is becoming the enterprise default.
Opting out is defensible, and the research is explicit that alternatives stay
viable, so this is not an emergency. It should be a decision that gets made on
purpose and written down, rather than a default that quietly hardens.

**The unsolved problem worth noticing.** The same research says that in agent
interoperability, "finding agents you do not already know about remains unsolved".
Discovery is the open gap in the ecosystem, and discovery is the single strongest
thing this product already has. `/.well-known/agent.json` names a first tool per
route, declares what is not implemented rather than hiding it, and an agent
arriving cold can orient from it. That strength is currently pointed inward, at
agents joining this Room. Whether it should point outward is a real strategic
question and well above a lane decision.

## What this does not claim

No user research, no interviews, no usage data. This is desk research against
public sources, set beside what the repo and the live site actually do. It is
enough to retract a moat claim and to name a beachhead. It is not enough to
confirm that the beachhead converts, and nothing here should be read as evidence
that it does.

## Sources

- [Introducing workspace agents in ChatGPT, OpenAI](https://openai.com/index/introducing-workspace-agents-in-chatgpt/)
- [OpenAI unveils Workspace Agents, VentureBeat](https://venturebeat.com/orchestration/openai-unveils-workspace-agents-a-successor-to-custom-gpts-for-enterprises-that-can-plug-directly-into-slack-salesforce-and-more)
- [Agent Interoperability Protocols 2026: MCP, A2A, ACP and the Path to Convergence, Zylos Research](https://zylos.ai/research/2026-03-26-agent-interoperability-protocols-mcp-a2a-acp-convergence/)
- [AuditBadger launches auditable agentic compliance](https://www.openpr.com/news/4618927/auditbadger-launches-auditable-agentic-compliance-ai-agents)
- [AgentLedger: Audit Trails for AI Agents That Matter](https://dev.to/forgeflows/agentledger-audit-trails-for-ai-agents-that-matter-57c8)
