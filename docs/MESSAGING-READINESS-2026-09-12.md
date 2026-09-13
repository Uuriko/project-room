# Messaging readiness — direct integrations

## Current state

| Service | Verified now | Remaining before usable connection |
| --- | --- | --- |
| Telegram bot | Real private receive/import and browser rendering; duplicate-safe manual retry | Durable offset, connection lifecycle, background receiver, replies |
| SMS | Signed Twilio inbound text verification and normalization tested | Messaging account and receiving number, public HTTPS callback, durable Inbox ingestion, connection controls |
| WhatsApp Business | Same Twilio signature boundary supports WhatsApp-prefixed addresses | Sender/business onboarding or sandbox, callback and durable ingestion |
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

These modules are **not HTTP routes or Inbox importers**. They intentionally do
not fabricate Telegram numeric IDs, silently claim success, or publish messages.
Next: provider-aware source validation in the private Inbox journal and recovery,
atomic receipt handling, account-bound connection ownership, then actual runtime.

## Verification

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
