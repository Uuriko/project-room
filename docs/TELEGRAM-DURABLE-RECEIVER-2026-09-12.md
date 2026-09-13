# Durable receiver checkpoint

Implemented a separate encrypted Telegram staging queue and one bounded receive
cycle. No live account, runtime, database or provider configuration was changed.

Flow: replay pending pages into the idempotent private Inbox importer; request a
Telegram page using the durable offset; atomically persist encrypted page and next
offset; commit page into Inbox; mark delivery. Only the next request acknowledges
the prior offset. An import failure retains the page, and replay happens before
the next provider request. A crash after Inbox commit replays without duplicates.

AES-256-GCM authenticates each payload against queue scope and offsets. Queue
scope binds account, connection, auth epoch and encryption key. Writes use SQLite
FULL synchronous transactions. Capacity is intentionally bounded at 256 retained
pages, each at most 25 updates and 256 KiB. At
capacity the receiver stops rather than acknowledging unpersisted messages.

Receiver ticks now acquire a 60-second SQLite lease with owner and monotonic
generation. Competing database handles cannot acquire an unexpired lease, and
expired/replaced workers cannot stage pages or mark delivery. Every worker for
one bot must use the same database; this is not a cross-database/global bot lock.
Provider calls already in flight at expiry cannot be recalled, but their returned
pages are fenced. The host import callback receives an assertLease guard to check
inside its durable import transaction, alongside account/connection authorization.

After draining, ticks keep at most 16 recently delivered staging pages (fewer for
a smaller queue) and prune older delivered copies. Pending pages are never pruned.
Canonical Inbox data is untouched. Capacity therefore measures bounded staging
backlog rather than a lifetime limit. SQLite file space can be reused; secure
physical erasure is not claimed.

Five queue/tick tests pass: failed-import replay ordering, restart durability and
plaintext absence, transaction rollback, stale-offset rejection, wrong account/key,
payload corruption, capacity, and real Inbox-import replay after a simulated crash
before delivery marking. Earlier related messaging tests also passed; full suite
has not been run for this checkpoint.

Remaining before activation:

- Host must securely create the separate private queue DB and encryption key.
  Never pass the live RoomStore DB as this staging database.
- Bind one account and configured chat scope to one bot and one shared queue DB.
  Epoch changes require explicit queue disposition; separate queue files must not
  be configured for the same bot.
- Wire durable connection lifecycle storage and UI controls into the authorized
  receiver factory described below. Its synchronous grant reader must use trusted
  server state and ideally the same RoomStore transaction, never request payloads.
- Add user-visible retention/capacity status before long-running use.
- Add supervised scheduling and authenticated UI status/sync/disconnect.
- Resolve corruption/recovery operator flow, old queue cleanup and key rotation.
- Independent review and runtime acceptance before enabling provider acknowledgements.

These modules are not scheduled or wired into the existing manual pilot. Manual
pilot limitations in TELEGRAM-LOCAL-PILOT-2026-09-12.md remain truthful.

Follow-up verification: 18 targeted messaging tests pass, including eight queue/
tick checks. New checks use two database handles to test competing owners,
replacement fencing, lease loss during provider response, and delivered-only
pruning that preserves pending work. No live staging copies were pruned; tests
used disposable databases only.

## Authorized runtime integration

`createTelegramReceiver` now connects the durable tick to the real private Inbox
importer. It captures the connection grant revision/content and rechecks account
session, auth epoch, connection identity, grant activity, selected chat and lease
inside the Inbox transaction before every observation and before commit. Changed
grants require a new receiver instance; queued messages outside the new chat scope
remain pending instead of silently importing or dropping them.

The importer was moved from the local pilot script into a reusable server module;
the pilot keeps its old export for existing callers. Even empty/duplicate pages
now authenticate the session before returning a successful import result.

Sixteen combined runtime/queue/local-pilot/import tests passed for this follow-up.
Four new runtime tests exercise real disposable RoomStore imports with mocked
Telegram responses: two successive receives, sign-out during fetch, revocation
after the first write (whole-page rollback), and a narrowed chat scope during
pending-page replay. No real provider requests or production data changes occurred.

Still absent: persisted connection lifecycle/configuration and browser controls,
supervised runtime scheduling, live activation, complete multi-account bot routing,
and outgoing replies. The original tests used a synchronous in-memory grant reader;
the following checkpoint adds persistent storage and integration coverage.

## Persistent connection registry

Added a separate SQLite registry with AES-GCM encrypted token/chat configuration,
revision-checked updates, immutable bot/account binding, unique bot ownership per
registry database, auth-epoch checks and disconnect tombstones. Disconnect clears
the stored ciphertext and increments revision; it is a local disconnect, not a
Telegram token revocation. Physical secure erasure is not claimed.

