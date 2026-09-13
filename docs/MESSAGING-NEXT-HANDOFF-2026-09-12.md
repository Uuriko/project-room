# Messaging: next delivery handoff

Local checkpoint: client `2bfc108`, isolated grant layer `17d9e31`; existing
startup `07c7d80`, failure tests `5ea28ec`. This document does
not authorize provider setup, spending, publishing, deployment or shared-tree edits.
Check the bus and board before claiming files. Preserve unrelated dirty files.

## What is actually available

Telegram has a real two-message manual bot pilot, not personal-account mirroring
or continuous delivery. Its durable receiver, encrypted stores and account controls
are tested but not enabled in that pilot. SMS and WhatsApp Business have signed
receive-to-private-Inbox and disconnect flows tested with fixtures, not a live
number. Gmail's previously imported 25 messages do not prove outbound email.

Fresh focused checks: Telegram 35/35; messaging 27/27. Last complete browser run
was `bbed875` (317/317); later UI has focused browser checks. See
[inventory](RELEASE-INVENTORY.md) and [readiness](MESSAGING-READINESS-2026-09-12.md).

## Work in order

1. **Receive-only background grant.** An isolated durable implementation exists
   at `17d9e31`; review and integrate it rather than starting another authority
   store. See [boundaries and tests](MESSAGING-RECEIVE-GRANTS-2026-09-12.md).
   It pins account, connection revision, provider, expiry and revocation; the
   provider registry must additionally bind chats/receiving address. Do not manufacture a human
   login session for a daemon. Receiving must not imply sending, room sharing,
   agent access or permission to fetch arbitrary conversation history. Check the
   existing Claude research request before duplicating it.
2. **Local receiving-runtime wiring.** Reuse the current Telegram queue/receiver
   and Twilio webhook factory. Test restart, revoked grants during delivery,
   expired sessions, duplicate retries and failure after persistence. Keep any
   missing configuration disabled, not partially connected. Do not change the
   current live pilot while testing disposable runtimes.
3. **Provider failure policy.** Resolve permanently unsupported media versus
   transient storage failures before live exposure. Never acknowledge a message
   as imported when it was dropped. Bound retries and report actionable failures
   without logging private bodies or credentials.
4. **Controlled real receive pilot.** Once setup is authorized and prerequisites
   exist, verify one real message reaches only its owner's Inbox; restart and
   replay do not duplicate it; disconnect blocks subsequent delivery. Record the
   actual receiving number/bot privately. Do not describe SMS as phone-history
   synchronization or WhatsApp Business as personal WhatsApp mirroring.
5. **Explicit replies.** Separate outbound authority, recipient preview,
   duplicate-send prevention and delivery receipts. A successful receive test
   is not an outbound-send qualification. No automatic room/agent sharing.
6. **Slack next.** The signed parser alone is not an integration. Add durable
   account-scoped ingestion and lifecycle before installing it. HTTP Events and
   Socket Mode require different authentication envelopes; do not reuse one as
   the other. Use only selected conversations.

Keep one quiet Connections section. Do not add a grid of non-working provider
buttons or label configured credentials as a verified connection.

## Repository coordination snapshot

Read-only GitHub inspection found these open items; reported PR tests are not
independently verified by this handoff and none was merged here:

- [#131](https://github.com/Uuriko/project-room/pull/131): agent packet After paste
  guidance; review before duplicating discovery instructions. Separate from Inbox.
- [#26](https://github.com/Uuriko/project-room/pull/26): draft bounded OpenAI reply
  integration. Not evidence of a live background agent or messaging send grant.
- [#6](https://github.com/Uuriko/project-room/issues/6): consumer/enterprise
  readiness backlog. Local green messaging tests do not close device, SSO/SCIM,
  tenant isolation, restore, retention or production operations requirements.
- [#11](https://github.com/Uuriko/project-room/issues/11): historical coordination
  mailbox. Current bus/board claims and current user authority take precedence.

Other sampled drafts (#7, #9, #16–18, #22) are historical roadmap, harness,
contribution or skeleton work; do not treat their status as current integration
qualification. This snapshot is not an exhaustive all-author PR/CI audit.
