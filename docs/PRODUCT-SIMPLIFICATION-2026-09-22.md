# Project Room: less interface, clearer next steps

Design proposal, 22 September 2026. Audited against main aa44374. This document and the companion interactive concept do not change the deployed application. The Gmail setup simplification is already live; the wider changes below are proposed implementation work.

## Direction

Project Room should feel like a conversation app with useful work attached. The default screen answers three questions: Where am I? What am I looking at? What can I do next?

Keep Inbox and Rooms as the two global destinations. Within a room, keep channels, Work, and Activity together. Reading and composing dominate the center. A single optional detail pane holds a thread, work item, person, or settings section. On phones, that detail becomes a separate view with Back. Do not create a new dashboard.

Less text means removing repeated explanations and competing controls, not hiding necessary facts or making every action an unlabeled icon. Preserve recipient, audience, sending identity, unsaved changes, permission boundaries, payment commitments, failed synchronization, and unconfirmed writes where they affect a decision.

## What the audit found

Inspected the current implementation, earlier design decisions, and local Chromium screenshots of sign-in, room desktop/mobile, work creation, Settings and Catch up, using disposable synthetic data. Also reviewed the live Inbox/setup in the preceding task and Gmail/Inbox/account/agent components in source. This is an expert inspection, not a user study or proof of improved task completion.

- Room desktop exposes two Invite buttons, Add agent, Overview, Catch up, Actions, Settings, refresh, security and sign-out across separate bands. Each is valid; their simultaneous prominence is not.
- Mobile stacks account chrome, a healthy Connected strip, channel title and an action row above the conversation. Normal operation takes space that messages need.
- The composer uses a plus for New work, although the familiar meaning of plus is a menu of additions. Its permanent Options row creates another visual tier.
- Work cards can be taller than the message that created them. They show a next action for another person as if it were the viewer's task.
- New work asks for Recipe and Verifier beside the essential request and owner. Review policy can legitimately require these, but it should determine visibility.
- Settings mixes Create Room, About, Results, History, Room health, Usage and Spend. Results and History are project material, not settings.
- Inbox exposes connection administration alongside reading. Existing fixture/unfinished connector records can look connected despite having no live message route.
- Gmail's reader has many equally weighted text actions; its account selector, address and account management can repeat context. A second mailbox deserves a selector; one mailbox does not.
- Prior work already improved reactions, member administration, reply recovery and invitations. Preserve those improvements rather than replacing the existing interaction model wholesale.

Evidence: index.html, src/app.js, src/conversation.js, src/workflow.js, src/inbox-ui.js, src/gmail-ui.js, src/account-setup-ui.js. Local screenshots and the inspection transcript are in ~/Documents/Project Room Design. Word counts from synthetic fixtures are not meaningful product KPIs and should not be presented as a measured usability improvement.

## References and what to borrow

These comparisons use vendors' own documentation, not claims of hands-on testing of their current applications.

