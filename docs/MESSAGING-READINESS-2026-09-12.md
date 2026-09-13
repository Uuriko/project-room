# Messaging readiness — direct integrations

## Current state

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
