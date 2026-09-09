# Next slice: Inbox without a room

Historical implementation plan from local source inspection at runtime commit 3858cfe. The checkpoint below records subsequent implementation; the original coupling notes describe the baseline, not today's runtime.

## Completed local checkpoint

Runtime `66de05d` implements account-home arrival, account-owned Inbox independent of room membership, scoped paginated room discovery, separate room/account lifetimes, deliberate invitation transitions and account-only sign-out/recovery. It also clears obsolete room success notices when navigating to Inbox. Final exact-runtime checks: 739 core, 233 complete browser and 18 local Workers, all passing. Evidence and limitations: `../docs/ACCOUNT-FIRST-INBOX-2026-09-08.md`; retained local images/logs under that checkout's `test-results/account-home-66de05d/`.

The explicit route is `/?account=1`; universal root migration and enrollment are not included. Providers and people remain synthetic in these browser tests. Next boundary: [real-shaped email qualification](EMAIL-QUALIFICATION-NEXT.md), using recorded fixtures before any actual account access or sending.

## Outcome

A signed-in person can read and draft a private reply without joining or opening a room. Rooms remain the second destination. Sharing asks for a permitted room only when needed. This extends the existing account-owned inbox; it does not add another identity system or dashboard.

## Current coupling

- src/inbox-ui.js gates its owner tuple on an account-mode room session and room.ownsAccountSession().
- Its InboxClient access-ended callback calls room.endAccess().
- src/app.js room onAccessEnded clears the entire private inbox and exposes room authentication.
- The main sign-out handler requires room state/session and delegates to RoomClient.logout().
- AccountClient and InboxClient already own account-bound requests separately. Reuse those checks; do not weaken them to obtain a convenient UI.

## Small implementation sequence

1. Add explicit account-home arrival and its browser fixtures before changing legacy member-key entry or invitation routes. Verify an account with zero room memberships can load its synthetic messages through the existing service.
2. Separate account-end handling from room-end handling. Account replacement clears both private and room state. Losing one room removes room data/actions but does not claim the authenticated private account ended. Transient transport failure must not appear as sign-out.
3. Bind private navigation and drafts to the account tuple alone. Require current permitted room context only for sharing, viewing room results and result adoption. Do not accidentally treat a stale room snapshot as current audience evidence.
4. Keep Inbox/Rooms navigation stable. A person without rooms gets a useful Rooms empty state; do not force room creation to dismiss it. Preserve explicit invite acceptance and legacy room-key routes without granting a room-key user private-account access.
5. Make sign-out available from account home. Bind delayed results to the initiating account generation; an old sign-out must never sign out a replacement account. Retain unknown-operation metadata rules and warn before discarding unsaved text.
6. Start sharing with the existing current room when available. Qualify account-scoped room discovery before adding a chooser. If that API is absent, show a clear contextual route to open a room, not an invented broad room list.

## Required proof

- No-room account: sign in, read, save private draft, reload, sign out.
- Room removed while reading: room content clears; private draft remains only while the same account is independently valid.
- Account replaced in another tab: private text, dialogs, selected-source metadata and room state clear; held responses cannot repopulate them.
- Uncertain login/logout and failed account restore: no stale identity accepted or misleading success.
- Legacy member-key entry: room chat still works; no private inbox access.
- Invitation acceptance from account home: explicit scope, same redemption on retry, no automatic sharing.
- Private reply without work: no task, invitation, helper or review record created.
- Desktop/mobile screenshots: first arrival, zero-room state, reply, share choice, room loss and account loss.
- Existing core, browser and local Workers suites still pass on the final runtime commit.

## Keep out of this slice

Screenshot-driven polish follow-up: a room “Record saved.” notice can remain over the lower-right private reply controls after navigating to Inbox (final mobile unknown-send screenshot). CSS already makes it pointer-transparent, so this is visual obstruction and stale context, not established click interception. Clear obsolete success notices on destination change without hiding unresolved error/unknown-operation feedback. Add a navigation test rather than merely waiting for the toast to disappear in screenshots.

Real email, OAuth provider setup, public self-registration, native direct-message membership, hosted execution and payments. Those are broader goal items, not prerequisites for fixing this UI ownership boundary. Preserve the current synthetic adapter labeling.
