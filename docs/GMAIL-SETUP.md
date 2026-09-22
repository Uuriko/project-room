# Gmail-first setup

New accounts see three optional steps: name and intended use; messaging-platform choices and Connect Gmail; then open the inbox. Progress and choices are account-owned and saved before OAuth. “Set up later” dismisses the guide; Manage inbox → Personalize setup reopens it. Existing completed accounts are not forced through setup. Guest invitations go straight to the room; adding a durable sign-in method makes personal setup available. Empty quarantine dashboards stay out of a new inbox. Outlook, Slack, Discord, Telegram and WhatsApp are preference choices labeled “coming later”, not grants or working consumer connections.

Gmail mailbox access is separate from Google sign-in. Connect Gmail starts Google account selection and consent with PKCE and only `gmail.readonly`. The return imports up to 25 recent INBOX messages. “Sync Gmail” repeats that bounded import without duplicate sources. This is an initial recent-mail reader, not full mailbox synchronization: no background polling, historical pagination, sending, Gmail read-status writes, deletion propagation, or attachment downloads. Saved copies remain after disconnect. One Gmail mailbox per account; disconnect before choosing a different mailbox. Existing advanced fixture and Telegram-bot controls remain under Advanced connections.

## Standing product requirements — John, 2026-09-22

The target is a fully functional Gmail client within a unified personal inbox. The read-only recent-message implementation below is an initial checkpoint, not the accepted finished scope. Complete Gmail requires compose, send, reply/reply-all, forward, drafts, attachments, mailbox actions, search, older mail, reliable automatic synchronization, and account management.

Before designing or implementing the next inbox slices, compare the proposed experience with:

- **Superhuman:** email setup, reading and triage, compose/reply, keyboard speed, search, reminders/follow-ups, and how advanced features stay out of the way.
- **Unified messaging products:** apps that bring messages from multiple messaging platforms together. Research currently available products and their actual platform support; compare connection flows, unified vs. per-platform views, account switching, identity/thread handling, notifications, attachments, and reconnect/failure recovery.

Use current primary sources and, where accessible, hands-on product flows. Distinguish documented capabilities from observed behavior and from marketing claims. Record which patterns Project Room should adopt, adapt, or avoid and the reason. Evaluate the number of actions needed to connect and complete common tasks, clarity for a first-time user, everyday functionality, privacy, and cross-platform consistency. Preserve platform-specific capabilities where a generic interface would hide or break them.

Keep the user's desired experience central: a short, skippable setup questionnaire, a single connection action followed by the provider's required authentication/consent, and a simple inbox with full everyday functionality. Do not mistake a successful OAuth connection for a complete integration or present a planned platform as connected. Keep these comparisons in the implementation and acceptance criteria, not just a separate competitive report.

## Enablement (operator only)

No deployment or Google Console change is performed by this change. The user-facing action remains unavailable until the service is configured:

1. Enable Gmail API in the Google project that owns the OAuth web client. Configure the consent screen for Gmail read access, and test users while the app is in testing. Broad public access requires Google's applicable restricted-scope verification.
2. Register the exact canonical redirect URI: `https://<ROOM_ORIGIN host>/api/auth/gmail/callback`. It is distinct from the existing Google sign-in callback. All entry Workers must continue using the canonical Room service.
3. Retain `ROOM_GOOGLE_CLIENT_ID` and `ROOM_GOOGLE_CLIENT_SECRET`. Supply `ROOM_GMAIL_TOKEN_KEY` as a cryptographically random 32-byte key encoded as 64 hex characters; store it as a deployment secret, not a checked-in variable. Set `ROOM_GMAIL_ENABLED=1` only with that configuration. Keep the encryption key stable across restarts and recovery; replacing it makes existing encrypted grants unreadable.
4. Deploy the tested revision through the normal release procedure. In Cloudflare, invalid Gmail settings disable Gmail without preventing Room startup. Local boot uses the same explicit configuration.
5. Verify with an approved test account: complete setup, consent, see recent mail, repeat sync, disconnect, and verify no further mailbox reads. No real mailbox connection was made by the automated tests.

OAuth state and refresh grants use AES-256-GCM with context-bound authenticated encryption. Pending state expires after ten minutes, is consumed once, survives service restarts, and is cancelled by disconnect or a new authorization attempt. A short-lived HttpOnly SameSite=Lax flow cookie binds the Google return to the initiating browser; the account cookie stays Strict. Completion rechecks the initiating session before and after provider calls. Reads and writes require account sessions; writes require Origin and CSRF. The API never returns tokens. Account deletion removes grants and saved setup preferences. Disconnect deletes local credentials; Google’s app permission can also be removed in the user's Google Account.

Sources: [Gmail server authorization](https://developers.google.com/workspace/gmail/api/auth/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Validation receipt (local, 2026-09-22)

- Full `node scripts/check.mjs`: 4,962 passed, 0 failed, 1 existing TODO. Includes source syntax, route docs, schema, lint, secret scan, wiki and the core suite.
- Latest Gmail guards: 10/10 targeted tests pass, including wrong-browser callbacks, revoked grants, account isolation, expiry, consent refusal, reconnect/disconnect races and deletion cleanup. Google sign-in regressions also pass.
- Inbox/setup/unified browser run: 90/90 pass. Account workspace/settings: 15/15. Guest/invitation/room lifecycle: 12/12. Latest setup/quarantine run: 5/5. Desktop and phone screenshots inspected in `test-results/gmail-setup/`.
- Recovery suite: 21/21 pass, covering all 89 tables and substantive encrypted Gmail/setup rows. Release packaging and empty-state checks: 13/13 pass.
- Final browser-cookie and quiet-empty-inbox refinements were verified with their focused suites after the full check. No live provider credentials or mailbox data were used.
