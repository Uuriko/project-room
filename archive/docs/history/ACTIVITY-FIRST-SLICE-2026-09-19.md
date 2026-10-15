# Activity: first useful slice

Implementation proposal after the reliability gate. This is not a shipped feature.

## The experience

Keep three global destinations: Rooms, Inbox, Activity. Activity answers “What needs me?” across rooms the signed-in account can currently access. Each row names its room, the request or work, why it needs attention, and one action to open the source. Opening Activity or a source does not mark anything read, approve work, send a message or dismiss a request.

Begin with explicit unanswered requests and current work steps requiring the viewer. Group by source work/request; count obligations, not raw events. Preserve room Catch up for its existing history/acknowledgment use. Private Inbox messages stay in Inbox; no preview is copied into room activity.

Do not add automatic summaries, new transports, push delivery or a second workflow system to this slice. Add recent mentions/replies after the first source-opening journey is reliable and the paging/read contract is defined.

## Reuse the existing architecture

- `server/store.mjs:accountRooms` already authenticates the account session, checks each current room membership, fences the response by session binding/revision and pages at 50 memberships. Use that authorization model; do not infer access from a browser-cached room list.
- `src/work-selectors.js:contributionSteps` already derives current obligations from room state. Reuse this logic for each authorized room rather than inventing a second definition of “needs me.” Keep its existing permission and role distinctions.
- `server/notifications.mjs` derives notifications from a bounded 500-event tail and a room cursor. It is not a complete account-wide inbox, and its unread count must not be presented as a global total. Leave its room cursor unchanged in this first slice.
- `src/inbox-ui.js` currently owns global destination/history transitions and guards stale completions. Extend that owner for Activity rather than creating competing destination flags elsewhere. Keep source navigation in the established room/source handlers.

## Small implementation sequence

1. Add an account-authenticated, read-only attention projection. Return viewer identity/session fencing, authorized source references, evaluation time and explicit pagination/coverage. Recheck authorization on every page. No new persistence is needed for a read-only current-state view.
2. Add the Activity destination using the existing history owner. Render a compact list grouped by room; provide loading, empty, retry and partial-coverage states. Do not say “all caught up” while more rooms remain or a read failed. For an account with no rooms, offer Rooms instead of displaying unexplained emptiness.
3. Open a source by deliberately selecting its room, waiting for the authorized snapshot, then applying the source focus. Preserve drafts and ignore late results if the user navigates away. A revoked/deleted source gets a clear recovery path without retaining its preview.
4. Qualify the full journey on desktop, narrow screens and keyboard. Only then add more event categories or per-item read/dismiss behavior.

## Acceptance evidence

- Two rooms with different memberships yield only the signed-in account’s current obligations; a room-bound agent credential cannot enumerate the human account’s rooms. Agents keep their scoped attention APIs.
- Access revoked between list and source-open removes the item and its preview. Account replacement clears every old item; delayed reads cannot restore them.
- More than 50 memberships, empty intermediate pages and tied timestamps do not silently omit rooms or duplicate rows. Coverage remains honest throughout paging.
- Write in Inbox and a room, open Activity, follow a source in another room, navigate Back/Forward: writing survives and focus reaches the intended source once.
- Background updates neither navigate nor acknowledge. Re-reading Activity leaves the event log, cursors, approvals, sends and agent wake queues unchanged.

The useful endpoint is one trustworthy path from “this needs me” to the exact conversation or work. The next human–agent–Inbox slice then follows a private request through explicitly shared work, an independently reviewed result, and a deliberate return to the original private conversation.
