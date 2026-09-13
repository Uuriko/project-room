# Messaging readiness — direct integrations

## Latest verified acceptance

- Startup/runtime checkpoint `07c7d80` plus the new webhook failure tests passed
  **1479/1479 Node tests**, zero skipped. No runtime code changed during that run.
- Five webhook checks now explicitly include a failure after journal writes:
  transaction rollback leaves no private source, HTTP returns non-success, and
  retry imports once. An incomplete HTTP body receives 408 after the five-second
  deadline without importing or returning success TwiML. These are disposable
  fault tests, not evidence of production traffic or provider retry guarantees.

- `627b4db`: full Node suite **1474/1474**, zero skipped, after UI integration.
- `npm run test:messaging`: **22/22** checks pass, including SMS and WhatsApp
  signed HTTP → encrypted connection registry → private Inbox → browser disconnect
  at 390px and 1280px. Those four full-path checks use real application layers
  and locally signed provider fixtures, not live Twilio accounts or network calls.
- Disconnect blocks the next signed delivery; a newly opened registry handle
  sees the persisted tombstone. Already saved text remains readable, the room
  sequence is unchanged, and private journal recovery verifies.
- Last complete full browser checkpoint remains `bbed875` (**317/317**). Newer
  controls have targeted browser acceptance, not a new complete browser run.

Next highest-value work: secure opt-in host startup with existing private stores;
document explicit background authority and webhook retry/media policy; live
provider onboarding only after the separate credential/spending/deployment gates.
Then replies with clear send confirmation and provider delivery receipts. Slack
still has signed parsing only; personal Signal/WhatsApp mirroring is not available.
No phone number, paid account, remote webhook or live messaging service was enabled.

## Provider inventory

### Opt-in startup for account controls

Startup can now open an **existing** Twilio registry for status/disconnect using
all four host variables: `ROOM_TWILIO_REGISTRY_FILE`, `ROOM_TWILIO_KEY_FILE`,
`ROOM_TWILIO_ACCOUNT_ID`, and `ROOM_TWILIO_CONNECTION_ID`. With none, it remains
disabled; partial configuration fails. Paths must be canonical absolute paths
outside the source tree, in owner-private directories, with owner-private regular
single-link files. The key must be 32 bytes. Foreign database schemas, wrong keys,
inactive accounts and mismatched account epochs are rejected. Credentials are not
returned to the browser. Shutdown closes the registry and clears its key buffer.

This opt-in initializes **account controls only**, not the webhook listener. It
does not create or migrate private files, grant background access, start polling,
or make provider calls. No live runtime was restarted. The next receiving-runtime
decision remains explicit background/session authority and secure HTTPS exposure;
the tested webhook factory currently requires a valid account session per delivery.

Latest checkpoint: Telegram's 35 targeted checks pass, including desktop/mobile
end-to-end controls and durable recovery. A live manual check returned imported 0,
pageFull false, without acknowledging updates. Encrypted queue, registry,
disconnect, HTTP controls and opt-in startup are implemented but not activated in
the existing local pilot. Continuous delivery and replies remain unfinished.

SMS/WhatsApp now have a host-only signed private Inbox importer, not merely a
parser. Exact retries return the original receipt; changed content under the same
MessageSid fails. Account ownership, channel-specific addresses, private storage,
journal recovery and mobile rendering are tested. No public callback, provider
account, number, background receiver or outbound transport is configured.

| Service | Verified now | Remaining before usable connection |
| --- | --- | --- |
| Telegram bot | Real private receive/import; durable receiver and controls tested in disposable runtimes | Activate private durable runtime, background receiver, replies |
| SMS | Signed inbound text → private Inbox, duplicate-safe journal and mobile rendering | Messaging account and receiving number, public HTTPS callback, connection registry/controls |
| WhatsApp Business | Signed inbound text → private Inbox using distinct channel validation | Sender/business onboarding or sandbox, callback and connection lifecycle |
| Slack | Signed HTTP Events API verification, workspace/app/channel scoping tested | App installation, scopes and selected conversations, durable ingestion, live callback or separate Socket Mode runtime |
| Personal Signal/WhatsApp | Not connected | Separate linked-device integration; not equivalent to a business API |

