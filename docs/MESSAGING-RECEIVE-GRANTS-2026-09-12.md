# Receive-only background authority: isolated implementation

`server/messaging-receive-grants.mjs` is a host-only component. At `1e03023` it
connects to a narrow internal Inbox receive method and a signed SMS/WhatsApp
background importer. It is included in the exact runtime package (132 files),
but **no HTTP receiver/startup or live account is enabled**. Telegram and ordinary
interactive Inbox actions still use their existing session authorization.

Checkpoint `17d9e31`: four focused grant tests and **1484/1484 full Node tests**
passed, zero skipped. Independent review requested; no new full browser run.

`1e03023`: focused grants/import/package checks passed 10/10 before the final
additive rollback assertions; both provider tests passed again afterward. The
new tests verify actual private import after logout, exact duplicate retry,
signature/destination boundaries, expiry after journal writes rolls back the
whole import, and grant revocation plus provider disconnect stop future imports.
An exact in-process lease is valid only during its synchronous callback and
only for its originating RoomStore; copying or retaining it cannot authorize
another action. No fake human login or general Inbox credential is minted.

Exact `1e03023` then passed **1486/1486 full Node tests**, zero skipped, plus
**6/6** existing SMS/WhatsApp desktop/mobile journeys and package checks. This
does not constitute a new full browser run or a live-provider test.

An authenticated account session can issue a grant for one connection/provider,
pinned to the connection's exact revision. The host must first verify that
connection belongs to the account through its provider registry. The connection
revision is what binds selected Telegram chats or the receiving SMS/WhatsApp
address; registry changes require an explicit new grant. A caller-supplied grant
descriptor is not a bearer credential and cannot sign in or call ordinary Inbox
actions. Providers currently allowed: Telegram bot, SMS, WhatsApp Business.

Expiry is mandatory, at most 30 days. Renewal uses compare-and-swap revision;
old descriptors cease to work. Revocation appends a durable tombstone event.
Account deactivation or auth-epoch change fences use even before explicit grant
revocation. Sign-out alone does not cancel this separately granted background
permission; the eventual consent UI must say that clearly and provide a Stop
receiving action. No send, share, room access or agent access is implied.

Each grant event records account, connection/provider revision, auth epoch,
expiry, time and authorizing session revision. No token, provider secret or
message body is recorded. This private metadata ledger is not encrypted by this
component and is not a tamper-proof audit log. Host private-file enforcement is
required before runtime integration. The owner supplies and closes the database;
component close disables further operations.

Limits: at most 100 historical connection identities per account and no new
issues/renewals after 5,000 events per account. Revoking active grants remains
possible at the limit (at most 100 additional events). Capacity reset/deletion is
not implemented; do not silently erase authority history to free space.

## Transaction boundary and next integration

### Optional existing-store runtime (`9ab0e4e`)

Alongside the four existing Twilio controls variables, a host may supply both
`ROOM_TWILIO_RECEIVE_GRANTS_FILE` and `ROOM_TWILIO_WEBHOOK_PATH`. Partial receiving
configuration fails. The grant database must already exist outside the source
tree, in an owner-private directory, as an owner-private single-link regular
file; canonical paths and all file-path distinctness checks apply. It must have
the expected grant table. The webhook path must be `/webhooks/twilio/<id>` and
match the active encrypted connection's HTTPS URL path without a query string.

The runtime returns `webhook` as an **unstarted** server and wires permission
controls to the existing grant database. It creates no permission or session,
makes no provider call, and does not configure a public proxy. `server.mjs` still
does not call this listener's `listen`; merely setting variables is not a live
receiving setup. Closing the runtime closes the listener/stores and clears keys.

Each request resolves the current active grant revision against the current
provider revision, account epoch and expiry, then the importer independently
reacquires/validates that authority. Consent renewal does not need a server
rebuild; old or changed bindings still fail. Eight focused tests pass, including
no grant at startup, manually started disposable HTTP rejection before consent,
receive/stop/renew, path mismatch, partial config and private-file permissions.

Exact `9ab0e4e`: **1490/1490 full Node tests**, zero skipped, and **6/6**
background browser/package checks passed. Independent review requested. This
does not prove production hosting, proxy configuration or physical-device use.

### Account consent endpoints (`c5a27d9`)

When a host explicitly supplies the receive-grant store to its Twilio connection
service, account-only HTTP endpoints support status, start and stop under
`/api/inbox/connections/twilio/receiving`. Start requires the exact current
connection and grant revisions; the server fixes the lifetime to 24 hours and
checks the encrypted provider registry before issuing. Stop revokes only the
receive grant: the provider connection and saved Inbox messages remain.

