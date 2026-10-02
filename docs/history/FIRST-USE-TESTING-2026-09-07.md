# First-use testing checkpoint

September 7, 2026. This is agent-operated usability inspection and browser
regression testing, **not a study with human participants**. No people have been
recruited or contacted. Human completion rates, satisfaction and time savings are
unknown.

## What changed

- Conversation and the account header use readable names. Duplicate names retain
  exact IDs; full identity remains in member details, assignment/evidence controls
  and the header tooltip. Sign-out clears the tooltip too.
- Guests no longer see creation buttons they cannot use. The empty work area tells
  them they can suggest work in conversation; owners can turn a message into work.
- A source message supplies an editable work title. Cancelling clears the source
  and title. Truncation respects the field limit without splitting an emoji.
- If the chosen assignee leaves no eligible independent reviewer, an inline
  explanation opens the existing review settings and focuses the checkbox.
  Review is never silently disabled. Evidence and the default owner-approval
  requirement stay intact; external-action permissions are unchanged.
- The mobile header and conversation height leave the composer visible on a
  fresh 390 × 844 guest visit. Keyboard sending, touch Return/newline, draft retry
  and enlarged-text behavior remain explicit regression cases.
- The skip link stays visually hidden until focused. A normal signed-out visit
  no longer looks like an error or says session checking is still underway.

These are changes to the existing flow, not new product sections, onboarding tours,
analytics, agent execution, payments, or a second app. The Sites guidance informed
the bounded scope and progressive disclosure; the existing Cloudflare architecture
and deployment destination are preserved.

## Agent-operated checks

Final local candidate: 196 core/API tests, 39 browser scenarios, and 6
Cloudflare storage/HTTP/browser checks pass. The first full browser run caught
an obsolete header-label expectation; the revised test still checks the exact
duplicate-name IDs and the full identity tooltip. Subsequent full runs pass.

`scripts/first-use-check.mjs` starts a fresh room with only its owner, creates an
invite through the UI, and joins in a separate guest browser. Both desktop and
touch journeys cover suggestion → source-linked work → explicit review choice →
owner accepts/starts → guest sees progress. They also check duplicate names,
permission-limited controls, source cancellation, reviewer availability changing,
emoji truncation, 200% text, and no browser exceptions.

Screenshots in `test-results/first-use-{desktop,touch}-{guest,work,review-choice}.png`
were inspected. Capture can reset Chromium touch emulation, so touch Return is
asserted before screenshots; a screenshot's keyboard hint is not device proof.
The local fixture data and generated credentials are disposable and private.

`cloudflare/hosted-check.mjs --work` repeats the key suggestion-to-work steps on
our real HTTPS staging service. It labels records as synthetic tests; recording
work starting is not evidence that an agent executed a task. `--return` checks
the privately saved guest session; `--invite-user` creates a separate invitation
for voluntary human testing and saves it privately, never to source control.

Hosted verification passed for source `0e20615` on September 7, 2026 at
https://project-room-staging.getdasha.workers.dev. Existing guest identity/messages
survived the update. Real HTTPS guest-to-work acceptance passed, including explicit
review choice, owner accepting/starting, and the guest seeing progress. Current
Worker version: `5b052420-ec55-4fe3-8a35-7f0ac1347bcb`. Hosted desktop/mobile/return
screenshots are in `cloudflare/test-results/` and were inspected. No DNS or
main-website changes were made.

## Five-minute human test

Use an unused guest invitation. Tell the participant the room contains synthetic
test records, that other room members can read their messages, and to avoid private
information. Ask permission before taking screenshots or recording their words.

Give tasks without pointing to controls:

1. Join on your phone and suggest one small piece of work in a message.
2. As owner, turn that suggestion into work you are responsible for. Say what
   finished means. Explain the review choice you made.
3. As guest, find who is responsible and whether the work is finished. Reload
   once and check that you can still find your message.

After each task ask: “What did you expect to happen?” At the end ask:
“What felt confusing or unnecessary?” Avoid coaching until they request help.

Record manually: device/browser; completed or not; assistance needed; point of
hesitation; participant's own explanation of guest access and work status; exact
feedback with consent. Do not invent numbers from automated timing. A small first
round identifies problems; it cannot establish broad usability or product demand.

## Still open

Physical-phone keyboard/scroll behavior; human comprehension of review and
reported progress; guest recovery after eight hours/sign-out; final trydemigod.com
integration; provider restore exercise and budget alerts. Staging remains an
operator/user-test pilot, not a production-readiness certification.
