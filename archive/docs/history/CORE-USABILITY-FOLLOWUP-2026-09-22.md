# Core usability follow-up — 2026-09-22

Inbox/unified messaging expansion remains shelved at John's request. Existing native conversations and stored data remain intact; no connector work is included. Google verification reminder created for tomorrow, September 23, at 10 a.m. Pacific, once. Reminder does not resume development.

## Completed

Reviewed current primary documentation for [Slack channel tabs](https://slack.com/help/articles/32562841868307-Add-and-manage-tabs-in-channels-and-direct-messages), [Linear Peek](https://linear.app/docs/peek), and [Discord forwarding](https://support.discord.com/hc/en-us/articles/24640649961367-Message-Forwarding).

Patterns to test: Slack keeps shared resources close to discussion; Linear supports inspecting work without a full navigation change; Discord documents that forwarding produces a copy rather than a live original. Our inference: make useful work easy to open, preserve context when closing it, and make source/version boundaries clear. These vendor patterns do not validate Project Room's usability.

Simplified Add agent's introductory paragraph and replaced the digest implementation note with the next action. Access controls, capability explanations, private setup protections and all existing routes are preserved. Visual inspection confirms the shorter desktop dialog; functionality remains available. This is a small local copy change, not a deployment or a redesign of the agent catalog.

39/39 focused browser checks passed covering agent connection, pause, result reading/recovery, draft return and deleted messages. Changed JavaScript lint and whitespace checks passed. Log: core-usability-evidence-20260922/followup-browser.log. Screenshots: add-agent-followup.png.

A suspected Results shortcut scroll problem was explicitly checked on a phone fixture and did not reproduce. No speculative fix was applied; the exploratory check was not retained as a redundant test.

## Confirmed issue, still open

Re-ran codex-burst-reproduction.mjs from the design-convergence directory against current server code. One unread mention remains present after 499 later routine messages. At 500 later messages the notification feed returns unread=0 and mentionPresent=false, with basis.truncated=true; same at 600. This is the existing bounded-tail issue, freshly reproduced, not a newly introduced regression. The response reports incompleteness; do not describe it as complete coverage or infer the entire UI says all caught up.

Priority: durable attention retrieval/pagination with permission and read-state checks. Do not simply increase 500 to another arbitrary cap. Preserve separate concepts of unread events and unresolved obligations. Add a regression proving an older unread mention remains reachable after a burst before implementing the eventual fix. This needs a focused data-path change, not more badges.

## Next experiments

1. Results beside the conversation: can newcomers find the latest useful output without knowing it is currently inside Settings?
2. Agent setup: compare the current catalog with a smaller initial choice set and additional options in a disclosure. Verify actual supported connection routes; a brand card alone does not mean a running integration.
3. Agent control: can someone tell a request was received, distinguish working from disconnected, ask a question, and confirm a stop?
4. Value and enjoyment: measure whether people achieve a useful result and voluntarily reuse the room. Ask what felt satisfying or frustrating. More agent chatter and time in-app are not success measures.

No real participant sessions occurred. Study recruitment remains unresolved; do not represent scripted journeys as human feedback. The neutral session protocol is in CORE-USABILITY-STUDY-2026-09-22.md. John can pilot it, but unfamiliar participants are needed to assess discoverability.
