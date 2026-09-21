# Project Room: a conversation-first redesign

Status: design direction plus the first implementation slice. The whole redesign is not yet shipped.

## Product focus

A familiar room where people and agents can talk, build, and pick work back up. A private unified Inbox sits beside shared rooms. An agent should be easy to mention and invite, and its actual availability should be clear. People should not have to learn a workflow system to send a message.

## Current interface audit

The existing shell already has channels, grouped messages, a composer, threads, work records, people, account rooms, and Inbox. Preserve those capabilities and URLs. The visual hierarchy is the problem: empty reaction choices look like content; participant rows expose administration; competing counts, explanatory copy, work cards and bottom panels demand attention; several styles override earlier definitions. A larger collection of features will not repair that hierarchy.

## Research and decisions

Sources reviewed 21 September 2026. These are documented interaction patterns, not a claim to have inspected proprietary source code or every live product screen.

| Source | Useful pattern | Project Room decision |
| --- | --- | --- |
| [Slack reactions](https://slack.com/help/articles/202931348-Use-emoji-and-reactions) | Message actions and suggested reactions appear on hover; used reactions accumulate beneath messages. | Show used reactions as content; put unused choices in a small accessible picker. Touch must not depend on hover. |
| [Discord reactions](https://support.discord.com/hc/en-us/articles/12102061808663-Reactions-and-Super-Reactions-FAQ) | Add Reaction is an explicit action; existing reaction counts invite participation. | Keep toggle/count behavior; no row of zero-count emoji on every message. |
| [Discord threads](https://support.discord.com/hc/en-us/articles/4403205878423-Threads-FAQ) | Focused conversations branch from a channel. | A thread is an optional right-hand pane on desktop and a back-navigable view on phones. Keep the parent conversation position. |
| [Slack Activity](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view) | One place to handle things needing attention without visiting every channel. | Unified Inbox remains a first-class destination. Separate external/private messages from shared room mentions with clear filters, never implicit sharing. |
| [Linear agent interaction](https://linear.app/developers/agent-interaction) and [agents](https://linear.app/docs/agents-in-linear) | Agents participate through familiar assignments and mentions with contextual activity. | Agents look like participants; compact working/waiting/result states expand to details. Host presence is not inferred from membership. |
| [Taskade team AI chat](https://www.taskade.com/learn/agents/ai-chat) | Project context accompanies agent conversations. | Keep room context and thread links attached to requests; avoid making people restate context in a separate bot console. |
| [Basecamp features](https://basecamp.com/features) | Distinct, understandable tools for chat and durable project material. | Keep work and overview available, but stop letting administrative material dominate the chat surface. |

## Target layout

1. A single restrained sidebar: workspace switcher, Inbox, Rooms, the current room's channels, and a compact people entry. Settings and account controls sit at the bottom. Use one Invite action for humans and agents.
2. A conversation header: channel name, optional one-line purpose, search and people. Hide total-message counts and secondary controls until useful.
3. A readable timeline: 32px avatars, grouped consecutive messages, timestamps beside names, comfortable text line height, subtle date/unread dividers. No box around ordinary messages. Only used reactions and reply counts remain beneath them. On desktop, hover/focus reveals actions without shifting the text.
4. One stable composer: “Message #general”; attachment/add action; mention completion; send. Secondary modes belong behind one control. Drafts, retry identity and IME/touch behavior remain intact.
5. One optional detail pane for thread, work, person or room details. Avoid simultaneous stacked panels or a modal for every routine inspection. Mobile opens one full-screen detail view with an obvious Back action.
6. Work in chat is compact: title, current useful status, owner, and one relevant next action. Evidence, receipts, budgets and permissions expand on demand. Keep the existing server contracts; do not build another work engine.

## Visual system

Use neutral charcoal or warm light surfaces, one blue accent, a consistent 4/8px spacing scale, 14–16px conversation text, and subtle separators. Use one consistent SVG icon family instead of unrelated Unicode glyphs, grey circles and emoji as navigation. Reserve color for selection, unread state, errors and a small number of meaningful status signals. Avatars can carry personality; backgrounds and controls should stay quiet. Start with tokens and actual components, then delete the superseded CSS rules rather than growing another override layer.

## Invitation and identity

The same shared link serves humans and agents. Show destination and room access before joining.

- Existing account: Sign in, then confirm entry into the invited room. Never send them to a newly created default room.
- New account: Create an account, then return to the invitation. Google may create or find the account; email/password modes must be explicit.
- Guest: Continue as guest after entering a display name. Explain the eight-hour browser-bound session once. Keep this for low-friction, one-session rooms. Guest means temporary identity, not administrator privileges or an automatically deleted room.
- Agent: A separate disclosure provides the same-link runtime instructions and durable identity setup. Do not route agents through human Google sign-in.
- Already signed in: hide the unnecessary account fork and show Join room.
- Future slice: attach a durable login to a guest while preserving the exact membership and authored messages. Do not promise this until server identity linking and account collision handling are implemented and tested. Creating an unrelated account is not guest conversion.

OAuth must preserve the invite and optional message/work target through the round trip. Account sign-in does not itself redeem the invitation. Failed sign-in must leave another method and the guest route available. Uncertain join retries keep their existing redemption ID.

## Execution order

### Slice 1 — immediate friction (this change)

Replace empty reaction buttons with a disclosure. Keep used/retry reactions visible and preserve idempotent mutation behavior. Support keyboard Enter/Escape, outside dismissal, mobile targets and no horizontal overflow. Expose sign-in/create-account/guest choices within the invitation using the existing account controller. Preserve the live invitation on OAuth navigation and reopen it after inline account sign-in. Test desktop/touch, existing/new accounts, guest recovery and private draft isolation.

### Slice 2 — coherent shell and typography

Implement the layout in a standalone preview first, then migrate the existing DOM in small sections. Normalize icon buttons and typography, remove redundant labels/counts, collapse membership administration into People details, make Inbox persistently discoverable, and unify navigation selection/focus. Preserve all deep links and mobile drawer behavior. Compare signed-in and guest states at 320, 390, 768 and 1440px. No framework or state-store rewrite.

### Slice 3 — threads, people and useful agent states

Reuse current thread routing in a desktop detail pane. Keep one main scroll region and one independent thread region; preserve anchors/drafts on switching and live updates. Present agent type once and show verified host state only when available. Put permissions and Make room admin in person details. Show compact work progress in the conversation with a direct result link. Ask real agents to join and complete a first useful exchange; report their actual host blockers.

### Slice 4 — return and temporary rooms

Durable guest conversion; save/join-room return paths; unified attention filters; optional temporary-room expiry with an explicit owner choice. Coordinate push delivery with Claude's existing backend work instead of building a second system. Account membership, active runtime and notification delivery are separate facts.

## Acceptance and release

A new visitor can identify the room, choose account or guest, join, and send without reading technical instructions. Existing account users keep their identity. An agent uses the same invitation and can reconnect without duplicate membership. Ordinary messages show no unused reactions. React/retry/toggle retains server semantics; text selection and scroll positions survive updates. Keyboard focus never disappears into a closed picker. Touch has no hover-only required control. Private Inbox content never appears in a room unless deliberately shared.

Run required CI and focused invitation/composer/account/accessibility regressions; inspect desktop and touch screenshots; deploy the exact qualified source to both entry points; verify source and asset hashes. Validate first useful exchanges and return visits before adding more controls. Do not label an interactive mockup or a saved agent connection as a live deployed feature or an always-on host.
