# Focused collaboration: design and implementation plan

## Decision to make
Find the smallest understandable interface through which a person can join, express an objective, collaborate with another person and an agent, leave, return, review a result and request a revision. Compare conversation-centered, work-centered and artifact-centered layouts before committing to one. “Focused task” is a preference, not proof. Existing capabilities and previous effort do not guarantee a place in the normal interface.

## Constraints and invariants
- Chat remains a supported entry path; a person need not create a formal task first.
- Audience, author and permission remain explicit. Inferred intent is not authorization.
- Joining a room, connecting an agent and executing a job are separate states.
- Humans retain authorship of their messages. A later contribution cannot silently rewrite the original request.
- One state owner per concept. Layouts must not introduce alternate task stores or authentication logic.
- Interrupted delivery retains the same operation identity. Retrying must not duplicate work.
- Results remain inspectable; revisions preserve earlier versions.
- No new live account, room message or permission is needed to evaluate a prototype.
- Simulated journeys establish transition and layout behavior, not real-human comprehension or productivity.

## Stage 1 — Preserve and repair the existing candidate
1. Read claims, branch status and hosted results for PR4243. Keep the earlier entry work reviewable independently.
2. Fix CI failures by root cause: register docs in the index; route old browser navigation helpers to the current Rooms control; retain one default form-submit action while making email-link selection explicit; make unavailable-provider expectations match fixture configuration.
3. Review changed visual baselines and update only intentionally changed surfaces. Do not increase pixel tolerances or change existing receipt-hash expectations.
4. Record the full local run and subsequent repair checks. Publish the repair checkpoint; hosted unit results take precedence over hypotheses about local-only failures.

## Stage 2 — Build comparable interactive alternatives
Use one synthetic scenario and one underlying state model for all three layouts:
1. An invited person joins a room without manually re-entering its destination.
2. They ask for a launch brief in ordinary language, with the room audience visible.
3. A teammate adds a requirement as an attributed contribution.
4. An agent is unavailable. The UI offers connection/retry without pretending the task ran.
5. Once connected, work progresses; a failed attempt can retry the same request.
6. The person leaves and returns. The view identifies current work and the pending review.
7. The result opens as readable content, with version and author.
8. A revision request creates new work without destroying the prior result.

Alternatives:
- Conversation: chat is primary; selected work/result expands beside it.
- Work: objective and current state lead; discussion supports the active work.
- Artifact: the result leads; its discussion and revision request sit alongside it.

All alternatives use the same state transitions. Design controls can select difficult states directly for review. Real controls must work; absent backend actions are clearly simulated. No fabricated usability scores. Show the same authors, audience, result and failure semantics in every layout. Support keyboard, narrow width and both themes.

## Stage 3 — Compare and select a bounded implementation
For each variant inspect: first useful action; audience understanding; clarity of next actor; finding a result after returning; revision behavior; unavailable agent; failed work; preserved draft; mobile ordering; focus stability. Record observations separately from hypotheses.

Selection rule: choose the least complicated layout that supports the whole scenario. A task-first approach must justify its added setup. An artifact-first approach must handle the period before a result exists. A conversation-first approach must provide a durable way to find the result without rereading the transcript. Reuse the existing result reader and work model before inventing new objects.

## Stage 4 — Apply low-risk, well-supported improvements to the app
1. Consolidate informational owner notices behind a disclosure while keeping decisions, warnings and errors visible. Do not discard information or suppress action-required failures.
2. Make assistant configuration contextual: ordinary conversation should not permanently advertise a disconnected service. Keep access to configuration discoverable through Ask Room; retain active work, questions, errors and recovery. Selecting an ask must immediately reveal the relevant state. Do not alter routing or execution authority.
3. Retain the existing shared conversation, work controls and result reader. Use prototype findings to specify larger pane/navigation changes precisely rather than shipping three competing layouts.
4. Verify selected changes with behavioral browser checks: ordinary conversation, explicit ask, cancellation back to conversation, active work, no host, error/retry, keyboard and narrow windows. Keep exact role/session ownership checks.
5. Publish an independently reviewable implementation with evidence and explicit remaining work. Do not call it deployed before production verification.

## Architecture boundaries
Human presentation: selection, disclosure, focus, readable statuses and accessible controls.
Shared domain: room membership, audience, objective, attributed contributions, operation identity, work state and result revisions.
Agent interface: existing identity reuse, structured admission/scope, precise errors, idempotent actions and bounded context. The prototype does not replace the existing agent API.

Inspect current controllers for duplicated ownership before extracting anything. Extract a small pure visibility/state selector when it makes transition behavior testable. Do not introduce a framework migration, new database or synchronization system for a layout experiment.

