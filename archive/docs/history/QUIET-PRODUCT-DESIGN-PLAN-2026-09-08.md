# Project Room: quiet product design plan

September 8, 2026 · Research and implementation plan, not a claim of completed redesign.

## Recommendation

Make Project Room feel like a conversation with useful work attached. It should not feel like a dashboard of every capability we might eventually offer.

The next implementation slice should combine a cleaner conversation/work presentation with the unfinished request-and-answer flow. Qualify that small complete journey before redesigning navigation or adding automation, rewards, payments, or additional agents.

The durable distinction is **simple presentation, explicit behavior**. People should read less because placement and controls explain the flow. Agents should receive exact context, identity, permissions, revisions and recovery instructions through the existing machine interface. Neither audience benefits from ambiguous state.

## Starting point and evidence

- Login now has a heading, visible key label, entry button and one access-help disclosure. Normal signed-out chrome and repetitive welcome feedback are removed; genuine failures remain visible.
- A first copy pass covers invitations, sharing, work creation, instructions, reminders and AI draft handoff. The [screen-by-screen audit](QUIET-INTERFACE-REVIEW-2026-09-08.md) distinguishes changes from deliberate keeps.
- Current screenshots show a conversation-first page, but several headers, boxed surfaces and repeated message actions still compete for attention. This is a design observation, not a measured human usability result.
- The request service foundation exists. Its complete human composer, request-specific observer attention and full native-agent author/reviewer exercise remain unfinished. Draft helpers are work in progress; the unfinished UI trigger is hidden.
- Existing regression evidence: 510 core/API/package checks; 162 browser checks; a final 15-check focused rerun for the last login feedback and enlarged-text changes. Tests are synthetic, not human interviews or a claim of universal accessibility. The earlier 13 local Worker checks were not rerun for this copy pass.
- No publish, provider change, new account connection, paid execution or payment movement is part of this plan.

## What the additional research changes

| Evidence | Project Room decision | Important limit |
| --- | --- | --- |
| Apple's [writing session](https://developer.apple.com/videos/play/wwdc2025/404/) favors removing repetition and maintaining consistent terms. | Consolidate duplicate state text; use a small vocabulary throughout the interface. | Shortening copy is not permission to remove a material consequence. |
| NN/g's [contextual menu guidance](https://www.nngroup.com/articles/contextual-menus-guidelines/) identifies the discoverability cost of hidden actions. | Leave Reply and the relevant next work action visible; place genuinely secondary actions near their object. | Do not create a menu just to hide one useful button or rely on hover alone. |
| Google's [canonical layouts](https://developer.android.com/develop/ui/compose/layouts/adaptive/canonical-layouts) distinguish primary content, supporting content and list/detail relationships. | Give conversation the main area; let selected work expand into a detail view. Use sequential views on narrow screens with stable return state. | Borrow the interaction structure, not the Android framework or an inflexible column ratio. |
| Google's [PAIR mental-model guidance](https://pair.withgoogle.com/guidebook-v2/chapter/mental-models/) recommends staged onboarding and realistic expectations. | Show connection scope and a concrete checked result instead of promising an AI teammate is already working. | A copied prompt, key issuance and runtime activity are different facts. |
| PAIR's [feedback and control guidance](https://pair.withgoogle.com/guidebook-v2/chapter/feedback-controls/) emphasizes editability, opting out and a manual fallback. | Keep manual work and copy/paste handoff first-class; introduce assistance when a person chooses it. | Do not use a disappearing free path or repeated upsells to force automation. |
| Amershi et al., [CHI 2019](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/), proposed 18 human–AI interaction guidelines, evaluated with 49 practitioners across 20 AI-infused products. | Make assistance easy to invoke, dismiss and correct; explain capabilities and boundaries in context. | This validates the usefulness of guidelines, not this product's design or autonomous multi-agent reliability. |
| W3C's [target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) and [focus visibility guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) constrain compact interfaces. | Use generous touch hit areas and keep focused controls visible under sticky chrome, sheets and software keyboards. | The AA target-size criterion is 24×24 CSS pixels with exceptions; our common touch-control target of 44×44 is a stronger design preference, not that AA minimum. |

The design applications below are our hypotheses. We should test them against the existing interface instead of treating a famous design system as proof.

## 1. The product structure

### Always easy to find

- The current room and who is acting.
- Conversation and its message field.
- Work and the next action relevant to the current member.
- Invitation or agent connection when the member has the corresponding authority.
- Search and a way back from details.

### Shown when relevant