| Reference | Borrow | Avoid copying blindly |
| --- | --- | --- |
| [Slack navigation](https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences) and [threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions) | Stable navigation, conversation list, contextual message actions, thread beside conversation. | Multiple parallel navigation rails and badges for every kind of activity. |
| [Discord Server Guide](https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ) | Show newcomers relevant channels and a useful starting point; keep reference material outside the normal channel flow. | Permanent onboarding checklists or importing the complexity of large community servers into a small room. |
| [Superhuman shortcuts](https://help.superhuman.com/hc/en-us/articles/46005789591693-Speed-Up-With-Shortcuts) and [mobile navigation](https://help.superhuman.com/hc/en-us/articles/46005719737357-Mobile-Navigation) | Fast triage, contextual message actions, a command menu for the long tail. | Gesture-only discovery, mandatory shortcut knowledge, or hiding Reply behind a command menu. |
| [Beeper](https://www.beeper.com/faq) and the earlier Texts research | A coherent inbox across providers while respecting network-specific capabilities. | Advertising connectors that cannot operate, or claiming its on-device security architecture for Project Room. |
| [Linear's UI redesign](https://linear.app/changelog/2024-03-20-new-linear-ui), [display options](https://linear.app/docs/display-options) and [search](https://linear.app/docs/search) | Clear hierarchy, compact work rows, contextual view controls, searchable commands. | Turning ordinary conversations into mandatory issue forms. |
| [Basecamp](https://basecamp.com/features) | Plain names and distinct homes for conversation and durable project material. | Adding a permanent dashboard full of tools just because the features exist. |

## Screen-by-screen proposal

| Surface | Show by default | Reveal when needed | Obvious next action |
| --- | --- | --- | --- |
| Sign-in/invitation | Room destination, normal sign-in, guest choice where allowed. | Other sign-in methods; agent instructions; temporary-session explanation beside Guest. | Continue or Join room. Account sign-in alone never joins. |
| First setup | Name/use, the single working Gmail connector, Skip. | Connection errors and the actual Google permission flow. | Connect Gmail or Skip. No future-provider list. |
| Global navigation | Inbox, Rooms, current selection, account avatar/menu. | Account security, sessions, sign out; command menu via visible search entry and shortcut. | Open a destination. Never make people infer current account from an icon. |
| Room list | Room name, concise useful context, unread marker; New room. | Archived rooms, room type, membership/admin details. | Open a room. For an empty account, Create room. |
| Room creation | Name, purpose, prefilled display name. | Organization type and name override under Options. | Create room. Keep required purpose validation; don't silently invent it. |
| Room/channel | Channel name, messages, composer; Search and People entry. | Room name menu: Overview, Invite, room settings. Channel menu: topic, archive. | Read, reply, or write a message. |
| Message | Author/time, body, existing reactions, reply count. | A stable message menu for react, save, copy/link, edit/delete when allowed. | Reply. Desktop hover/focus can reveal actions; touch always has a reachable menu. |
| Composer | Message field, Send, a labeled Add menu. | New work and Request a reply; formatting and other supported additions. | Send. A plus must open a menu, not unexpectedly create work. Do not show unsupported attachment actions. |
| Thread/DM | Parent context and reply field; explicit private recipients for DMs. | Older replies and consent details. | Reply. Preserve scroll position and per-thread drafts. DM requests remain explicit. |
| Work in conversation | Title, owner, concise state; viewer's next action when actionable. | Deliverable, evidence, revision, review, approval, dependencies, history. | Open work or Review result when this viewer can review. Never show Accept to someone who cannot accept. |
| New work | Request, Done when, assignee. | Templates and optional review/settings. Required reviewer/approval fields appear immediately when policy demands them. | Create work. Visible summary of consequential permissions before submit. |
| Work list | Title, owner, state; default relevant work. | Group/filter controls, completed work, results and history. | Open one work item. Reuse existing records; don't create a second work system. |
| People/agents | Names, one agent marker, relevant verified state. | Permissions, provider configuration, host connection, DM consent and removal. | Message or Invite. One Invite entry branches into person/agent; preserve both current flows. |
| Private Inbox | Message list, search, New email where enabled; selected-message pane. | Account/folder filter only when useful; Connections in account menu. | Open a message, reply, archive. An empty inbox shows one Connect Gmail action. |
| Gmail reader | Subject, sender, compact recipient line, body, Reply and Archive. | Reply all, Forward, mark unread, star, trash, conversation, original headers under More/details. | Reply. Always show sending account in compose; show account switcher for multiple mailboxes. |
| Connections | Only usable connectors; address and meaningful status. | Reconnect, disconnect, diagnostics. Existing inactive records remain recoverable in Settings, not falsely presented as working connectors. | Connect or Reconnect. Don't delete dormant records during a visual cleanup. |
| Activity / Catch up | Items requiring this viewer's attention; unread room updates. | Read history, scheduled reminders, notification preferences. | Open item, complete its action, or mark read. Keep private inbox and room activity logically separate. |
| Settings | Room name/purpose, people/permissions, notifications, integrations. | Owner-only usage/spend, export, diagnostics, archive/delete. | Change the selected setting. Results/History move to Work. |
| Errors/recovery | Short fact and one safe next action. | Technical details, receipt IDs, diagnostics. | Retry only if known safe; Check status for unknown sends. Never simplify away a pending mutation warning. |

## Visual and interaction rules

- One global navigation area; one header for the active content. Avoid stacked healthy-status bars.
- One dominant action per local task. Invite is secondary while writing; Send is primary. Review is primary only when review is the current task.
- Keep familiar words visible. Use standard icons for search, back, overflow and close with accessible names. New or unusual concepts get text labels.
- Use the existing charcoal/violet foundation with higher hierarchy, not a new ornamental theme. Keep 14–16px body text, readable secondary text, consistent spacing and approximately 44px touch targets. Never create calm by reducing contrast or shrinking text.
- Empty states: one sentence plus one action. No instructions for features absent from that user's permissions/capabilities.
- Normal success is quiet. Display an inline warning for disconnected, stale, paused or blocked states that affects the next action. Do not equate an agent membership with a running host.
- Avoid walls of nested disclosures. One More menu for actions, one detail pane for content. Do not move everything into one undifferentiated overflow menu.
- A single optional pane at a time. On mobile, use Back and retain the previous list position. Browser Back and deep links must behave consistently.
- Repeated action groups occupy a stable position; receiving messages must not move the composer or keyboard focus.
- Badge counts mean actionable or unread items, never total historical events. Hide zero badges.

## Copy replacements

| Current | Proposed | Placement rule |
| --- | --- | --- |
| Bring your email into your private inbox + repeated empty-inbox guidance | Connect Gmail | One empty-state sentence, one button. |
| Participants | People | Agent identity remains explicit in the person row. |
| Verifier | Reviewer | Only when a review is requested or required. |
| Definition of done / Done looks like | Done when | Beside the actual acceptance criteria field. |
| Recipe | Template | Optional; don't require a choice before a blank request. |
| Next: Test producer — Accept the assignment | Waiting for Alex | If the viewer is Alex, show Accept as an action instead. |
| Actions ⌘K | Search… ⌘K | Only after search/commands have a real combined interface. Don't relabel the current command list as search prematurely. |
| Inbound: fixture mailbox · not yet routed | Not connected | Within connection diagnostics; no false Connected badge. |
| Couldn’t save this step | Couldn’t connect Gmail. Try again. | Only for connection failure; distinguish save, consent and callback errors. |
| Technical send failure / ambiguous retry | Send unconfirmed · Check status | Keep the at-most-once receipt/reconciliation behavior. |

## Feature preservation and implementation order

1. **Chrome and copy:** combine room navigation; consolidate Invite; account menu; quiet healthy connection state; remove redundant paragraphs/zero counts. Keep current DOM contracts and events while moving controls. No backend change.
2. **Contextual actions:** labeled Add menu, compact Gmail actions, connection settings, conditional work fields. Map every old action to a new reachable location before removing a control.
3. **Detail pane:** threads, work and people reuse the existing endpoints and state. Preserve focus return, draft isolation, retry IDs, scroll anchors, mobile Back and deep links.
4. **Work and Activity organization:** move Results/History out of Settings; group existing attention feeds without changing private-room visibility or marking items read automatically.

Feature map to retain: room/channel creation and archive; Google/email/key and guest entry; people/agent invitations; durable agent identity and runtime setup; message/reply/mention/reaction/pin/edit/delete; directional DM consent; work assignment/acceptance/completion/review/approval/reuse/evidence; results/version history; reminders/notifications; Gmail read/write/drafts/attachments/search/folders/multiple accounts; private source sharing/quarantine; exports; ownership/admin; spend controls; session recovery and sign-out isolation. An item can move; it cannot become unreachable.

## Acceptance before broad rollout

Use existing regression suites plus scenario checks at 320, 390, 768 and 1440px, keyboard-only, touch, 200% zoom and reduced motion. Check both themes if theme choice is introduced. Measure visible controls using the same seeded state before/after; don't equate fewer words with success.

A first-time person should find Inbox/Rooms, send a message, reply, invite someone, and create a work item without reading help. A returning user should find a pending review and its evidence. A Gmail user should identify the From account, reply, manage an attachment and recover an uncertain send. A guest and a non-admin should see an appropriate interface with no false action promise. A disconnected agent should never look ready to run.

Validate after relocation: every old action still reachable, no hidden critical state, no hover-only touch feature, no horizontal overflow, no focus trapped outside a detail pane, no lost drafts or duplicate sends, no private email/DM exposure, no widening permissions. Run core, Cloudflare, invitation, account/session, inbox/Gmail, composer, thread, work/recovery and accessibility gates. Deploy only an exact tested tree and verify public assets.

The clickable concept is a local simulation with synthetic content. It demonstrates Room, Inbox, Work, contextual menus, a detail pane and mobile navigation; it does not send messages, connect accounts or implement the full feature map. It is deliberately not presented as a working replacement for production.