Writes require the current account cookie, session binding, CSRF and Origin,
reject extra fields, and use account-scoped rate limiting. Agent bearer keys and
foreign accounts cannot operate the controls. Responses omit provider secrets
and phone numbers. Status describes **permission**, not proof that a live
receiver is running. A stale provider revision is reported as reauthorization
needed. An absent grant store leaves the controls disabled.

Six focused grant/control tests pass, including HTTP consent → real signed
fixture import → HTTP stop → blocked import. No live startup supplies this store.
At `cec3879`, the existing Connections UI adds an optional “Receiving” disclosure
with “Allow for 24 hours” and “Stop receiving,” explaining continuation after
sign-out and no send/share access. Permission state is not labeled “Connected.”
Controls remain absent when the host does not supply the grant store. Thirteen
focused client/browser checks pass, including narrow/desktop consent, stop,
stale-account buttons and unconfirmed-action recovery. This is not a real-provider
or live-startup test.

UI evidence: `cec3879` focused client/browser **13/13** and packaging **2/2**
passed. Its first full Node run had one ambiguous numeric privacy-marker failure
in an unrelated Inbox test (isolated rerun 11/11). `bb31e10` replaced that marker
with a distinctive private fixture value and passed **1488/1488 full Node tests**,
zero skipped, with the UI runtime unchanged. Whole-snapshot privacy assertions
remain; the same marker is used for future-member visibility checks as well.

Exact `c5a27d9`: **1487/1487 full Node tests** and **6/6 existing messaging
browser/package checks** passed, zero skipped. Independent review requested.

### Locking

### Full browser background journey (`3bf54df`)

Four real-application-layer journeys now pass: SMS and WhatsApp at 390px and
1280px. Browser consent issues the grant; after browser sign-out, the signed
background importer saves one private message and deduplicates its retry.
Signing back in restores the Inbox and displays that message. Browser Stop
revokes the grant; subsequent import is rejected, including through a reopened
grant database. The provider connection remains active, saved text stays readable,
private journal verification passes, and the room sequence does not change.

`test:messaging` at `3bf54df` passed **42/42**, zero skipped. At that checkpoint
the journey called the signed importer directly. `2d65ee5` upgrades all four
journeys to actual loopback HTTP using an explicit background-grant route.
Tampered signatures fail before import; duplicate delivery returns empty TwiML
after persistence; Stop causes later HTTP delivery to return non-success.
Ten focused browser/webhook checks pass. Inputs remain provider fixtures, not
real Twilio traffic. Production callback/startup wiring remains a gap.

Exact `2d65ee5`: **1489/1489 full Node tests** and **2/2 packaging checks**
passed, zero skipped. Independent review requested; not a full browser rerun.

Route authority is mutually exclusive: either `getSession`/`withConnection`,
or `background: { registry, grants, getBinding }`. Mixed/missing configurations
fail at construction. The host supplies a trusted grant binding; no request
field selects an account, connection or grant. Bindings are revalidated by the
registry/grant importer. The factory does not listen or activate itself and
`server.mjs` does not start this receiver.

The first draft of the new test waited for room chat on sign-in; evidence showed
the app had correctly restored Inbox instead. The assertion was corrected to
wait for authenticated navigation, with no application behavior changed.

Lock order must be provider registry → receive-grant database → RoomStore.
The callback is synchronous. The current account and grant are checked both
before and after it, inside the RoomStore transaction, so expiry or authority
changes during import roll back that import. A second database handle cannot
revoke concurrently through a held grant lock. This is not a distributed
transaction: if an Inbox commit succeeds but a later metadata commit fails,
the caller must not acknowledge delivery; its duplicate-safe Inbox replay must
recover the retry.

Before activation:

1. Review this authority component independently and test capacity and all
   provider-registry combinations.
2. Independently review the new narrow internal receive path before enabling
   it; keep ordinary Inbox actions authenticated and test cross-account abuse.
3. Wire the existing Telegram/Twilio HTTP receivers to hold all three locks and test
   true import, restart, revoked/expired grants and account changes end to end.
4. Preserve the passing browser → grant → signed background importer → stop
   journey while adding the remaining HTTP/background startup boundary.
5. Add private existing-file startup validation, packaging, recovery/export
   treatment and explicit operations guidance before a separately approved pilot.
