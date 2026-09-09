# Private sample reply interface

Extends the schema-17 private outbox contract. The visible flow now runs in the real account-owned Inbox/Rooms UI against an explicitly configured loopback simulator. Hosted sending remains disabled.

## Interaction

- Save a private draft, then Preview reply. The inactive Save button disappears once saved; editing brings it back.
- The preview shows From → To, subject and exact text. Send sample is deliberate; Enter in the draft still inserts a newline.
- The simulation label stays visible before confirmation. No real person is contacted.
- Accepted, delivery unconfirmed, delivered, rejected, bounced and unknown remain distinct. Status and its next action share a compact row.
- View reply shows the immutable previous envelope. If the current draft has changed, its status is labeled Previous sample.
- An uncertain attempt offers Check status, never an automatic second send.
- A reserved but not dispatched reply can be reviewed or cancelled. Closing the preview alone is not a cancellation of a request already submitted.

No work item or agent is required for a direct reply. The same flow also follows deliberate source sharing, room work, exact review/approval and adoption into the private draft. Room drafts and private drafts remain separate.

## Recovery and private boundaries

The client verifies the exact preview digest, account, recipients, revisions and body; accepted/delivered/bounced states require a provider identity. Receipt checks distinguish the original operation from a current status read.

Unknown reservation/cancellation requests retain only operation metadata in sessionStorage, scoped to the account session. They contain no reply body, address or credential. In-browser fallback retains a request in memory and warns to keep the tab open if storage is unavailable.

Recovering a reservation acknowledgement does not automatically dispatch. It returns to Review reply so the person can inspect that exact reserved text. A lost dispatch response plus failed status read keeps Check status as the available action. A read that loses or rolls back an already observed send record is not treated as proof that it was never sent.

Account changes clear preview text, addresses, pending metadata and in-flight ownership. Late responses cannot reopen an old private reply in the replacement session. Editing or changing source/account authority before dispatch invalidates the saved authorization.

## Optional local service

createRoomServer accepts a SyntheticInboxTransport only when it is bound to that store and configured for a loopback test service, not the production proxy/public origin. The sample endpoint requires account cookie, binding, origin, CSRF and rate limits, and a loopback caller. It accepts only an existing intent plus dispatch/reconcile; callers cannot supply provider outcomes.

Without explicit configuration, send controls stay absent for fresh sources and the endpoint refuses dispatch. Existing history remains readable. The production startup and Cloudflare configuration do not enable this adapter.

For an isolated manual sample:

```sh
node scripts/inbox-sandbox.mjs --start
```

The launcher creates a fresh temporary room database and a separate synthetic mail database, binds a sample owner account, seeds two clearly labeled private messages, and prints a loopback URL plus a private sample sign-in key. Sign in and arrive in Inbox to reply. Stop with Ctrl+C. The sample directory is retained for inspection; it never opens or overwrites an existing user database. The launcher and synthetic mail fixture are not in the production package.

Each sample has unique account/room cookie names. Separate samples in one browser no longer overwrite each other's sign-in or the default localhost cookie names. This avoids accidental collisions, not host-level isolation: cookies are still sent to the same hostname across ports. Use a separate browser profile if other localhost services are untrusted or contain sensitive sessions. Production cookie names, HTTPS prefixes and cookie attributes remain unchanged by default.

Inbox and Rooms use namespaced destination fragments, so reload and copied arrival links retain the chosen destination without including credentials or private source IDs. Existing record and invitation routes retain their own semantics. Opening a room record from Inbox reveals Rooms; it does not discard the private draft. Per-tab session storage remembers the selected message and reading position, bound to the current account session and source revision. It contains navigation metadata only, never message bodies, addresses or credentials, and clears on sign-out or account change. A changed source keeps selection but resets the reading position. If storage is unavailable, durable position restoration is unavailable; saved private drafts remain server-backed. Inbox navigation stays visible while reading long messages on mobile. Inbox is not yet independent of room membership.

## Evidence and limits

Tests cover desktop/mobile direct replies, the reviewed-result return path, unknown acceptance and delivery lookup, lost reservation/cancellation acknowledgements, reload, changed draft, altered preview, combined dispatch/status-read failure, cross-tab account changes and actual sample-launcher sign-in/reply. Screenshots include preview, accepted, unknown and local sample screens.

Use the exact-commit evidence directory for final counts. Candidate failures and repairs are retained separately. All people and provider behavior in these exercises are synthetic/scripted; there is no independent LLM or real-human usability qualification.

Remaining work: broader source/adoption journeys and account-home onboarding, explicit operator resolution of permanent unknown states, actual-agent contribution parity, then authorized provider-specific email qualification. Attachments, true mailbox authority, external delivery and hosted operation are not established by this simulator. The full product goal remains active.
