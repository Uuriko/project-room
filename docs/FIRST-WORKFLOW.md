# FIRST-WORKFLOW — What to replace first

**Principle check (multiplayer-ai.com):** People are not routers — humans decide; agents chase status and post receipts.

Goal: pick **one** concrete workflow where a Project Room beats Slack/Discord/email/agent-mailbox spaghetti. Prove the Assign→Act→Receipt→Decide loop (SPEC-v0).

---

## Candidate A — Swarm / GitHub mailbox coordination (e.g. #167-style)

**What it is today**
Multi-agent or multi-session work against a GitHub issue/mailbox thread: status lives in issue comments, agent runs in Cursor/cloud UIs, pings land in Slack/Discord, operator forwards context so the next agent doesn’t cold-start. Classic split brain.

**Room-shaped replacement**
- Project = that coordination effort (issue/mailbox as external link).
- Tasks = slices assigned to specific agents (investigate, implement, verify).
- Outcomes = PR URLs, test artifacts, “blocked on X” receipts.
- Human decides merge / next slice in-room.

**Pros**
- Pain is acute and frequent for an agent-heavy operator.
- Natural Outcomes (PR, logs, screenshots) — Cursor-like receipts already exist.
- Matches spine: who-owns-what + visible outcomes.
- Easy week-1 scoreboard: count closed loops per issue.

**Cons**
- Temptation to rebuild GitHub (don’t).
- If the only “agent” is one coding agent, loop is thinner than multi-agent claim.
- Needs discipline: agent must post Receipt into Room, not only push a branch.

**Fit to v0 must-have:** Strong.

---

## Candidate B — Founder briefing agents

**What it is today**
Operator asks research/ops agents for briefings (market, competitors, inbox triage, “what happened overnight”). Answers scatter across ChatGPT/Claude/Cursor chats, email digests, and Slack saves. Next day context is gone unless manually filed.

**Room-shaped replacement**
- Project = “Operator briefings” (or per-theme projects).
- Daily/on-demand Task → briefing agent.
- Outcome = structured brief (doc link or in-room artifact) + sources.
- Human marks decisions / follow-up Tasks in the same Room.

**Pros**
- Low engineering dependency; can dogfood with paste-in receipts.
- High personal value; trains Outcome-as-artifact habit.
- Clear human judgment step (decide what matters).

**Cons**
- Weaker “collaboration” story — can feel like a notes app + cron.
- Less pressure on multi-member identity and task ownership under conflict.
- Success metric fuzzier than PR-merged.

**Fit to v0 must-have:** Medium — proves shared context + outcomes, weaker on multi-agent ownership stress.

---

## Candidate C — Hiring packet handoff

**What it is today**
JD drafts, scorecards, candidate research, and email threads live in Docs + email + chat. Agents may draft packets; humans edit in parallel; “final packet” is whoever forwarded last.

**Room-shaped replacement**
- Project = “Hire [role].”
- Tasks = draft JD, source list, packet v1, reference check outline — assigned to human or agent.
- Outcome = versioned hiring packet + decision Outcome (advance / reject / hold).

**Pros**
- Sharp ownership and decision receipts.
- Mixed human+agent work is obvious (agent drafts, human decides).
- Non-coding workflow diversifies the product thesis.

**Cons**
- Lower frequency than engineering coordination for some operators.
- Sensitive data (candidates) → privacy/redaction open questions earlier.
- External email with candidates still exists (Room won’t replace that in v0).

**Fit to v0 must-have:** Medium-strong — excellent ownership/outcome semantics; slightly less daily dogfood volume.

---

## Recommendation: **Candidate A — Swarm / GitHub mailbox coordination**

**Why one**
1. Hits the locked problem statement hardest: stop manual forwarding across agent UIs + chat + issue comments.
2. Best stress test of Agent-as-member + Task assignee + Outcome/Receipt (PR/artifact).
3. Week-1 success criteria in SPEC-v0 are objectively countable.
4. Keeps v0 honest: Room is spine; GitHub remains system of record for code.

**How to run week 1**
- Create one Project/Room for the active coordination target (link the GitHub issue/mailbox in Room description).
- Every agent slice = Task with named assignee.
- No “done” without an Outcome (PR link, log, or blocked receipt).
- Human merge/next-step decisions posted as Decision Outcomes.
- Ban Slack/Discord for that project’s agent coordination for 5 days (stakeholder noise can stay elsewhere).

**Park for v0.1+**
- Briefings (B) as a second Room once the loop is muscle memory.
- Hiring (C) when permissions/redaction answers exist.

**Non-recommendation**
Do not start with “rebuild #general” or “bridge Slack.” That violates the locked spine.


## Codex fixture (2026-09-05)

Reference receipt: [NodeBlink #134](https://github.com/Uuriko/dasha-desk/pull/134) @ `70053cc6cf9d86f3a43220dcfbb0af05797380c0` — “28/28, invariant comparison PASS, owner merge pending.” Second fixture: [Compute #132](https://github.com/Uuriko/dasha-desk/pull/132). v0 dogfood = productize that owner-steer loop without manual forwarding.

## Instinct pressure-test (2026-09-05)

#134 chronology: proposed → accepted (Codex audit, work already present) → completed + independently_verified (Instinct 28/28 @ exact SHA) → owner_approved PENDING.
#132 chronology: proposed → working (Codex prep c7521057) → completed + independently_verified (Instinct 18/18 + live-kit) → owner_approved PENDING.
State machine held. Acceptance checklist + five failure modes folded into SPEC-v0.md.
