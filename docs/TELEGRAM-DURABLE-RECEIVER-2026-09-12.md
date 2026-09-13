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
and outgoing replies. Current tests use a synchronous in-memory grant reader to
exercise the boundary; that is not a production connection registry.
