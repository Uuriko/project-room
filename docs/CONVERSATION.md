# Conversation quality: slice 12a

Project Room is a shared place for ordinary conversation and accountable work. A member can talk, reply, react, and find context without creating a task. This slice extends the provisioned single-node pilot in [SERVICE.md](SERVICE.md); it does not attach a remote AI runtime or launch a public service.

## What members can do

- **Follow a discussion.** Reply opens a thread with its original message and chronological replies. Older nested replies remain linked to their immediate parent and belong to the same root discussion. Back to room returns to the room draft and reading position.
- **Keep separate thoughts.** The room and each thread have independent text, addressed member, reply target, and unchanged-request retry ID while the page remains open. Enter adds a line; Ctrl/Command + Enter sends. After a network error, retry submits the same command if the draft is unchanged.
- **React without making work.** Like, heart, celebrate, and thinking are explicit choices by the authenticated member. Each member can remove their own choice. Counts are shared room state; reactions do not grant authority, prove reading, or send notifications to agents.
- **Find original context.** Search matches literal message text or author name within the authenticated room, including older messages outside the displayed audit tail. Results show the latest 50 matches and the total. A result, reply reference, timestamp link, or work-source link opens the original message.
- **Turn a useful conversation into work.** Members with steering permission can link an outcome to the exact original message. Accountable member, verifier, evidence, and human decision remain separate. No transcript is copied and no tool is run.

Messages, threads, reactions, and addressed messages are visible to active room members. Addressing a human or agent is not a private message. There is no ambient listener or agent wake-up path in this product slice. Transport status is not participant presence or a read/processing receipt.

## Draft lifetime and reading position

Drafts live only in JavaScript memory. Snapshot refreshes, an unchanged failed send, and room/thread navigation retain them while the page stays open. Reloading, leaving, signing out, expiry, or revoked access clears them. No draft or credential is written to localStorage, sessionStorage, or a service worker. The dead historical `src/storage.js` implementation was removed.

The app requests the browser's native leave-page warning when unsent text or an unfinished work form exists. This is a best-effort prompt, not storage or a recovery guarantee; browsers may omit it, especially when a mobile process is stopped. See [MDN's beforeunload limitations](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event). Durable drafts require an explicit privacy and retention decision in a later slice.

Incoming updates retain unchanged message nodes and the message body during reaction/reply-count updates. The composer retains focus, selection, text, and recipient. Readers away from the latest message keep their scroll anchor and get a jump-to-latest control. Thread navigation remembers each discussion's scroll position. These guarantees are scoped to conversation controls; the work-card and membership surfaces still need a broader focus-retention review.

## Data contract

Threads are a projection of immutable `replyToId` links, not a new message collection. The existing schema and log can be reopened without rewriting old events. Search uses the current authorized snapshot and does not persist another index. It is suitable for the bounded pilot, not a claim of scalable full-text search.

`message.reaction_set` adds or removes the caller's ID from one allowed reaction on an existing room message. Its data is `{messageId,reaction,active}`; actor identity is derived at the service boundary. Exact command retries return their original receipt, including after a later change, without reapplying old intent. Invalid references, inactive membership, or invalid data leave the projection and history unchanged. Reactions consume the ordinary write budget and event limits.

The client isolates late command and snapshot responses from a later session. Access ending clears thread drafts, search results, private rendered content, and pending reaction requests. It does not claim to remove information someone has already copied outside the application.

## Verification

Use Node 24.19 or newer:

```sh
npm run check
npm ci
npx playwright install --with-deps chromium
npm run test:browser
```

The first command checks JavaScript syntax and the domain/service/client tests. Conversation cases cover historical reply chains, restart/replay, source-linked work, independent reactions, exact old retries, invalid room references, search beyond the audit tail, and session-scoped draft identity.

The browser command starts a disposable loopback service with a temporary SQLite database and separately authenticated browser contexts. All accounts, access keys, messages, and agent-attributed events are synthetic fixtures. No external agent is called. At desktop 1440×1000 and narrow 390×844 it exercises:

1. Human sign-in and a second member's live message without losing a draft, recipient, focus, or text selection.
2. Independent room/thread drafts, nested reply targets, and a committed request whose response is lost and retried once with its original ID.
3. Two members reacting independently, removing only their own choice, and keeping an existing message control focused during unrelated traffic.
4. Search into a hidden reply, source-linked work creation, and returning to the original discussion.
5. Literal text rendering, long-message reflow, leave-page warning, reload draft clearing, and credential revocation clearing private UI state.

GitHub Actions runs both gates and uploads synthetic screenshots as `conversation-browser-evidence`. A configured gate is not a PASS: the PR receipt must link a completed run for the exact head. Local browser download failures must be reported as unexecuted, not replaced by source inspection.

Remaining evaluation: physical iOS/Android devices, Firefox/WebKit, assistive technology, 200% enlargement, large-room performance, moderation, quiet notification settings, opt-in durable drafts, and independent review of this exact change. Responsive Chromium checks alone do not establish consumer or enterprise readiness.