- Reply/request context while composing that kind of message.
- The exact result while reviewing it.
- Connection setup after choosing to connect an agent.
- A clarification request when work is waiting on an answer.
- A recovery control after an operation becomes uncertain.
- Permission, cost or identity consequences before an action that changes them.

### Optional depth

- Review settings, permission details, raw event history and integration configuration.
- Remembered drafts, keyboard help and later display-density preferences.
- Future automation and paid assistance, only when implemented and explicitly chosen.

Do not progressively reveal essential controls merely because someone has used the app for a certain number of days. Reveal relevant complexity through their current task and preserve a stable way to find it later.

## 2. A consistent visual grammar

| Element | Proposed rule |
| --- | --- |
| Primary action | One visually dominant action per active form or decision surface; independent sections can have their own actions. |
| Headings | State the subject once. Avoid room name, room ID and product name all competing as large headings. |
| Containers | Use whitespace for related content and borders for actual boundaries; do not box every label or fact. |
| Color | Neutral by default. Use emphasis for action, uncertainty and consequence, with text or shape as well as color. |
| Icons | Familiar symbols may stand alone with accessible names. Keep short visible words for unfamiliar or consequential actions. |
| Metadata | Group actor and time near the item; put raw identifiers in details except where needed to distinguish duplicate names. |
| Feedback | Prefer a changed item, result or state over an additional success toast. Keep one accessible announcement owner. |
| Motion | Brief transitions may explain opening or completion. Respect reduced motion and avoid pulsing indicators without real activity. |
| Empty states | One useful next action and, if necessary, one short sentence. Never invent activity or testimonials to fill space. |
| Help | Place it at the decision point; do not add a mandatory tour or several nested disclosures. |

## 3. Detailed workstreams

### A. Entry and invitations

1. Preserve the completed quiet member/account login and its error checks.
2. For an invite URL, make the room identity, offered scope and Join/Accept action the focal points. Keep access limits visible before consent.
3. Consolidate invitation feedback so a pending invitation does not explain itself in the heading, summary, field hint and status region simultaneously.
4. Preserve separate states for invalid, expired, revoked, wrong-account and unconfirmed acceptance. Each needs a useful next action, not a generic error.
5. Keep the existing identity-switch/draft-loss warning before the switch. Do not hide it in Help.
6. Do not add email, passkey or magic-link controls until a real supported authentication flow exists. Easier wording must not imply a feature we have not built.

Acceptance: a keyboard-only member can enter; a guest can explain what joining exposes; an uncertain acceptance retries the same operation; no duplicate membership or unexplained identity change occurs.

### B. Conversation and message actions — first implementation slice

1. Consolidate redundant room chrome and test whether the room ID can move to About without weakening orientation or deep links.
2. Keep the composer stable at the bottom of the conversation region. Preserve text, selection, recipient and scroll position during unrelated updates.
3. Keep Reply visible. Retain a clear route to making a message into tracked work; evaluate its placement alongside Reply before putting it into an overflow menu.
4. Do not add hover-only actions. Keyboard focus and touch must expose the same capabilities.
5. Keep room-wide visibility clear beside recipient selection. A recipient is not a private-message destination.
6. Keep Search directly discoverable. Evaluate a compact labeled entry that expands into the current search field; keyboard shortcuts supplement, not replace, it.
7. Finish explicit requests inside the same composer: a small mode strip with recipient/request subject and Back to chat. Show Answer/Decline only for a real request and an eligible actor.
8. Ordinary replies clarify; explicit answers resolve a request. The visual distinction must match actual service semantics.
9. Preserve separate drafts per thread and request/outcome. An uncertain send must never silently become a new operation when the user changes context.
10. Place a refresh/review action next to stale context; retain the draft and require an explicit new choice after a definitive refusal.

Acceptance: message → request → clarification → answer → visible outcome works without a second messaging UI, hidden authority changes, duplicate sends or lost drafts. Desktop Enter sends; Shift+Enter adds a line; touch Return remains appropriate for mobile.

### C. Work cards, results and review

1. Give each compact work card a title, a comprehensible state, the responsible person/agent and the next eligible action.
2. Avoid repeating the same state in a badge, a sentence and a disabled button. A different role's next step can remain as quiet text when useful.
3. Keep acceptance criteria, permissions, claims and history in a predictable details view.
4. Use the same work identity in the list, detail view, result and conversation link. Closing details returns to the originating item and scroll position.
5. Put the submitted result first in a review surface, followed by criteria and the decision controls. Keep exact version and actor attribution available before submission.
6. Do not collapse Result submitted, Review passed and Owner approved into one green Done badge.
7. When work changes during review, preserve notes and show what must be rechecked. Never retain a previous verdict against a new result automatically.
8. Do not make a new visual progress bar unless the underlying states support it. Unknown duration does not justify a fabricated percentage.

