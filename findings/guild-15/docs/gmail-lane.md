# Gmail lane: mailbox, actions, sync, import authority

Sources: `server/gmail-mailbox.mjs`, `server/gmail-actions.mjs`,
`server/gmail-sync.mjs`, `server/gmail-import-authority.mjs`,
`server/gmail-content.mjs`.

## Design principles

- Gmail mailbox access is **separate from Google account sign-in**.
- Credentials and pending browser sessions are **encrypted at rest**
  (AES-256-GCM via `seal`/`unseal` with the 32-byte `ROOM_GMAIL_TOKEN_KEY`
  as AAD-bound key) and **never projected** into API responses.
- Private bodies never enter the operation journal — only digests/ids.
- The whole lane is gated by `ROOM_GMAIL_ENABLED=1` (memory notes: shelved —
  stays `0`; no activation work). `gmailConfig` throws unless Google OAuth
  is configured and the token key is 64 hex chars.

## `GmailMailbox` (gmail-mailbox.mjs) — connection lifecycle

- `begin(token, binding, { mailboxId, add })` — starts OAuth: PKCE
  (`S256` code challenge), 32-byte `state`, sealed pending row
  (`gmail_pending`, 10-min expiry, ≤ 100 rows, 429 `gmail_busy` when full),
  single-use (consumed on `complete`). Max 10 linked mailboxes.
- `complete(url, browserState)` — validates callback origin/path, single
  `state`/`code` params, `state` format, browser-state binding, pending-row
  expiry, consent; exchanges the code; requires the `gmail.modify` scope +
  refresh token; validates the profile address; **reconnect cannot silently
  switch mailboxes** (`gmail_mailbox_changed` if the address differs).
- `records(auth)` / `record(auth, mailboxId)` — unseal each grant; `usable`
  requires active account, matching auth epoch, active connection, matching
  connection epoch.
- `json(url, init)` — the HTTP layer: 15 s timeout, `redirect: manual`,
  16 MiB streaming cap (`gmail_message_too_large`), status mapping
  (404 → `gmail_not_found`; 400/401/403 → `gmail_reconnect_required`;
  else 502 `gmail_unavailable`).
- `sync(token, binding, mailboxId)` — owner-session full INBOX pull (25 max):
  refresh → list → hydrate each message → strict id/label validation →
  `page.apply` with reset. Fails closed on session change mid-flight
  (`gmail_session_changed`).
- `disconnect` — disconnects the connection, deletes sealed rows + pending.

## `GmailActions` (gmail-actions.mjs) — owner-only operations

- `context(token, binding, write, mailboxId)` — re-checks usability, scope
  (`gmail.modify` for writes), session/epoch/revision; `check()` closures are
  re-invoked **before and after every provider call** so a mid-flight account
  change aborts (`gmail_session_changed`).
- `run(token, binding, input)` — strict allowlist of input keys and actions
  (`list | read | attachment | thread | save | draft-delete | send | archive |
  inbox | trash | untrash | read-mark | unread | star | unstar`).
  Reads need no idempotency; every mutating action requires `requestId` and
  goes through the **reserve-before-effect** journal (`gmail_operations`):
  insert `{ state: "unknown", action, mailboxId, messageKey }` first; on
  crash/timeout the row stays `unknown` and `reconcile()` later matches the
  provider's sent/draft list by `rfc822msgid` — **a replay never repeats the
  provider request**, including after a restart. Fingerprint mismatch →
  `gmail_request_conflict`.
- `send`/`save` build the RFC 2822 body with `gmailMimeBody` (multipart/alternative
  + multipart/mixed, base64 76-char lines, RFC 2047 subject folding,
  `filename*=UTF-8''` encoding); attachments total ≤ 10 MiB, ≤ 20 files;
  reply threading validates `In-Reply-To`/`References` and keeps the subject.
- `hydrate` fetches large text parts via the attachment endpoint; total text
  capped at 10 MiB.

## `GmailSync` (gmail-sync.mjs) — scheduled history ticks

- `mailboxTick(accountId, mailboxId, ownerCheck)` — session-free, bounded:
  history delta (≤ 200 ids) or full INBOX reset walk (paged, same 200 budget;
  folder marked complete only when the walk finishes). Runs under a
  `gmailImportToken` capability (see below). Applies via `page.apply` in ≤ 50
  observation batches with per-batch cursors; no-op ticks write no journal
  entry. Concurrent-tick races fail via `gmail_sync_changed`.
- `tick()` — due mailboxes sorted by `nextSyncAt`, max 10 per tick, deadline
  aware; failures back off exponentially
  (`min(1h, 60s * 2^min(failures,6))`); reconnect-required is sticky.
- `startGmailSync(mailbox, intervalMs)` — unref'd 60 s interval; a tick never
  kills the process; mailbox data never logged.

## `gmailImportToken` / `gmailImportAuth` (gmail-import-authority.mjs)

A **process-local, unforgeable capability** for importing a connected owner's
Gmail observations: a frozen `{}` token registered in a `WeakMap` — never
serialized, never accepted from HTTP, never a session. `gmailImportAuth`
re-validates store identity, runs the owner's `check()`, and requires active
account, matching epoch, active connection with `provider === "gmail-api"`;
request shape is allowlisted (`page.apply` must name the granted connection;
`source.import` must name the granted connection + account).

## `gmail-content.mjs` — parsing/validation

- `gmailParts(payload)` — walks the MIME tree into `{ text, html, attachments }`;
  parts with `filename` or a non-text `attachmentId` count as attachments.
- `projectGmailMessage(message, draftId)` — the UI projection: headers, labels,
  snippet, `body` (text or html→text), sanitized `html`, attachments,
  `editable`.
- `findGmailPart(payload, id)` — part ids are `0(\.\d{1,3}){0,20}`; the part
  must have a body and a filename or attachmentId.
- `attachmentBytes({ data })` — base64url validated, pre-decode length gate
  (`ceil(10MiB*4/3)+4`), post-decode ≤ 10 MiB.

## Failure modes

| Failure | Behavior |
|---|---|
| Refresh 400/401/403 | `gmail_reconnect_required`; sync marks the grant `reconnectRequired` |
| Mid-flight session/epoch change | `gmail_session_changed` — aborts before/after every provider call |
| Provider 404 on message fetch | skipped (`absent` observation) or reset to full sync |
| Oversized message/attachment | `gmail_message_too_large` / `gmail_attachment_too_large` (10 MiB) |
| Unknown request state after crash | stays `unknown`; `reconcile()` heals via `rfc822msgid` lookup |
| Replay with different content | `gmail_request_conflict` — the request id is bound to its fingerprint |