No new service was deployed, phone number bought, SMS sent, or unrelated Slack
app reused. Gmail's existing local 25-message import remains in place.

## Telegram checkpoint

The manual pilot was re-run successfully: imported zero duplicates, skipped zero,
pageFull false. It now validates the private parent directory, requires an existing
non-symlink database, and checks token-prefix/bot-ID consistency. It explicitly
reports manual-first-page mode and warns when 25 queued updates fill that page.
This is not continuous delivery. See TELEGRAM-LOCAL-PILOT-2026-09-12.md for operation
and the required atomic cursor/connection lifecycle work. Do not run it as an
always-on receiver or represent all personal Telegram messages as connected.

## Next-service order

1. **Slack**, if the existing workspace permits installing our own app. Socket
   Mode avoids a public callback for a local pilot, but needs an app-level token
   plus bot OAuth scopes; its authenticated envelopes need a separate handler
   from the signed HTTP parser implemented here. Keep access to selected chats.
2. **SMS via Twilio**, using a provider-owned receiving number. This does not
   mirror an arbitrary existing iPhone/Android text inbox. Receiving and sending
   may incur fees; registration and regional requirements must be checked before
   provisioning or enabling outgoing messaging.
3. **WhatsApp Business**, reuse the SMS provider boundary where appropriate,
   while retaining a separate connection identity and channel. Personal WhatsApp
   history is not supplied by this integration.

Stripe Projects catalog was checked. Twilio was listed for **email only**, not
SMS. No project initialized or email service provisioned for this messaging task.
Direct messaging-provider setup remains necessary.

## Implemented boundaries

`server/twilio-message-reader.mjs` uses pinned official Twilio SDK 6.1.1 signature
verification, including all form fields and the exact configured external URL.
It rejects duplicate form keys, mismatched provider accounts or receiving numbers,
mixed SMS/WhatsApp addresses, oversized/empty text, and media-only/attachment
messages. It returns only a bounded normalized observation, not an acknowledgement.
Status callbacks must use a separate endpoint. Signatures do not prevent replay:
the future host MUST journal MessageSid-based identity before HTTP success.

`server/slack-event-reader.mjs` verifies the raw-body HMAC and five-minute timestamp
window before parsing. It binds team/app/channel and supports signed URL challenges.
Simple human text messages only; bot events, edits and deletions are explicitly
unsupported. Do not enable this as a full-fidelity mirror until edit/deletion and
retention handling exists. Event IDs require durable duplicate suppression. A
valid signature alone does not authorize room sharing or automated actions.

The reader modules are **not HTTP routes or Inbox importers**. They intentionally do
not fabricate Telegram numeric IDs, silently claim success, or publish messages.
`server/twilio-inbox-import.mjs` now supplies provider-aware validation and atomic
private journal receipts. Its trusted host must hold a synchronous connection
registry lock through the transaction and provide a current account session.
It is not exposed through unauthenticated HTTP. Next: persistent connection
ownership and revocation, rate-limited webhook runtime, then provider onboarding.
Return provider success only after durable commit; failures must remain retryable.
There is no SMS/WhatsApp edit support (provider revision is fixed at zero).

### Durable SMS/WhatsApp permission checkpoint

`TwilioConnectionRegistry` now provides encrypted credentials, account-epoch and
revision checks, immutable receiving-address ownership, and persisted disconnect
tombstones. One connection selects one SMS or WhatsApp address. Reconfiguration
requires the current revision; old configuration cannot silently restore access.
The host must authenticate the account and verify provider ownership before
configuration. Address and account identifiers remain private database metadata;
the auth token and callback URL are encrypted. Host file security is still required.

`withGrant` holds the registry write lock through synchronous Inbox import, so
another registry handle cannot disconnect midway through that import. Disconnect
blocks subsequent deliveries, including duplicate signed retries. It clears local
encrypted credentials, not provider-side access, and retains already saved messages.
No HTTP webhook, provisioning UI, or live registry has been enabled. Next is the
bounded webhook host and authenticated connection controls, not a claim of live SMS.

### Bounded webhook factory (not enabled)

