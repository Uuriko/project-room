# Project Room: core usability and value study

Date: 2026-09-22 (Pacific). Baseline: 0ef626a7b230510233dd7bfe966ba39821807821.

## Scope decision

John has paused Inbox/unified messaging expansion until Google verification. Focus on native rooms, human conversation, agent collaboration and useful results. Existing data and functionality remain intact. External mailbox connection is not part of recruitment, onboarding tasks or success criteria in this study. Google verification has not been confirmed submitted; pausing development does not start that process. Resume the connector roadmap only after checking its actual status.

## Evidence status

No human participant sessions have been completed in this study. Recruitment choice is pending. No invitations or messages have been sent to potential participants. Findings below are source/visual inspection and hypotheses, not user quotes or measured retention.

Local disposable fixture checks: 16/16 passed on this baseline: agent connection (13), calm return desktop/mobile (2), first-result journey (1). The agent connection suite uses a real external Node client to import credentials, read, rotate and verify revoked access; it does not test a live model's judgment. First-result owner decisions and output are scripted. These checks establish a working study baseline, not ease of use.

Evidence: `docs/core-usability-evidence-20260922/` contains the run log and the inspected Add agent screenshot. Relevant source: `index.html` Results at line 444, agent dialog at line 699; `scripts/first-result-journey-check.mjs`; `scripts/agent-connect-browser-check.mjs`; `scripts/calm-return-browser-check.mjs`.

## Initial priorities

| Priority | Observed fact | Hypothesis to test | Small candidate change |
| --- | --- | --- | --- |
| 1 | Results lives inside Settings; the scripted newcomer journey opens Settings to find their outcome. | People will look in the conversation or room navigation for useful output, not configuration. | A Results destination near the conversation, with the latest result linking directly to its evidence. Preserve advanced details. |
| 1 | Add agent shows ten named choices, a paragraph about packet/invite/MCP routes, and “The browser sends only a digest.” | People may think choosing a brand starts an agent, or abandon before setup. | Lead with the agent they already use; show only verified connection paths, a short permission summary, and one next action. Put implementation language in details. |
| 1 | Enrollment and starting a model are distinct; existing UI explicitly says addressing does not start a model. | “Connected” may be confused with “available and working.” | Distinguish access granted, connected, request received, working, needs input and finished using confirmed runtime signals. Never simulate availability. |
| 2 | Contributing in the fixture requires offering help, owner selection, sharing a draft, then owner completion. | The formal path may be excessive for a small conversational request. | Compare a lightweight draft request with the formal work path; retain explicit authority for consequential actions. |
| 2 | Catch up has personal attention, frozen history and recovery behavior; fixture checks pass. | People may still misunderstand read versus resolved, or lose a pending review. | Test comprehension before changing badge counts or adding more notification UI. |

The first design priority is access to useful work, then easier delegation. Do not start another broad visual overhaul before these journeys are observed.

## Research and implications

These are product patterns and our inferences, not proof that the same design succeeds here.

- [Slack channels](https://slack.com/help/articles/1500000019361-Keep-work-organized-with-channels) put conversation and shared reference together. Implication: keep outcomes easy to reach from their room and discussion.
- [Discord onboarding](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ) personalizes relevant channels using short questions and allows later changes. Implication: ask only questions that change the immediate experience; invited reviewers should reach the requested work promptly.
- [Linear agent guidelines](https://linear.app/developers/aig) emphasize recognizable agent identity, unobtrusive acknowledgment, visible status, disengagement and human responsibility. Implication: agent power should use familiar room interactions with explicit control. Show action summaries and evidence, not private model reasoning.
- [Microsoft human–AI guidelines](https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/) address clear capabilities, contextual information and correction/dismissal. Implication: test mistaken expectations and recovery as carefully as successful output.
- [NN/g task scenarios](https://www.nngroup.com/articles/task-scenarios-usability-testing/) supports realistic goals without teaching control names. [Sample-size guidance](https://www.nngroup.com/articles/how-many-test-users/) supports small formative rounds. Five is a starting point per distinct group, not statistical validation.

Enjoyment hypothesis: useful progress, fast acknowledgment, lightweight appreciation and feeling in control will make this pleasant to return to. Test these directly. Do not assume points, streaks, extra animations or more agent messages create value.

## Recruitment and session protocol

Start with five people who collaborate on small projects, including newcomers to agent tools, plus three to five agent builders/operators as a separate formative group. Include an invited reviewer, an owner and phone use. John can pilot the script, but founder familiarity must be recorded and cannot substitute for newcomers.

30-minute moderated sessions: 5 minutes recent real workflow, 20 minutes tasks, 5 minutes reflection. Use a disposable room and fictional launch brief, draft, pending review and background updates. Reset between sessions; no private email or production task changes. Get consent before recording. If no recording, use anonymous session IDs and notes.

Opening questions: Tell me about the last time you worked with another person and an AI on a real task. What did you move between tools? Where did work get stuck? What did you have to check yourself?

Say: “We are testing the product. Please say what you expect as you go. You can stop at any time.” Avoid demonstrating the interface first. Record hints separately; after a participant is stuck, ask what they expected before helping.

Neutral tasks, delivered one at a time:

1. You have been invited to help prepare a launch. Find what the team wants your help with and ask the person responsible a question.
2. Get your usual AI assistant to draft a short welcome message from the supplied brief. Tell us what you think it can see and do. If no live agent is available, record the blocker; do not pretend a fixture is a working AI.
3. The welcome must now be under 60 words. Change the request. Then stop further work and explain how you know it stopped.
4. A draft is ready. Decide whether it meets the brief, find what supports it and ask for a change if needed.
5. You have been away. Find what needs your decision now and the latest usable result without reading the entire conversation.

For agent operators, additionally test enrollment from the documented path, narrow context retrieval, one bounded contribution, ambiguous instruction/clarification, stale revision, retry, expired access and revocation. Measure setup interventions, tool errors, duplicate actions, context retrieved and whether the human sees a trustworthy state. Run actual model trials separately and record model/version; protocol fixtures are not model trials.

Ask after each task: How easy or difficult was that (1–7)? What surprised you? At the end: What felt satisfying or frustrating? Which real task would you use this for this week? What would you use instead? Avoid asking whether they “like our design.”

## Decision and follow-up

Record task completion without help, hints, wrong destination, backtracking, critical misunderstanding, time to first usable result, perceived ease and verbatim comments with permission. Timing in think-aloud sessions is diagnostic, not a performance benchmark. Never count message volume as value.

Fix any observed permission, recipient or false-stop misunderstanding immediately before broader trials. Repeated confusion across two participants prioritizes a small revision; one severe blocker also warrants action. Compare revised tasks with fresh participants or alternate task content, recording learning effects. Do not claim significance from a small sample.

Then invite consenting testers to use one real, bounded project for a week. At follow-up ask whether they returned voluntarily, produced an accepted result, reduced handoff effort, and what they used instead. This checks value beyond first-session novelty. No follow-up automation or outreach is enabled by this document.

## Blank observation record

Session ID / cohort / familiarity / device / baseline version / consent:
Task / expected outcome / observed path / completion unassisted-assisted-failed:
Time / hints / wrong actions / ease 1–7 / quote or paraphrase clearly marked:
Issue severity / evidence reference / hypothesis supported or challenged:
Next change / owner / retest result:

Participant count: 0. Do not fill this record with synthetic feedback.
