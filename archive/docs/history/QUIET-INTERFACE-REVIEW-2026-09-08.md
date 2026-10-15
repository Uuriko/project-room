# Project Room: less reading, clearer action

## Direction

The interface should reveal the next useful action, not explain every capability. Use proximity, hierarchy and familiar controls to show relationships. Keep language when a person needs it to choose safely. This is a usability goal, not a word-count contest.

Scope: reviewed the product's current HTML surfaces and the UI-producing code in app, sharing, agent connections, portable work/results, reminders, room instructions, catch-up and work state/action helpers. This is an interface audit, not a claim that every server diagnostic, document, or possible state has been rewritten. User messages, room instructions, results and other authored content are never shortened automatically.

The user added this pass while the ask–clarify–deliver implementation was in progress. That work is retained separately and remains incomplete. This pass does not qualify a release or finish the overall goal.

## Research and decisions

- Apple’s [small writing changes](https://developer.apple.com/videos/play/wwdc2025/404/) recommends removing filler and repetition and keeping a consistent vocabulary. Applied here: remove the third explanation of being signed out, shorten instructions that repeat the adjacent control, and retain established task names.
- [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) separates common actions from infrequent options; the route to options still needs to be discoverable. Applied here: one access-help disclosure, secondary keyboard help in Options, existing review/permissions summaries retained. Avoid nesting several “More” panels.
- [Icon usability](https://www.nngroup.com/articles/icon-usability/) cautions that most symbols are not universally understood. Decision: retain labels for Connect agent, Retry original, Review and Approve. Familiar send/refresh controls can stay icon-only with accessible names; do not invent a glyph for a request, bounty or permission.
- W3C’s [labels and instructions](https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html) distinguishes visible labels from accessible names. Decision: the key field keeps a visible label; a placeholder or hidden name alone is not a replacement. Errors and consequential instructions remain available beside the relevant action.
- Apple’s [design principles talk](https://developer.apple.com/videos/play/wwdc2026/250/) combines concise language, hierarchy and clear affordances. Our inference: simpler layout can remove the need for a paragraph, but adding a short contextual label can also make an interface simpler.

These are design guidelines, not proof of improved Project Room conversion or retention. Validation here is automated browser testing and visual inspection, not observed human behavior.

## Screen-by-screen review

| Surface | Decision | Status |
| --- | --- | --- |
| Member login | Keep heading, labeled key, entry button, one Need access? disclosure. Remove repeated signed-out chrome. | Implemented |
| Account login | Room name is the heading; Account key is the label. Initial signed-out arrival is not an error. Membership help is secondary. | Implemented |
| Login service failure | Keep a short error, visible connection state and refresh action. Never hide a real outage with normal signed-out chrome. | Implemented and checked |
| Access lost / sign-out | Keep draft-clearing and uncertain-session information. Remove the redundant instruction to enter a key. These states are not the same as an ordinary first visit. | Shortened; consequences retained |
| Successful login | The room opening, identity and connection status are the feedback. Remove the additional welcome toast. | Implemented |
| Conversation | Keep messages as the visual focus. Move keyboard instructions to Options, preserving accessible descriptions and Enter behavior. | Implemented |
| Composer audience | Preserve that room messages are shared and addressing an agent does not start it or grant access. Shorten the explanation. | Implemented |
| Thread / reply navigation | Keep the parent content and Reply label; do not replace navigation with unfamiliar symbols. | Retained |
| Search | Keep familiar search input, result context and empty state. Do not add a search tutorial. | Retained |
| Catch me up | Keep Needs you before history, next action and affected work together. Counts summarize; optional history carries detail. | Retained |
| Catch-up acknowledgement | Keep that marking read does not close work. Sequence numbers are technical evidence, not a headline. | Retained; further placement review |
| Work list | Title, owner, state and next action remain the scan targets; detailed records stay in existing disclosure. | Retained |
| New work | Use Outcome, Done when, Owner and Reviewer as instructions. Shorten missing-reviewer explanation; do not silently weaken review defaults. | Implemented |
| Review & permissions | Keep a summary of chosen defaults while closed. Labels must distinguish read-only work from external-write authority. | Retained |
| Review / approval dialog | Keep exact evidence, acting identity, result and consequences. Never use a generic checkmark for both review and approval. | Retained |
| Room instructions | Keep section headings and the actual content. Shorten the boundary to Guidance, not permission. | Implemented |
| Invite people | Preserve anyone-with-link access before creation. Shorten local-only warning and link lifecycle instructions. | Implemented |
| Invitation link management | Explain cancellation affects future joins, not existing members, in one short statement. | Implemented |
| Targeted invitation | Remove the redundant eyebrow and pending summary that repeat the heading and structured membership details. Shorten account-key and identity-switch instructions. | Implemented |
| Guest join | Keep name, scope and Join room visible. Shorten time/session limits while keeping cookie/sign-out consequences. | Implemented |
| Invitation errors | Preserve unknown acceptance, retry ownership, account mismatch and expired/revoked distinctions. Do not turn uncertainty into success/failure shorthand. | Retained |
| Connect agent | Keep Name plus Create access; access/expiry is already secondary. Preserve the visible scope and the distinction between access issued and agent running. | Retained |
| Agent setup | Private setup remains deliberately revealed. Platform instructions stay opt-in; do not replace real setup steps with an unimplemented Connect button. | Retained |
| Use my AI | Let the prompt preview, Copy and Paste AI draft show the handoff. Keep sharing/privacy and no-execution boundaries. | Retained |
| Paste AI draft | Shorten explanation while preserving public-to-room posting, unchanged work status and draft loss on reload/sign-out. | Implemented |
| Copy summary | Editable preview does the explaining. Keep private-detail warning and distinguish copying from publication/approval. | Retained |
| Reminders | Time picker plus its concrete preview communicate when. Preserve private/in-app-only delivery scope. | Minor copy reduction |
| Save/retry/conflict recovery | Keep what may have happened, what is preserved, and the next safe action. Never replace this with Oops or a red icon alone. | Retained |
| Activity / technical records | Keep exact evidence in the existing collapsed section. Diagnostic detail is useful after a question, not on entry. | Retained |
| Bounties / payments / hosted automation | Do not add promotional copy or controls for roadmap capabilities not implemented here. Future money actions require explicit amounts and consequences. | Future design constraint |
| Agent API / MCP / copied prompts | Preserve precise fields, scope, revision and retry semantics. Less visual text does not mean a less explicit machine contract. | Unchanged |

## A vocabulary to keep consistent

| Use | Meaning / avoid conflating |
| --- | --- |
| Room | Shared context, not a private direct message |
| Work | A tracked outcome; do not alternate casually with job, mission and bounty |
| Draft | Not a completed or approved result |
| Review | An independent assessment, not the owner's final approval |
| Approve | The explicit approval action, never a generic success icon |
| Connected | A checked transport/session state, not evidence the AI is working |
| Retry original | Check/finish the same uncertain operation, not create a new one |
| Copy | Clipboard only; not publish or send |
| Member key / Account key | Different access modes; keep the distinction |

## Next layout work, in order

1. Finish the request composer using one contextual mode strip, not a second messaging form or tutorial. Reveal answer/decline actions only on an actual request.
2. Remove remaining duplicate invitation feedback across summary, field help and live status without losing a single accessible announcement owner. Error-state wording needs state-by-state tests before further changes.
3. Review the work card at realistic volume: show one next action, keep proof and history in Details, preserve exact actor/result attribution in review.
4. Replace setup prose only when a real platform-specific setup action can do the work. Show read access, authenticated identity and actual activity as different states.
5. Review catch-up technical sequence text for a details placement that still makes stale-data boundaries understandable.
6. Assess copy/review/reminder dialogs with long user content and duplicate member names. Compact labels must not conceal identity or truncate the action's subject.
7. Consider disclosure wording by task, e.g. Access & expiry, instead of proliferating generic More buttons.
8. Observe actual first-time humans when available: can they enter, send, invite, find the next action, connect an agent and recover from failure without a walkthrough? Do not substitute automated screenshots for this evidence.

## Acceptance checks

- Member and account entry retain visible labels, keyboard submission and contextual help.
- Normal signed-out arrival and refresh do not produce a red error.
- The skip link focuses login's heading when signed out and connection status when signed in.
- Invalid credentials and real connection failures stay visible; no duplicate global login alert.
- A successful sign-in restores identity and connection chrome.
- Desktop and 320px layouts reflow, including 200% text and expanded help.
- The invite scope and local-only limitation stay visible before sharing.
- Existing Enter/Shift+Enter, touch, invitation, permissions and retry tests still pass.
- Screenshots contain only synthetic room data and empty credential fields.

Verification: 510 core/API/package checks passed; the complete browser run passed
162 checks. A final focused rerun passed 15 checks covering login, accessibility
and session boundaries after the last feedback/spacing edits. Initial failures
were an old wording assertion and an unscoped test locator matching a hidden
invitation field; both were corrected without weakening the behavior checks.

Inspected local screenshots in `test-results/`: `login-copy-before.png`,
`login-copy-after.png`, `quiet-copy-narrow-login.png`,
`quiet-copy-desktop-room.png`, `quiet-copy-narrow-invite.png`,
`quiet-copy-service-error.png`, and `quiet-copy-narrow-large-text.png`.
The large-text review prompted a narrower padding rule; final capture was inspected.
These ignored local artifacts contain synthetic data, not evidence from human testers.

The follow-up [product design plan](QUIET-PRODUCT-DESIGN-PLAN-2026-09-08.md)
adds research, implementation stages, concrete screen changes and acceptance gates.
No deployment was performed or authorized by this review.