Acceptance: the user can identify what needs them, open the exact evidence, review independently, and distinguish a review from final approval. Duplicate names remain unambiguous.

### D. Agent connection and assistance

1. Present two honest routes: bring an answer with Use my AI, or establish a direct connection. They are complementary, not a good/bad tier.
2. Show only supported setup routes. Choose platform instructions after the person selects a route; avoid a giant wall of vendor names and unverified compatibility claims.
3. Reuse the existing name/access/expiry form. Keep the readable scope before access creation.
4. Treat setup as a short sequence: choose access → reveal/import private configuration → check access. Do not auto-run commands or share credentials with another service.
5. Separate observable states: access issued, access check succeeded, recent activity observed, access expired/disconnected. A state requires its own evidence and freshness rule.
6. Put current identity, granted scope and last check near a connection's controls. Raw configuration stays deliberately revealed.
7. Keep disconnect and key replacement clear. Revocation ends room access; do not imply it stops an independently running external process.
8. When hosted assistance is eventually implemented, make its action, budget, approvals and stopping behavior explicit. Do not display a fake Stop control before runtime cancellation exists.

Acceptance: a person can say what access was granted and whether the agent has actually connected. An actual native agent reads and contributes through its own scoped connection; unknown or failed setup has a usable manual fallback.

### E. Catch-up, reminders and returning users

1. Keep actionable work before passive history. Group by what the current member can do, not by every event type.
2. Request-specific attention should link to the exact request/context once the observer/UI feature is complete.
3. Separate Needs you from Waiting on others. Waiting is not a failure or a demand to repeatedly check the app.
4. Show changes since the chosen read marker and preserve the frozen acknowledgement boundary. Newly arriving events must not be marked read accidentally.
5. Move technical sequence details behind an appropriately named details control only if stale/current boundaries remain clear.
6. Keep reminders private and explicitly in-app-only unless actual delivery channels are added.
7. Favor opt-in reminders and useful outcomes over streaks, guilt, fake unread counts or repeated invitations to upgrade.

Acceptance: a returning member can find the relevant next action without reading the entire history, and dismissing/acknowledging updates never completes work.

### F. Mobile, keyboard and accessibility

1. Prototype two narrow-screen layouts using the same underlying state: the existing stacked layout and a simple Chat/Work view switch. Choose based on task completion, not visual novelty.
2. Keep a visible path to Work and its relevant count. Do not make work discoverable only by scrolling past a long conversation.
3. Use a single-pane work detail view on narrow screens; maintain back navigation, active item, drafts and scroll restoration.
4. Keep the message field and active primary action clear of software keyboards and sticky elements. Test real devices when available; emulation alone is insufficient.
5. Give commonly tapped controls generous hit areas without shrinking labels to make space.
6. Preserve visible focus, semantic headings, accessible names, live-region ownership and meaningful reading order.
7. Test 320px width, 200% text, browser zoom, long names, long links and translated-length copy. Compact controls must wrap before they clip.
8. Treat reduced motion as a normal supported experience. State changes must still be understandable without animation.

Acceptance: no essential action requires hover, no keyboard focus is obscured by our chrome, and enlarged text does not remove the ability to enter, send, review or recover.

### G. Performance and interaction stability

1. Measure rendering and input response in seeded rooms with many messages, work records and duplicate names. Do not optimize against an empty demo only.
2. Preserve stable record identity and existing incremental rendering. Do not rerender an open menu, selection or form because unrelated activity arrived.
3. Avoid new dependencies for presentation that existing semantic HTML/CSS can support.
4. Profile before adding virtualization: it can affect screen readers, find-in-page, deep links and scroll restoration.
5. Load optional details on demand only when current data contracts allow it; never replace required identity/permission validation with a cosmetic cache.
6. Introduce shared UI helpers only for repeated behavior with the same lifecycle. Do not create a universal form abstraction that obscures differing retry semantics.

Acceptance: typing and navigation remain responsive in representative fixtures, updates preserve user context, and no shortcut weakens current-state or permission checks.

## 4. Implementation sequence and gates

