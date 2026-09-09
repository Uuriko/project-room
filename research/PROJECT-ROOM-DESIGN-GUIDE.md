# Project Room: design for low effort

September 8, 2026 · General UI/UX research and proposed design practice

## Purpose and evidence

Great design should make a capable product feel understandable, responsive and worth returning to. The target is low effort, not the smallest possible number of pixels or words.

This guide supports the [unified blueprint](PROJECT-ROOM-BLUEPRINT.md), which remains the roadmap. It extends the existing quiet-product plan with general design craft and an evaluation process. It does not claim the current application has been audited, redesigned or user-tested in this research pass.

Sources below include practitioner frameworks, design-system guidance, accessibility standards and browser-performance documentation. They are not interchangeable evidence: a standard specifies requirements; a heuristic suggests where to investigate; a design example is not proof of improved retention. Project Room proposals are our synthesis and need testing.

## 1. Simplicity is a relationship, not an aesthetic

Apple's recent design-principles session explicitly distinguishes simplicity from minimalism. Its broader argument connects purpose, user agency, familiarity, responsibility and craft: removing visible controls can make a product harder, not easier. [Apple: Principles of great design](https://developer.apple.com/videos/play/wwdc2026/250/).

For us, three forms of simplicity matter:

- Understanding: I know what this place is and what I can do.
- Acting: I can do the ordinary thing without preparation or explanation.
- Recovering: I can tell what happened and fix a mistake.

A blank screen with an unexplained symbol may satisfy none of these. A short list with clear labels may satisfy all three. Avoid treating click count, word count or whitespace as the goal by themselves.

Proposed rule: remove an element only after identifying how its information or function remains available when needed. Remove redundant reassurance; keep recipient, access boundary, material cost and irreversible consequence.

## 2. Structure before styling

Apple's foundations session moves from information structure to navigation, content and visual design. Its worked example separates destinations from actions, uses lists for text-heavy content and establishes orientation before decoration. It also demonstrates semantic colors and adaptable text styles. [Apple: Design foundations](https://developer.apple.com/videos/play/wwdc2025/359/).

Our application:

- Inbox and Rooms are places. Ask, Share and Connect are actions inside a relevant place.
- A selected conversation should not lose its identity when a work item opens beside it.
- Do not give every backend capability a navigation item.
- Reuse the same work record across conversation, review and optional board views.
- Show optional capabilities in a stable location; let users pin them. Never make important tools appear only after an arbitrary number of visits.

Before drawing a new screen, write one sentence describing the user's immediate intention. If it contains five unrelated intentions, divide the flow before choosing fonts.

## 3. Build hierarchy with relationships

Proposed visual approach: distinguish content by importance and grouping, not by putting every object in a decorated card.

Use aligned edges, related-item proximity and larger gaps between groups. Give the current conversation the strongest spatial presence; make navigation quieter without making it unreadable. Put metadata near what it qualifies. A timestamp should not compete with a message; an unsent warning should.

Prefer rows for scanning conversations and work. Reserve cards for genuinely distinct objects such as a submitted result or embedded source. Reserve surfaces and elevation for meaningful layers: a popover, selected detail or temporary dialog. Avoid nested borders, competing colored badges and repeated headings.

A useful review exercise: temporarily remove color. If selected state, grouping and action priority become incomprehensible, the structure is relying too heavily on decoration. Then restore color to reinforce meaning and personality.

## 4. Establish a small visual vocabulary

These are prototype starting choices, not universal design laws or final tokens:

| Foundation | Proposed starting direction |
| --- | --- |
| Typography | One readable UI family; defined roles for heading, body, label and metadata; test 16px body text before choosing denser variants |
| Spacing | A compact shared scale such as 4/8/12/16/24/32; use relationships consistently rather than forcing every dimension onto it |
| Color | Neutral content surfaces, one restrained interaction accent, separate semantic warning/error/success roles |
| Shape | A small set of corner treatments tied to component purpose, not a different radius for each feature |
| Icons | One coherent family; explicit names for assistive technology; short visible labels when meaning is uncertain |
| Density | Comfortable default, optional compact view; neither may shrink essential targets or truncate consequential information |

Avoid hard-coding a fashionable pale-gray palette before checking contrast. Typography, spacing and color roles should adapt together in light/dark modes and enlarged text. Start with real names, long messages, missing avatars and multilingual content, not idealized short placeholders.

Personality proposal: warm, precise and quietly capable. Let people, artifacts and room identity supply richness. Avoid making every agent action glitter or every successful message trigger celebration.

## 5. Use fewer words without creating riddles

