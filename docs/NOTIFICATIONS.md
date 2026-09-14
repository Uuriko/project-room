# Notifications: a per-member feed that honours preferences

14 September 2026. Issue #6 item B4 ("Quiet notifications"), first slice.
Read model only. No delivery, no push, no email, no wake.

## What exists

`GET /api/rooms/:roomId/notifications` returns, for the authenticated member,
the items derived from the room's event log **after that member's own read
cursor**, filtered by the member's `notificationPreferences`
(`notifications.preferences_set`). The browser shows the unread count as a
badge on the catch-up summary and a compact list inside catch-up with one
button, **Mark read**.

The implementation is `server/notifications.mjs` (`deriveNotifications` is a
pure function over `{ events, state, member }`; `Notifications.list` wraps it
in one read transaction). The route lives beside the other room reads in
`server/http.mjs` and shares their credential rules and read rate limit
(`docs/ROUTE-AUTH-TABLE.md`).

## Rules

1. **Source.** Only the event log. Nothing is stored per notification; the
   feed is recomputed on every read from events with
   `cursor < sequence <= room.sequence`, newest first.
2. **Kinds.**
   | Kind | Event | Condition |
   | --- | --- | --- |
   | `mention` | `message.posted` | the message addresses you: `@Your name` in the body (`messageMentionsMember`) or Talking-to (`toMemberId`) is you |
   | `reply` | `message.posted` | `replyToId` points at a message you wrote |
   | `assignment` | `work.proposed` | you are named `accountableMemberId`, `verifierMemberId` or `humanDecisionMakerId` |
   | `work_update` | `work.accepted`, `work.started`, `work.blocked`, `work.blocker_resolved`, `work.completed`, `work.superseded`, `work.handoff_recorded`, `work.halt_cleared`, `verification.recorded`, `owner.decision_recorded` (claims and sessions are not included) | the work names you (accountable, verifier, decision maker) or you proposed it |
   A message that is both a reply to you and addresses you yields one `reply`
   item, not two.
3. **Your own actions never notify you.** Events whose `actorId` is the
   reader are skipped.
4. **Preferences.** Levels are `all`, `mentions_only`, `none` per channel:
   | Channel | `all` | `mentions_only` | `none` |
   | --- | --- | --- | --- |
   | `mentions` | addressed messages | same as `all` (a mention is a mention) | no `mention` items |
   | `replies` | replies to your messages | only replies that also address you | no `reply` items |
   | `work_updates` | assignments and state changes on work you are on | assignments only (work that names you directly) | neither |
   | `announcements` | reserved; no event type feeds it yet | | |
   Unknown or unset preferences fall back to `all`.
5. **Dedupe.** One item per `(member, messageId | workItemId, kind)`. Message
   edits do not add items: the item is keyed by the message and evaluated
   against the **current** body, so an edit that adds a mention surfaces one
   item and an edit that removes it drops the item. Several state changes on
   one work item fold into one `work_update` carrying the latest `sequence`,
   `eventType` and a `changes` count.
6. **Deletion.** A deleted message is a tombstone; its item disappears with
   the body.
7. **Expiry.** Items expire when the member's cursor passes them. Fetching the
   feed never acknowledges. `POST /api/rooms/:roomId/cursor` is the only
   acknowledgement, exactly as for the return brief; the browser's **Mark
   read** posts the `sequence` the list was evaluated through, so items that
   arrive later stay unread.
8. **Bounded scan.** At most the newest 500 events after the cursor are
   scanned (`NOTIFICATION_TAIL`; the query fetches one row more so
   `truncated` is true only when unread events really exceed the bound). The
   response's `basis` says `{ from, through, truncated }`; when truncated,
   older unread events remain reachable through the return brief's Updates.
   `limit` (1–100, default 50) pages the list; `unread` counts the whole
   scanned tail. Unknown or repeated query keys are
   `422 invalid_notification_selection`; a non-positive or oversized limit is
   `422 invalid_notification_limit`.
9. **Membership is rechecked on every read.** The route authenticates like
   every sibling read. A member whose access ended (`member.access_changed`
   with `active: false`, a revoked key, an expired session) gets 401/403 and
   no items, never a stale list. Reading the feed does not extend or refresh
   any session.
10. **Reading grants nothing.** No notification enqueues a wake, changes a
    work item, moves a cursor, or writes any row. `tests/notification-feed.test.js`
    dumps every table before and after reads and asserts equality.
11. **Privacy.** The feed contains only what the member could already read in
    the room. Directed messages are room-visible (`docs/SERVICE.md`), so a
    `mention` via Talking-to is not a private channel.

## Response shape

```json
{
  "roomId": "commons", "viewerId": "agent", "viewerAccountId": null,
  "viewerAuthEpoch": null, "viewerSessionBinding": null, "viewerSessionRevision": null,
  "evaluatedAt": 1789372061430, "sequence": 12, "cursor": 4,
  "basis": { "from": 5, "through": 12, "truncated": false },
  "preferences": { "mentions": "all", "replies": "all", "work_updates": "all", "announcements": "all" },
  "unread": 2,
  "notifications": [
    { "kind": "work_update", "workItemId": "w1", "sequence": 12, "at": "…", "actorId": "maya", "changes": 2, "eventType": "work.started" },
    { "kind": "mention", "messageId": "m1", "sequence": 7, "at": "…", "actorId": "owner", "changes": 1, "workItemId": null }
  ]
}
```

The viewer fields let the browser client reject a response that belongs to a
different session (`RoomClient.ownsResponse`), the same guard the reminders
and return-brief reads use.

## Browser

- Badge: `#notification-count` in the catch-up summary, `N for you`, hidden at
  zero.
- List: `#notification-panel` inside the catch-up body; each row links to the
  message or work record it derives from (`data-open-message` /
  `data-open-work`), so activating a row uses the existing reveal path.
- **Mark read** (`#notification-read-button`) is the only write, and it is a
  cursor move. It is disabled while nothing is unread or a move is in flight.
  Feedback is truthful: a failed cursor POST says "Could not mark read"; a
  stored marker whose follow-up room refresh fails says "Marked read. The
  latest room view could not be refreshed", never a failed save.
- Refresh policy: the feed refetches at once when its own inputs change (your
  cursor, your membership revision, your preferences). New room events only
  coalesce one refetch per 1.5 s while the tab is visible; a hidden tab waits
  until it is visible again. The feed is not fetched per event.
- The badge and list clear on sign-out and on any access end.

Evidence: `tests/notification-feed.test.js` (unit/HTTP) and
`scripts/notification-feed-browser-check.mjs` (Playwright, desktop and
mobile; wired into `npm run test:browser`).

## Not in this slice (follow-ups)

- **Push delivery** needs VAPID keys (a new deployment `secret` binding), a
  service worker, and a subscription table (`schema`). When it lands,
  lock-screen bodies stay off by default; the push payload carries the room
  and count only, and the feed above remains the source of truth the client
  fetches after a push.
- **Per-room mute** and quiet hours: no preference field exists yet.
- **Announcements**: no event type produces them; the channel is reserved.
- **Cross-room feed** for account sessions: the feed is per room by design;
  the account inbox (`docs/UNIFIED-INBOX.md`) is the place a roll-up would go.