| Stage | Deliverable | Dependencies / stop condition |
| --- | --- | --- |
| 0 — Completed baseline | Quiet login, initial copy pass, screenshots, automated regressions and audit. | Preserve current changes; do not claim the whole redesign is done. |
| 1 — Complete one journey | Contextual request composer and restrained message/work actions; request-specific attention behind the supported version contract. | Existing request foundation; exact retry/draft tests and actual scoped agent contribution/review. Stop if the visual change requires unimplemented authority semantics. |
| 2 — Room layout | Consolidated chrome, readable work cards and responsive detail navigation. | Stable Stage 1 state ownership; compare narrow-screen alternatives before choosing. |
| 3 — Connection flow | Supported route choice, contextual setup and truthful connection evidence. | Real host capability checks; no saved host configuration changes without approval. |
| 4 — Return flow | Quiet actionable catch-up, reminders and evidence-linked waiting states. | Correct request attention and preserved acknowledgement semantics. |
| 5 — Cross-product polish | Keyboard, touch, long-content, motion, focus, density and performance checks. | All prior stage contracts. Treat accessibility as a check in every stage, not work deferred until here. |
| Later — Optional power | Explicit density preference, optional automation, rewards and richer integrations. | Demonstrated need and working core loop; separate service, payment and deployment decisions. |

Each stage should be a small reviewable checkpoint with screenshots and a clean explanation of what is and is not delivered. No mass rewrite or new component framework is required.

## 5. Code boundaries and test plan

Primary presentation surfaces: `index.html`, `src/styles.css`, and the UI-producing code in `src/app.js`. Preserve the current application architecture.

- Request ownership: `src/reply-requests.js`, `src/conversation.js`, and existing request/client helpers. Finish focused tests for the current in-progress helpers before presenting the feature.
- Work presentation: existing workflow/state selectors remain the source of truth. Avoid a separate UI state machine that disagrees with service events.
- Connection setup: `src/agent-connections.js` and existing connection clients. No fabricated per-provider adapter or new credential store.
- Catch-up/reminders: existing return-brief, reminder and observer modules. Versioned journal changes remain separate from visual preferences.
- Browser qualification: extend the current focused browser scripts and include new checks in the main runner. Do not replace behavioral assertions with screenshots alone.

For every changed surface, capture: normal state, empty state, long content, permission-limited role, loading, failure, uncertain save, stale content, access loss, narrow screen and enlarged text as applicable.

Record screenshots with synthetic data and blank secret fields. Record actual agent test actions separately from seeded fixture state. Keep failures in the evidence, including host startup/shutdown warnings.

## 6. Decision tests, not cosmetic targets

For a new person, ask: Where would you send a message? What can everyone see? How do you bring an AI answer back? What needs your decision? What happened when the connection failed?

For an agent, test: Can it discover its allowed tools, get exact current context, avoid competing claims, request clarification, retain operation identity over retries, submit a result, and leave independent review/human approval to the correct actor?

Compare candidate designs by wrong turns, missed controls, draft loss, mistaken beliefs about access/activity, and completed journeys. Use timings only as supporting evidence; a faster unsafe approval is not an improvement. Do not invent retention lifts from screenshots or automated success counts.

Before production measurement, decide consent, retention and data minimization. Message bodies, access keys, private setup and copied result text must not become analytics payloads.

## 7. Decisions to postpone deliberately

- No automatic rearrangement of navigation based on inferred expertise.
- No universally icon-only interface.
- No mandatory onboarding tour or expanding feature checklist.
- No command palette as the only way to find functionality.
- No new dashboard for each integration, bounty type or automation.
- No fake typing, progress, online status or unverifiable agent identity badges.
- No universal Undo for completed external work, permissions or money movements.
- No payment/growth experiment that obscures cost, access scope or the manual/free path.

## 8. Open questions to answer with the next prototype

1. Does compact work alongside chat help more than it distracts in a busy room?
2. On mobile, do people find Work more reliably through a labeled switch or the current stacked region?
3. Is Make this work understood, or should the label emphasize creating a tracked outcome?
4. Can people distinguish Reply from an explicit Answer without another paragraph?
5. Which connection route do first-time users actually have available: copied prompt, local MCP or a hosted tool?
6. Can the connection state show its evidence/freshness compactly enough to avoid mistaken assumptions?
7. Which exact review facts must stay visible without opening Details?
8. Does a contextual actions menu save meaningful space, or merely add clicks?
9. Which useful advanced controls are currently undiscoverable despite being present?
10. Does an explicit comfortable/compact preference solve density better than separate beginner/expert modes?

Recommended next action: finish Stage 1 in the existing room, validate it at desktop and narrow widths with an actual connected agent, then choose the broader layout changes using that complete journey.