Nielsen's heuristics emphasize recognition over recall, familiar language, visible state and recovery. They are review aids rather than a guaranteed recipe. [NN/g: Ten usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/).

Our copy rule is minimum sufficient meaning:

- Cut paragraphs that repeat a heading or describe an obvious control.
- Prefer specific verbs: Reply, Review, Connect, Retry.
- Keep visible labels for unfamiliar or consequential actions. An unlabeled arrow cannot reliably distinguish sending, sharing and opening.
- Keep real form labels; placeholders disappear while typing.
- Put unusual help beside the relevant decision, not in a compulsory tour.
- Distinguish agent-generated suggestions from agreed decisions without attaching a lengthy disclaimer to every sentence.

For example, a room invitation can show the room name, inviter, access scope and Join. It does not need a manifesto. But removing the access scope merely to shorten the screen is a regression.

## 6. Design states, not just screens

Carbon distinguishes empty states caused by missing data, user actions and failures, with context-specific recovery. It also recognizes that some empty states need no call to action. [IBM Carbon: Empty states](https://carbondesignsystem.com/patterns/empty-states-pattern/).

Our proposed state map:

| Situation | Minimal useful response |
| --- | --- |
| Nothing connected | Show available connection action, while leaving native chat usable |
| No unread conversations | A calm completion state; no forced task or upgrade |
| Search found nothing | Keep query visible; offer an appropriate filter adjustment |
| Provider unavailable | Identify affected connection and keep drafts; do not present an empty inbox as fact |
| Send outcome uncertain | Preserve message and show uncertainty; avoid a retry that can silently duplicate it |
| Another editor has the draft | Show owner and explicit takeover path |
| Access changed | Explain the boundary without revealing protected content |

For every interactive component specify loading, ready, selected, focused, empty, error, disabled and success states where applicable. Also inspect long-running, partial and stale states for agent work. A state is not complete unless the user knows what remains possible.

## 7. Speed and stability are part of the design

Browser responsiveness includes timely visual feedback, not merely final server completion. Layout shifts can move content unexpectedly and disrupt interaction. [web.dev: INP](https://web.dev/articles/inp), [web.dev: CLS](https://web.dev/articles/cls?hl=en).

Project Room should acknowledge an action promptly without inventing success. Keep the composer in place as messages arrive. Do not reorder a list under the pointer or force a reader back to the newest message. Preserve scroll position, selection and drafts when returning from details.

Use motion to explain a relationship or state change. Avoid perpetual pulsing, simulated progress percentages and animation that delays interaction. Respect reduced-motion preferences. A canceled agent run must distinguish a requested stop from a confirmed stop; animation cannot substitute for that state.

Undo is valuable only when real. Removing a local item, retracting a provider message and canceling money movement have different constraints. Label the actual supported action instead of promising universal undo.

## 8. Accessibility is a constraint on the visual language

WCAG specifies at least 4.5:1 contrast for ordinary text and 3:1 for qualifying large text, with defined exceptions. Its 2.2 AA target-size criterion uses 24×24 CSS pixels with exceptions including spacing. [W3C: Contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [W3C: Target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

Our preference is larger touch targets, often around 44px, rather than designing routinely at the minimum. That preference is not the AA requirement, and these two criteria alone do not establish conformance.

Prototype checks must include keyboard-only use, visible focus, accessible control names, zoom/reflow, long translations and non-color status cues. Maintain an alternative to dragging. Test the mobile keyboard opening over the composer. Do not hide essential actions behind hover or depend on an icon tooltip for critical information.

## 9. Design the whole journey, not identical channel skins

GOV.UK's principles favor designing the complete service, understanding context and being consistent without forcing uniformity. [Government design principles](https://www.gov.uk/guidance/government-design-principles).

For Project Room, consistency should mean recognizable navigation and trustworthy rules—not pretending email, room chat and payments behave alike. Chat can use desktop Enter to send; email needs multiline writing and deliberate sending. Private and external composers must have distinct, persistent audience cues. Asking a room for help should not publish an entire private thread.

Test arrival through an invite, first reply, interruption, return, review and recovery. An elegant room with a confusing invitation or unrecoverable connection error is not an elegant product.

## 10. A practical design process

The Design Council's Double Diamond alternates exploring a problem with narrowing toward decisions, and testing solutions rather than treating discovery as a one-time phase. [Design Council: Framework for innovation](https://www.designcouncil.org.uk/resources/framework-for-innovation/).

Proposed cycle for each important journey:

1. Define the intention, current difficulty, relevant audience and failure risk.
2. Sketch two materially different structures before polishing either.
3. Populate both with realistic content and inconvenient states.
4. Choose a structure for explicit reasons; record the tradeoff and remaining uncertainty.
5. Build a small interactive prototype, not the entire feature catalog.
6. Inspect desktop, narrow-screen, enlarged-text and keyboard flows. Save labeled screenshots and interaction notes, with synthetic or redacted data.
7. Run task-based evaluations. Fix misunderstandings before decorative refinement.
8. Do a craft pass for spacing, type, focus, transitions, wording and consistency.
9. Recheck the complete journey; maintain the shared components that produced it.

GOV.UK's moderated-testing guidance favors neutral tasks, observation and open questions; sessions should test the service rather than the participant. [Moderated usability testing](https://www.gov.uk/service-manual/user-research/using-moderated-usability-testing).

Our simulated-human sessions can expose broken mechanics and likely ambiguity. They cannot establish human delight, retention or accessibility for all users. Actual agents can test their own supported connection paths. Later human sessions should ask people to accomplish something—not merely whether they like the design.

## 11. The next concrete design exercise

Use the blueprint's synthetic Inbox/Rooms milestone, not a new redesign initiative. Prototype one email-like conversation becoming a scoped room discussion, an optional work item, a reviewed result and an external reply. Also verify that replying directly and casually chatting need none of the work machinery.

Compare a conversation-first layout with a list/detail alternative. Include a failed send, interrupted draft, unavailable provider and changed audience. Evaluate these questions:

- Can someone identify the place, participants and likely next action without a tour?
- Can they distinguish a private draft, room comment and external reply?
- Can they tell whether work is proposed, running, blocked or accepted?
- Can they find advanced controls without making the main surface noisy?
- Can they leave and return without rebuilding context?
- Can they recover without guessing whether an action already happened?
- Does the product remain useful with no agent, connection or paid feature enabled?

Deliver a small annotated prototype and evidence pack before expanding the visual system. The aim is a distinctive, pleasant product whose sophistication is available when wanted—not permanently on display.

## 12. Deeper research: quiet structure, expressive content

Second pass · September 8, 2026. At John's request, this pass concentrates on design craft and everyday UX, not further accessibility research. Earlier baseline notes remain unchanged. The following proposals refine the same roadmap; they are not implemented product behavior.

### A. Calm and expressive are not opposites

Linear's March 2026 refresh describes reducing the prominence of surrounding navigation, unnecessary icon treatments and separators while preserving useful information density. It also standardized controls whose locations had drifted as features accumulated. [Linear: A calmer interface](https://linear.app/now/behind-the-latest-design-refresh).

Google's Material 3 Expressive research reports that targeted changes to color, size, shape and grouping improved discovery of important controls in tested interfaces. But it also reports failures when expression broke familiar patterns or removed useful text labels. This is vendor-reported research, not evidence that more color improves every application. Its email example changed several attributes together, so it cannot establish color alone as the cause. [Google's research](https://design.google/library/expressive-material-design-google-research).

Our synthesis: quiet surroundings with selective emphasis. A room can have character without every control competing for attention. Use room identity, member faces and artifact previews for warmth. Reserve stronger visual emphasis for the selected object and the decision currently in front of the person. An ordinary unread message should not look like a failed payment or a request requiring approval.

Prototype two directions with identical content: a neutral workspace and the same workspace with localized personality. Reject variants where personality obscures who is speaking, where something will be sent or what needs a response.

### B. Density is not clutter; sameness is not order

A useful distinction for this project:

- Information density: how much useful material is available in the current view.
- Visual competition: how many elements seem to demand attention at once.
- Decision burden: how many choices must be understood before acting.

These can move independently. Ten aligned conversation rows can feel calmer than three large promotional cards. Hiding all controls can reduce visual competition while increasing decision burden.

NN/g's hierarchy guidance stresses defining content importance before styling, and checking real content because imagery can overpower the intended hierarchy. [Visual hierarchy](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/).

Our proposal: rows for scanning, a generous reading region for the selected conversation, and one contextual detail region. Do not spread a few controls across a large empty header simply to create whitespace. Use stronger separation between different groups than within a group. Limit previews before reducing the readability of the main content. Design both a quiet three-person room and a busy room with long names and numerous active items.

### C. Typography is a system of relationships

Apple's typography session explains that optical sizing, letter spacing and line spacing affect how text behaves at different scales. A font's suitability at a large display size does not establish its suitability for compact interface text. Platform-specific APIs in the 2020 talk should not be copied into a web implementation without checking the current platform. [Apple: UI typography](https://developer.apple.com/videos/play/wwdc2020/10175/).

For our prototypes, create a specimen using actual product content before picking a font:

- A long room name beside a short one.
- A compact sender/time row above a multiline message.
- A numeric reward beside its currency and status.
- A draft title, an error and a quiet metadata label.
- An artifact preview with paragraphs, lists and code.

Compare candidates at actual application size. Use weight and spacing to distinguish roles before adding new font families. Do not apply tight headline letter spacing to every small label. Numbers that update frequently should not make a surrounding control twitch in width. Fine optical adjustments to icon/text alignment are legitimate exceptions to a spacing grid, but should be centralized in components rather than scattered screen-specific overrides.

### D. Give the interface a stable geography

Apple's fluid-interface work emphasizes interruptibility, redirection and consistent spatial paths. The relevant lesson for our web app is continuity, not recreating every phone gesture. [Apple: Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/).

Proposed geography: navigation at the left, conversation in the main region, selected work/result in a side detail region on a wide screen. Opening a result should feel like examining something from the room, not launching an unrelated dashboard. On narrow screens, back should restore the previous conversation position and draft.

Movement should describe a relationship: expand an object's details, reveal a contextual menu near its trigger, or return from a detail view along a consistent path. Do not animate a result into the accepted state until acceptance is established. Spatial continuity and business truth must agree.

### E. Frequently repeated interactions need less ceremony

Rauno Freiberg's interaction essay distinguishes novelty from repeated use and discusses cases where removing motion made keyboard-driven interactions feel faster. This is practitioner observation, not a universal timing law. [Invisible Details of Interaction Design](https://rauno.me/craft/interaction-design).

I also opened Emil Kowalski's interactive comparison page and revealed its explanations for frequency of use and layered panel motion. The former favors immediate selection feedback over a trailing highlight; the latter contrasts a panel whose contents are immediately present with a second, staggered entrance sequence. A screenshot of the revealed frequency explanation was inspected in this conversation. This was source inspection, not a measured human-perception experiment. [Train Your Judgement](https://emilkowal.ski/ui/train-your-judgement).

Proposed motion contract:

| Interaction | Direction to prototype |
| --- | --- |
| Move between menu/search results | Immediate selection feedback; no trailing animation |
| Open a detail panel | One short transition; content available together |
| Open then immediately close | Redirect from current state; no queued entrance/exit sequence |
| Receive messages while reading history | Preserve reading position; offer a new-message indicator |
| Submit work | Clear acknowledgment, then actual progress; no simulated completion |
| Celebrate a meaningful milestone | Small, dismissible expression; not repeated for ordinary actions |

Test repetition deliberately. A transition can look impressive once and feel slow on the twentieth use. Compare no motion against restrained motion, not only two elaborate effects. Tune by purpose, distance and frequency rather than selecting one supposedly perfect duration for everything.

### F. Contextual controls need a predictable home

Information scent describes how labels, surrounding context and experience help someone estimate where a link will lead. Merely making a control visible does not make its destination understandable. [NN/g: Information scent](https://www.nngroup.com/articles/information-scent/).

Our disclosure contract has three layers:

1. On the object: the most likely immediate action, state and identity.
2. In its details: less frequent actions, supporting context and history.
3. In preferences/connections: capabilities that change how the room or account works.

Examples: Review belongs on a submitted result. Add reward belongs with a work item. Connect an account belongs in connections, with an appropriate shortcut from the inbox. Avoid generic More menus containing unrelated objects, navigation and dangerous actions in one undifferentiated list.

A contextual action may appear because an object is selected. A feature should not disappear unpredictably because an algorithm has guessed the person is not ready for it. Search and command menus accelerate known actions; they should not be the only means of discovering core capabilities.

### G. Do not make people narrate what they can point at

A recent study of a programming tool combined direct manipulation and natural-language editing. Its abstract reports that participants strongly favored direct manipulation when both were available. The study involved 18 participants and a specific programming environment; the abstract was reviewed here, not the complete 32-page paper. It does not prove that the same preference holds in messaging. [Ziegler et al., 2026](https://arxiv.org/abs/2608.26359).

It nevertheless suggests a useful hypothesis: natural language and direct controls should cooperate, not compete.

For Project Room: choose a message or artifact, then ask for an open-ended transformation. Use a direct control for a precise change such as selecting a reviewer, updating a due date or accepting a result. Do not force someone to type an AI instruction to perform a simple operation. Conversely, do not build a ten-field form where a short request plus an inspectable proposal is clearer.

Both routes should update the same visible object and respect the same permissions. An agent should not create an invisible parallel state known only to the chat transcript.

### H. Onboarding should finish something worthwhile

Intercom frames onboarding around helping users obtain value rather than merely showing feature locations. Its guide is vendor advice with a commercial interest in onboarding tools; we should borrow the purpose without automatically adopting tours and lifecycle-message campaigns. [Intercom: Onboarding guide](https://www.intercom.com/blog/onboarding-guide/).

Our three proposed arrival paths:

- Invited participant: recognize the room, join and reply.
- New organizer: start a useful room and invite someone when ready.
- Returning participant: resume a draft, conversation or decision.

Do not front-load agent configuration, integrations, a work board and billing into all three. Introduce a capability at the point it solves a visible problem. A setup checklist should appear only for a setup task the user deliberately chose. A sample room can illustrate the experience, but must be labeled as an example and never imply that synthetic participants are real people waiting to chat.

For this product, a first successful conversation is a valid first success. It need not produce a task, agent run or transaction.

### I. Preferences can create a sense of ownership

Linear distinguishes defaults that a product ought to get right from preferences whose right answer differs between people. Its settings design treats exploration and customization as part of learning the product. [Linear: Settings are not a design failure](https://linear.app/now/settings-are-not-a-design-failure).

Proposed personal choices: pin a room or view, select comfortable or compact density, choose notification behavior and set a restrained room appearance. Keep these optional. Do not offer switches for every unresolved design decision or require configuration to make the product coherent.

Prefer orthogonal choices over a single giant Beginner/Expert mode. Someone may want dense conversation lists and simple work controls. One mode should not unexpectedly change every part of their environment.

### J. Warmth belongs in the appropriate moments

Apple distinguishes a consistent voice from tone that adapts to the situation. The session explicitly discusses the tension between simplicity and friendliness: sometimes an extra word is worthwhile, while a failure calls for direct help. [Apple: Personality through UX writing](https://developer.apple.com/videos/play/wwdc2024/10140/).

Our proposed voice is direct, warm and capable. Let the product feel welcoming at arrival and appreciative at a meaningful completion. Make routine controls factual. Make failures specific, without jokes or exaggerated apology. Avoid AI-flavored promotional copy inside everyday work.

Example draft pairs for later testing:

- Instead of a congratulatory paragraph after connecting: “Connected” beside the named account.
- Instead of a generic failure: “Reply not sent” with retained draft and an appropriate recovery action.
- Instead of repeatedly advertising collaboration: show a useful contribution and who made it.

These strings depend on verified state; they must not be used to conceal uncertainty.

### K. Craft requires a short compare-and-correct loop

Linear's 2024 redesign account describes testing environment, appearance and hierarchy, and constraining the redesign rather than expanding every navigation question into the same project. Its newer refresh used internal controls to compare old/new variants and tune themes in the actual interface. These are useful process examples, not proof that their exact organization suits us. [Linear's redesign process](https://linear.app/now/how-we-redesigned-the-linear-ui), [2026 refresh](https://linear.app/now/behind-the-latest-design-refresh).

Our proposal is a private design workbench with synthetic room data and alternate component treatments—not a new customer-facing feature. Start with existing preview tooling if it can serve the purpose. It should let us compare the same content under both variants, including long text, crowded lists, active work and failures. The purpose is to shorten the time between noticing a problem and inspecting a correction.

Keep a small decision record: what changed, why, what tradeoff was accepted and which observation would make us reverse it. “Looks cleaner” is incomplete; “keeps the result visible while preserving the reply draft” is an inspectable reason.

### L. Prioritized prototype comparisons

These experiments fit inside the existing synthetic Inbox/Rooms milestone. They do not authorize a production redesign.

| Priority | Compare | What we need to learn |
| --- | --- | --- |
| 1 | Repeated bordered cards vs aligned conversation rows | Can the content stay rich while the interface feels quieter? |
| 2 | Separate work page vs contextual result/work detail | Does a reviewer preserve conversation context and draft state? |
| 3 | Broad generic action menu vs object-specific actions | Can someone predict where to find the action without a tour? |
| 4 | Font/spacing specimens using identical real-shaped content | Which treatment handles reading and scanning without constant exceptions? |
| 5 | Instant repeated actions vs restrained transitions | Which feels dependable over repeated use, including interruption? |
| 6 | Neutral styling vs selective room personality | Can we add warmth without making ordinary activity appear urgent? |
| 7 | Feature tour vs direct arrival at the invited conversation | Can a new participant obtain value without learning the architecture? |
| 8 | Prompt-only operation vs direct controls plus optional agent help | Which decisions benefit from language, and which become needless typing? |

The working thesis is a calm, content-led workspace with expressive moments and stable, direct interactions. The next evidence should come from comparing these alternatives in a small interactive prototype, not accumulating another catalogue of attractive screenshots. No retention, delight or usability improvement is established until evaluated in the relevant context.
