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
4. Build concise consent/status/stop controls with current-session checks and
   a receipt. Provider disconnect must also stop the receiving path.
5. Add private existing-file startup validation, packaging, recovery/export
   treatment and explicit operations guidance before a separately approved pilot.