The receiver accepts a synchronous `withGrant` wrapper. Using the registry wrapper
holds its write lock throughout the Inbox import, serializing other handles'
disconnect/configuration writes with that import. Account/session authorization
is still checked within RoomStore's transaction. Registry, queue and RoomStore
must be distinct databases, with consistent registry-before-Inbox lock ordering.

Twenty-five targeted messaging tests passed after this integration. New tests
cover encrypted restart, stale reconnect rejection, cross-account bot conflict,
wrong-key failure, competing registry writes during import, and a real disposable
Inbox receive followed by persisted disconnect with no further provider call.

No live credentials were moved into the registry and no live receiver activated.
Remaining: authenticated API/UI connection controls, secure runtime file bootstrap,
bot verification at configuration, scheduling, reconnect/queued-data disposition,
and independent acceptance. Registry calls are host-only APIs, not authorization
for arbitrary callers. Sharing one bot across multiple accounts is not supported.

## Authenticated connection actions

Added an optional `telegramConnections` HTTP service with account-session-only
GET status and POST sync/disconnect. Mutations require same-origin protection,
CSRF, session binding, an exact connection ID and expected revision. Configuration
and tokens are not accepted from HTTP. Status returns only connection ID, state
and revision. Provider/internal errors are replaced with generic messages; a final
session check prevents an obsolete session receiving a successful sync response.

The service wires the registry lock, authorized receiver, private queue and real
Inbox transaction. Twelve focused HTTP/runtime tests pass, including Telegram's
status/receive/disconnect flow against disposable stores, request-boundary attacks,
session change before response, and the four existing Gmail HTTP tests.

The main server entry point still does not configure this optional service. No
live receiver activation, file bootstrap, scheduling or browser controls happened
in this checkpoint. Next is the compact Inbox UI and secure host bootstrap with
explicit queue/registry file ownership, followed by browser/runtime acceptance.

## Compact Inbox controls

Telegram status and Sync/Disconnect now render inside the existing collapsed
Connections disclosure. Disconnected and setup-needed states expose no misleading
active buttons. Unknown/unconfigured servers render no active Telegram controls.
No credentials or connection identifiers are displayed in the row. Actions send
the exact saved connection revision; response validation requires the same ID and
the expected resulting revision. Sign-out clears rows/status and late responses
from the previous account are discarded.

Four desktop/mobile browser checks pass across Gmail and Telegram, plus two new
Telegram client tests for exact action receipts and late account-switch responses.
Nine existing Inbox client tests also passed earlier in this checkpoint. Browser
checks use mocked connection services with the real HTTP/auth/UI layers; live
Telegram status or automatic receiving is not implied. Secure server bootstrap
and live activation remain separate, unfinished steps.

## Full-stack browser acceptance

The new `scripts/telegram-inbox-acceptance.mjs` passes at desktop and 390px mobile
width. Unlike the UI-only fixture, this uses the real encrypted registry, durable
queue, authorized receiver, HTTP service, private Inbox store and browser UI.
Only the Telegram network response is mocked. It verifies:

- Browser sign-in → Connections → Sync → actual message text visible privately.
- Room event sequence unchanged and no room-sharing button for Telegram.
- Registry and queue closed/reopened from disk; token/body absent as plaintext.
- Next sync requests offset 10 rather than 0 and creates no duplicate Inbox source.
- Browser Disconnect persists registry state while retaining the saved message.
- No browser errors or horizontal overflow in either viewport.

Run the accumulated Telegram regression surface with `npm run test:telegram`.
This includes Telegram unit/integration checks, compact controls and full-stack
browser acceptance; Chromium must be available. These are disposable tests, not
proof of live startup configuration or real continuous provider delivery.

## Opt-in server startup

The server entry point now accepts a fully provisioned private configuration:

- `ROOM_TELEGRAM_REGISTRY_FILE`: existing encrypted registry database.
- `ROOM_TELEGRAM_QUEUE_FILE`: existing matching receive queue database.
- `ROOM_TELEGRAM_KEY_FILE`: existing raw 32-byte key used by both stores.
- `ROOM_TELEGRAM_ACCOUNT_ID` and `ROOM_TELEGRAM_CONNECTION_ID`: exact existing binding.

All file paths must be absolute/canonical, outside the source tree, distinct,
non-symlink, single-link, owned by the current user, and private to that user.
Parent directories must also be private. Unknown database tables, missing stores,
wrong keys, stale epochs and missing bindings fail closed. Runtime startup never
creates credentials or grants, configures a bot, calls Telegram, or schedules work.
Shutdown closes both stores and clears runtime key buffers. Disconnected stores
can reopen for status without reactivating their connection.

Ten runtime/registry tests passed, including the existing Gmail startup tests.
The live server/environment was not restarted or changed. Activation still needs
approved provisioning of matching encrypted stores from the verified bot/chat
binding, followed by real-provider acceptance. The existing plaintext manual-pilot
file is NOT automatically imported. Background scheduling remains unimplemented.
