# Share a draft, then review it

Local implementation following `bd42189`. The broader product goal remains active.
This checkpoint does not change a running preview or the live site.

## One contribution flow

Selected helpers see **Share draft** beside their existing help controls. The same
action is available in task **Details** without requiring an offer. It accepts
plain text; no AI tool, copied prompt or return marker is necessary.

The contribution posts as an existing work-linked chat message. An accountable
member can adopt its exact stored text as a result, explicitly credit a producer,
request the existing independent review and record a human decision. There is no
new task, result, execution or payment model.

Desktop Enter posts; mobile Enter inserts a newline. The existing **Use my AI**
and **Paste AI draft** routes remain available and keep separate private drafts.
Closing/reopening preserves text and its original task revision. Reload/sign-out
clears unsent private drafts; the dialog states that limitation.

## Boundaries

- An authenticated posting identity does not prove who produced the text.
  Existing unverified attribution remains; producer is not selected automatically.
- Sharing changes no work status, assignment, selected offer, review or decision.
  A selected helper remains reserved until explicitly released.
- A draft is linked to a task, not bound to a particular help-offer revision.
  It is not evidence of offer fulfillment or permission to execute.
- Changed work requires explicit older-draft consent. This uses the existing
  older-basis contract, not a new exact-current-revision authorization.
- Lost-save recovery keeps the exact original command through close/reopen and
  subsequent work changes. Retrying confirms one message, not a duplicate.
- Raw text is limited to 4,000 characters and rendered as text. No provider,
  network execution, credentials or new API surface is introduced.

## Verification

Working-tree checks: **683 core tests**, **4 native-draft browser journeys** and
**2 existing portable-return browser journeys** passed.

The new browser checks cover desktop/mobile selected-helper entry, exact stored
text adoption, explicit producer choice, a separately credentialed scripted MCP
reviewer, explicit human approval, independent chat drafts, distinct manual-return
drafts, retained original basis and immutable retry after a lost response.
Offer and selection setup in this suite is arranged through the service; the
preceding human-offer browser suite tests those controls.

Desktop adoption, mobile composition and mobile decision screenshots were
visually inspected. Browser people are simulated; the MCP reviewer is scripted,
not an independently reasoning model. These checks do not demonstrate human
delight, retention, native vendor-host compatibility or production readiness.

Temporary evidence: `/tmp/project-room-native-drafts.g8UL3C`. Retained committed
evidence belongs under `test-results/native-drafts-<commit>/`, with a manifest
distinguishing pre-commit and committed checks.

## Next coherent slice

Review how selected helpers discover that their contribution was adopted or
needs revision, while preserving alternatives and requiring explicit release.
Do not silently equate an approved task result with fulfillment of every offer.
Then reconnect this journey to private context and the existing reply workflow.
