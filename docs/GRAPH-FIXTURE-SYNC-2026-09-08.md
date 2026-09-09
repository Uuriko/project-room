# Offline Graph synchronization

## Purpose and boundary

`server/graph-fixture-sync.mjs` joins the qualified Graph envelope to durable private import. It contains no network API, credentials or send operation. `RecordedGraphMailbox` serves cloned, invented recordings. The driver runs in Node and the local Workers fixture; it is not mounted as a public sync endpoint or connected to a real mailbox.

Call `prepareGraphFixturePage` with an authenticated account session, its binding, a configured fixture connection and a folder. Retain the returned private request and pass it to `store.email.apply`. Preparation does not write. A lost acknowledgement can retry that exact request; preparing again is a new operation and is not a substitute for reconciling an uncertain earlier apply.

## Decisions grounded in provider behavior

Microsoft documents opaque next/delta links, empty continuation pages, repeated entities and no dependable notification order. We retain the complete cursor and hydrate each distinct message ID once per page, including conflicting or removed invalidations. This is our implementation choice for establishing current message state; it is not a provider guarantee of atomic snapshot consistency. [Delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview).

Message delta is folder-scoped. A moved message or confirmed not-found response becomes an absence in that folder, never a mailbox-wide deletion or deletion of a local draft. Current hydration can supersede an older removal notification. [Message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0).

A recorded 410 or qualified sync-state-not-found response stops preparation with a reset-required outcome. It does not change stored progress. Explicit reset begins a fresh scan through the existing atomic membership lifecycle; drafts remain. A transient error does not imply expiry or absence. [Synchronization reset](https://learn.microsoft.com/en-us/graph/delta-query-overview#synchronization-reset).

## Race and authority behavior

- Capture connection and folder progress before reading a page; check them after every asynchronous boundary.
- Capture each local source revision before hydrating that message. The durable importer rejects a stale source even when a different folder supplied the newer version.
- Prepare again after a known stale-source rejection to fetch current content. Never replace the expected revision on an old payload.
- Disconnect, account revocation and a competing committed folder page stop preparation. A reconnection requires a recording with the new exact connection identity.
- No room or agent credential authorizes private mail.
- Keep prepare and apply separate. The durable write still independently checks current authority and revisions.

## Deliberate qualification limits

Cursor validation is limited to canonical HTTPS URLs on graph.microsoft.com for the exact encoded `/v1.0/users/{mailbox}/mailFolders/{folder}/messages/delta` path. It preserves the query bytes and rejects other authorities, identities and fragments. This fixture does not qualify national clouds, alternate valid path spellings, redirect handling, actual request headers, OAuth or live service behavior.

The driver's 50 distinct messages per page matches the durable pilot batch limit. The general Graph normalizer can inspect larger pages, but this driver refuses them without advancing progress. A real provider pilot must establish paging behavior or durable sub-page staging rather than silently discard extra records. Recordings are bounded by the existing input limit.

HTML stays inert envelope data; attachments remain descriptors, not bytes or downloads. No message rendering, room excerpt sharing, reply recipient editing or live-send capability is introduced here. The next slice explicitly negotiates these message reads in the existing Inbox, starting with plain text and retained private drafts.

## Tests

Focused tests cover duplicate/removal hydration, exact retry after restart, unchanged source observations, expired cursor and explicit reset, invalid next links, wrong hydration identity, immutable-ID refusal, moved/not-found records, disconnect/reconnect, cross-folder source races, empty/nonprogressing pages, capacity, agent/account refusal and cold packaging. The existing Workers store restart fixture now prepares both initial and continuation pages through this driver.

Tests use invented recordings, not a mailbox export or successful real-provider connection. See the checkpoint for exact-version results.