`createTwilioWebhookServer` now exercises signed HTTP delivery through the real
registry and private Inbox transaction. It returns empty TwiML only after import
or an exact duplicate receipt. It never sends a reply. Unknown paths, methods,
formats, oversized bodies and exhausted route limits are rejected. Signature,
authorization and storage failures return a generic non-success response without
credentials or message text. The fixed callback URL comes from the encrypted
registry, never the request Host or forwarding headers.

Limits: 100 configured routes, 64 connections, 8 KiB headers, 64 KiB body, five
seconds for body receipt, and 60 requests/minute/route by default. Limits are
process-local, not a distributed abuse-control system. A trusted host must supply
a current account session and locked connection grant. The factory is not wired
into `server.mjs`, and all HTTP tests run on disposable local databases. TLS,
provider configuration, deployment-wide rate limits, connection UI, background
authority and media support remain separate unfinished work. Invalid signed
content currently receives 503; provider retry/backoff and unsupported-media
handling need operational disposition before enabling a real webhook.

Fourteen messaging, mobile and cold-package checks passed. See
[Twilio incoming webhooks](https://www.twilio.com/docs/messaging/guides/webhook-request)
and [signature security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
for the provider contract (rechecked September 12, 2026).

### Account controls

The optional Room server now accepts a trusted `twilioConnections` service for
account-private status and revision-bound disconnect. Writes require the current
account cookie, session binding, CSRF token and same-origin checks; room/agent
bearer credentials do not qualify. Foreign connections and stale revisions fail,
and status does not return phone numbers, tokens or callback URLs. The service
is not constructed in production startup; browser controls and secure startup
configuration are still unfinished. HTTP controls plus cold packaging: 3/3 pass.

### Broader browser regression disposition

Superseding checkpoint: **bbed875** passed **317/317 full scripted browser tests**
and **1472/1472 Node tests**, zero skipped. This includes all earlier failure
groups after the request retry-lock fix, signed-out service Refresh repair,
narrow large-text wordmark repair, and visible sign-in/copy test updates.
Grok independently verified the recovery and quiet-copy fixes.

The following messaging-controls integration is newer than that full-suite
checkpoint: compact SMS/WhatsApp status/disconnect now lives under Inbox →
Connections. Unknown outcomes offer an explicit Refresh; late account responses
and stale-owner buttons are ignored. Credentials and receiving addresses do not
appear in these controls. Confirmed disconnect preserves already saved messages.
Five isolated client/UI checks, two integrated mobile Inbox checks and the
Telegram-controls/cold-packaging checks pass. Production startup still does not
construct a Twilio service or configure a live webhook. No provider was enabled.

Historical failure record (resolved at bbed875):

The full scripted browser run completed with 300/317 passing, 17 failing. Several
checks still assume the older expanded sign-in or old copy. A real composer bug
was also confirmed: attachment rendering overwrote the read-only state of an
unconfirmed request. `c0df06a` unifies that lock without relaxing retry assertions.
Do not describe the full browser suite as passing until all failures are resolved
and an exact candidate is rerun. Remaining groups include quiet-copy, room-door,
Inbox collaboration setup, email-label expectations and session-focus checks.

Run `npm run test:messaging` for signed readers, private import and mobile display;
run `npm run test:telegram` for the Telegram integration. All use disposable
fixtures except the explicitly reported manual local check.

## Verification

Checkpoint `968d639`: full Node suite **1465/1465 passed**, zero skipped;
messaging mobile/readers/import plus cold packaging **8/8 passed**; selected
accessibility/account-workspace/results browser checks **17/17 passed**.
Telegram **35/35 passed** before the additive SMS changes (Telegram import is
also included in the passing final Node suite). The full scripted browser suite
has not passed: its old sign-in setup was repaired across the scripts, but only
the selected browser groups above were reverified. No deployment performed.

Historical reader-only checkpoint:

Ten focused tests passed, covering Telegram plus Twilio/Slack signatures, tampering,
unknown-field coverage, duplicate parameters, channel/account isolation, expired
Slack requests, Telegram binding and transactional import rollback. Dependency
installation audit reported zero known vulnerabilities. Full suite not rerun.

## Primary sources

- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [Twilio messaging webhooks](https://www.twilio.com/docs/usage/webhooks/messaging-webhooks)

Reviewed September 12, 2026. Product-order choices above are engineering judgments,
not claims that onboarding, paid service eligibility or personal inbox mirroring
has been completed.