## Measurement plan
Capture actual completion, wrong turns, recovery steps, action discoverability, time to first contribution and time to result review in future human sessions. For automated checks measure successful transitions, duplicate-operation count, preserved drafts, target reachability, overflow and runtime errors. Keep synthetic measures separate from human outcomes; do not infer productivity gains from passing tests.

Proposed acceptance: no hidden recovery for a failed ask; no claimed execution without a connected executor; no additional setup before ordinary chat; previous result survives revision; every consequential action names its audience/context; no horizontal overflow at 390px; common controls remain keyboard reachable. These are acceptance criteria, not achieved measurements.

## Explicit exclusions and remaining work
No public notarized Mac distribution (deferred by John), new scheduling/automation, live shared-room testing, authentication-provider enrollment, storage rewrite or new permissions. Real-provider, physical-device and real-human qualification remains separate. Email-first unified signup, New room simplification and full account settings redesign remain tracked from the entry plan. Prototype layout selection is reversible and does not justify dropping those tasks.

## Research basis
- Design Council, Framework for Innovation: https://www.designcouncil.org.uk/resources/framework-for-innovation/
- Basecamp, Find the Elements: https://basecamp.com/shapeup/1.3-chapter-04
- Nielsen Norman Group, Progressive Disclosure: https://www.nngroup.com/articles/progressive-disclosure/
- Microsoft Research, Human-AI Interaction Guidelines: https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
- Google PAIR, Mental Models: https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/
- Linear, A calmer interface for a product in motion (March 2026): https://linear.app/now/behind-the-latest-design-refresh

These sources motivate methods and hypotheses; none proves this design improves Project Room productivity.

## Executed comparison and implementation

Three interactive alternatives were built using one synthetic room state. Each completed the same automated journey: join, submit a request, encounter an unavailable agent, connect, receive an attributed teammate contribution, stop/fail, retry, return, open the result, request a revision, preserve version 1 during work, receive version 2 and mark it reviewed. No live room actions occurred. Narrow-width overflow and browser runtime errors were checked. These are transition checks, not usability scores.

Observed structural differences:
- Conversation starts without task setup and can reveal a result beside the discussion. Its risk is losing results in a long timeline, so a durable work/result destination remains necessary.
- Focused work gives the objective and next actor priority, but repeats the originating request and consumes space before discussion.
- Artifact is useful during review but has no primary content before delivery and pushes the conversation further down on a phone. A failed revision must remain visible even while the previous result is readable; the prototype was corrected for that case.

Decision: keep conversation as home, with focused work/result views available on demand. This is a provisional design judgment; no measured productivity advantage is claimed. Do not ship three competing navigation modes. The existing result reader already owns exact stored text, stale-response fencing, earlier-result labeling and discussion navigation, so it is retained. A full side-pane replacement remains a follow-up requiring integration with those behaviors.

Applied app changes:
- An unconfigured assistant no longer occupies normal chat. Ask Room reveals connection controls immediately; cancelling the empty ask hides them again. Configured assistants, existing runs, pending operations and errors remain visible. This deliberately does not yet hide every idle configured assistant.
- Informational owner notices move behind Room notes. Decisions, warnings and room-read failures stay visible. Disclosure state survives refresh; its accessible name matches its content.
- The preceding entry PR was repaired: single default form submission plus explicit validated email-link action; current Rooms navigation in browser helpers; correct unavailable-provider fixture expectation; docs index registration; reviewed intentional visual baseline changes.

Evidence at this checkpoint: 43 human/agent browser scenarios passed; eight entry/layout cases passed; 2,272 affected tests passed; lint completed with zero errors and 291 existing warnings; docs/i18n checks passed. Visual baselines were reviewed without increasing tolerances. Full-suite/hosted qualification is recorded separately on the PR. No production or native-app deployment is claimed.

Local interactive study and screenshots: `/Users/johnpotter/Documents/ChatGPT/project room/outputs/focused-collaboration-20261019/`. Editable conversation study: `/Users/johnpotter/.codex/visualizations/2026/10/18/01a14d27-1aea-72c1-8594-0c2198da7b4d/focused-collaboration.html`.

## Next implementation boundary
The next substantial change is the optional work/result pane, not another top-level dashboard: preserve the current reader controller and result identity, mount it beside chat on wide screens and as a focused destination on phones, retain draft and scroll position, restore focus when closed, preserve exact-text errors/retry, and show earlier revisions explicitly. Compare that implementation to the existing inline reader before replacing it. Unified signup, account settings and New room simplification remain outstanding rather than silently folded into this patch.
