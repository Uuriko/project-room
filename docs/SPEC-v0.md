# SPEC-v0 — Project Room (human + agents)

Locked spine: 2026-09-05. Spec seed for Uuriko/project-room — docs only until further owner go on implementation.

**Inspiration (owner 2026-09-05):** [Multiplayer AI Manifesto](https://multiplayer-ai.com/) — fold principles (esp. never copy-paste, people are not routers, nothing from scratch, door open). See `MULTIPLAYER-AI-INSPIRATION.md`. Not a Superconductor/coding-sandbox clone; not a brand lock.


## Problem

Founders/operators and their AI agents split context across Slack, Discord, email, and agent mailboxes. Work requires manual forwarding, copy-paste, and “who has the latest?” Agents don’t share a persistent conversation with clear ownership or visible outcomes. The cost is delayed decisions, duplicated effort, and invisible agent work.

## Primary users

1. **Operator (human)** — founder or solo/small-team operator who directs agents and makes judgment calls.
2. **Agents** — persistent AI workers the operator owns (research, coding, ops, hiring assist, etc.), participating in the same room as first-class members.

Secondary (post-v0): additional humans (cofounder, contractor) in the same room.

## Product shape

**First-party Project Room** — not a Slack/Discord clone, not a Slack bridge as MVP.

- One room per project.
- Shared context in one conversation.
- Who-owns-what is always visible.
- Outcomes are visible (not buried in scroll).
- Prove **one** useful human↔agent collaboration loop end-to-end.

## Non-goals (v0)

- Cloning Slack/Discord feature matrix (channels, reactions economy, voice, nitro, etc.).
- Slack/Discord/email bidirectional bridge as the product.
- Multi-tenant enterprise admin suite / SSO / SCIM.
- Open marketplace of third-party bots.
- Replacing GitHub/Linear/Notion as systems of record — *link and receipt*, don’t rebuild.
- Fully autonomous multi-agent swarms without a human in the loop.
- Computer-use over arbitrary UIs as the default action model.

## Core objects

### Project
Top-level unit of work the operator cares about (e.g. “Ship v0 spine docs,” “Hire eng #1,” “Mailbox swarm coordination”).
- Fields: `id`, `title`, `status` (active/paused/done), `owner_human_id`, `created_at`.
- Has exactly **one** Room in v0 (1:1).

### Room
The persistent conversation + shared context for that Project.
- Members: humans + agents.
- Holds Messages, Tasks, Outcomes.
- Single scroll with pinned “board” strip: open Tasks + recent Outcomes.

### Message
Utterance in the Room from a Member (human or agent).
- Fields: `id`, `room_id`, `author_member_id`, `body`, `created_at`, optional `reply_to_id`, optional `attachments[]`.
- Messages may *reference* Tasks/Outcomes; they don’t replace them.

### Agent
First-class member, not a webhook guest.
- Fields: `id`, `display_name`, `owner_human_id`, `capabilities` (opaque tags for v0), `status` (idle/working/blocked), `auth_scope` (what it may do).
- Every Agent has a clear human owner.

### Task
Owned unit of work inside the Room.
- Fields: `id`, `room_id`, `title`, `assignee_member_id` (human **or** agent), `state` (todo/doing/blocked/done), `definition_of_done`, `created_by`, timestamps.
- Rule: no ambient “someone should…” — create a Task or it doesn’t exist.

### Outcome / Receipt
Proof that work happened or a decision landed.
- Fields: `id`, `room_id`, `task_id?`, `producer_member_id`, `type` (artifact | decision | handoff | external_link), `summary`, `payload` (URL, file ref, structured JSON), `created_at`.
- Examples: PR URL + diff summary, research brief doc, “hire packet ready,” agent→human escalation note, “decision: ship A not B.”

## One collaboration loop (MVP)

**Name:** Assign → Act → Receipt → Decide

1. **Human** states goal in the Room (Message) and creates/assigns a **Task** to an **Agent** with a clear definition of done.
2. **Agent** acknowledges in-room (Message), sets Task → doing, does the work in its runtime (whatever that is — out of band OK for v0).
3. **Agent** posts an **Outcome/Receipt** (link/artifact/summary) and sets Task → done or blocked (with reason).
4. **Human** reviews the Receipt in the same Room, decides (Message + optional Decision Outcome), and either closes the loop or assigns the next Task.

**Success of the loop:** A stranger opening the Room can answer: What was asked? Who owned it? What was produced? What did the human decide?

No requirement that the agent *runs inside* the product in v0 — only that the Room is the spine for assign/ack/receipt/decide. Runtime integration can be manual paste of receipts at first, then API.

## Permissions & identity

### Identity
- **Human**: authenticated operator account.
- **Agent**: identity keyed to owner human; acts only with that owner’s grant.
- Display: every Message/Task/Outcome shows member type (human|agent) and display name. No anonymous agents.

### Permissions (v0, single-operator)
- Room members: owner human + agents they attach.
- Owner can: post, create tasks, assign anyone in room, accept/reject outcomes, remove agents, archive project.
- Agent can: post messages, update tasks assigned to it, create Outcomes for its tasks, mark blocked.
- Agent cannot: reassign tasks to other agents without human approval; invite new humans; escalate its own auth_scope.
- Audit: append-only event log for task state changes and outcome creation (readable in Room).

### Later
- Additional humans with roles (edit vs view).
- Per-agent tool scopes and spend limits.
- External guests (Slack-Connect-like) — explicitly post-v0.

## What “done” looks like for v0

Must-have:
- [ ] Create Project → get Room.
- [ ] Add ≥1 Agent as member.
- [ ] Create Task, assign to Agent, Agent posts Receipt, Human decides — all visible in one Room.
- [ ] Board strip: open tasks + last N outcomes without searching scroll.
- [ ] No Slack bridge required to complete the loop.

Explicitly optional for v0: realtime presence, rich reactions, file storage beyond links, multi-human, mobile apps, email gateway.

## Week-1 success (dogfood)

Operator uses **one** real Project Room for **one** nominated workflow (see FIRST-WORKFLOW.md) for 5 consecutive working days.

Pass criteria:
1. ≥5 closed Assign→Act→Receipt→Decide loops in that Room.
2. Zero times the operator needed Slack/Discord/email to complete that project’s agent handoff (links out to GitHub/Docs OK).
3. Operator can open the Room and reconstruct project state in <2 minutes without asking an agent “what’s going on?”
4. At least one blocked Task with a clear blocker Outcome (proves failure path, not only happy path).

Fail criteria (honest):
- Room becomes another inbox; tasks still live only in the operator’s head.
- Agent work still only visible in agent product UIs with manual forwarding back.
- Outcomes are just chat messages with no structured Receipt.

## Convergence deltas (mailbox #167)

Nightly Codex/Instinct/Grok Bot convergence (authorization, failure paths, fixtures a/b, negative walks) is captured in:

- [EVENT-FIXTURES.md](./EVENT-FIXTURES.md) — normative transition table + fixtures + negative paths
- dasha-desk PR #167 conversation (authoritative thread)

Implementation remains blocked until a further explicit owner go.
