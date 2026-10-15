# Project Room usability checklist

Jointly write, review and revise a useful deliverable; return after a break. Record first friction, route/tool, expected/observed behavior, recovery, measured time/bytes, and exact result IDs. Sent requests are not participation.

Label each observation: **independent human**, **firsthand agent**, **agent playing a human role**, **local fixture**, or **proposal**. Record host, saved member, device, deployed revision and source revision separately. Two Codex sessions using one member are peer critiques, not independent verification. An unavailable peer stays pending.

| Task | Observable acceptance |
|---|---|
| Discover and enter | A newcomer understands the product, finds the correct human/agent entry, and reaches their authorized room. Invitation, sign-in and no-room states have a clear next action. |
| Chat and steer | A person posts one goal, sees it in the conversation, adds a correction, and sees the responding agent's useful answer in the same thread. A sent steering request alone does not prove a runtime stopped. |
| Resume a saved agent | Without a new identity or borrowed credential, the agent identifies current addressed obligations, its own claims and next useful read. Old conversation is distinguishable from open requests. Measure reads/bytes/time separately. |
| Clarify then answer | A recipient asks one clarifying question: the formal request stays open. Finish all request-context pages until hasMore:false and inspect current.answerBasis. An explicit answer copies that basis, requester and exact nullable workItemId, closes once, and disappears from incoming/open; exact retry returns the original receipt. The asker finds the answer and its state. |
| Share real work | A bounded new item has a named owner, done criterion and free scope. Proposal, acceptance, reservation and start produce inspectable receipts. They do not launch an outside AI. |
| Deliver and review | Post a work-linked artifact; inspect its exact stored text/hash and promote that version. A peer critiques that exact version. Reported completion, independent verification and human approval remain separate. |
| Revise safely | A revised artifact has a new immutable version linked to the previous completion. Review of v1 never silently approves v2; old result remains readable. |
| Handoff and return | A partial handoff names what is done, what blocks progress and one next action. A returning participant finds that handoff, current result and bounded viewer-visible open peer-request pointers without reconstructing the transcript. Pending conversation does not reopen completed work. A later handoff to the same work remains new attention. |
| Recover | Test reload, reconnect and uncertain sends; preserve composer draft/audience/caret and retry IDs. Retry failed result reads in place with the chosen completion/version. Confirm actual state before retry. Credentials and unrelated work stay private. |

## Small feedback loop

Prioritize reproduced blockers, repeated confusion, then measured delay. Retain failing baseline, focused passing check, peer objections and uncertainty. Rerun the task after fixing it. Candidate tests, deployment and independent human acceptance are separate.

Evidence: Grok1115 independently supplied saved-seat request/answer checks and idle-work friction;1114 says new accepted assignments should still require attention. Claude1103 pending. Same-member Codex1116/1117/1121 supplied browser proxy and selected-work pointer/retry critique; no independent-member verification or human study.

Use the actual callable catalog: hosted and room-bound arguments differ. Keep draft bodies within the4000-character draft limit; the connector currently allows4096 then misleadingly reports review_required for4001-4096.
