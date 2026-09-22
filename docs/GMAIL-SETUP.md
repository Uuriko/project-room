# Gmail-first setup

New accounts see three optional steps: name and intended use; messaging-platform choices and Connect Gmail; then open the inbox. Progress and choices are account-owned and saved before OAuth. “Set up later” dismisses the guide; Manage inbox → Personalize setup reopens it. Existing completed accounts are not forced through setup. Guest invitations go straight to the room; adding a durable sign-in method makes personal setup available. Empty quarantine dashboards stay out of a new inbox. Outlook, Slack, Discord, Telegram and WhatsApp are preference choices labeled “coming later”, not grants or working consumer connections.

Gmail mailbox access is separate from Google sign-in. Connect Gmail starts Google account selection and consent with PKCE and `gmail.modify`. Previously saved read-only grants still read, but require reconnecting before sending or organizing email. The OAuth return imports the latest 25 inbox messages into the unified private inbox; Open Gmail provides a live provider view with Inbox, Starred, Sent, Drafts, All mail and Trash, Gmail search and older-page navigation.

The live Gmail workspace supports plain-text and sanitized rich-text compose, reply/reply-all using Reply-To and Gmail thread headers, forwarding with attachments, To/Cc/Bcc, save/reopen/update/delete of Gmail drafts, conversation display, send, archive, read/unread, star/unstar, trash and restore. Attachments can be uploaded, downloaded and retained across draft edits or forwarding: at most 20 files totaling 10 MiB per composed message. Rich email preserves semantic formatting and links; scripts, embedded forms, styles and remote images are removed. The sender is always the selected connected mailbox. Up to ten Gmail accounts can be linked and individually reconnected or disconnected.

`gmail_operations` durably reserves each mutation before contacting Google. Repeating a request never repeats its provider write. Unknown send/save receipts can be reconciled using the stable Message-ID in Sent or Drafts; absent evidence remains unknown. The journal stores fingerprints and provider receipts, not private message bodies. A changed Gmail draft ID blocks stale edits. Existing formatted drafts require explicit HTML and attachment review so unsupported clients cannot silently strip content.

Automatic sync runs on the canonical Worker's minute cron and the local server timer. Each sweep handles up to ten due mailboxes with failure backoff; a history tick fetches at most 200 changed IDs. Expired history reloads the 50 most recent inbox messages. Gmail read state, archive and deletion changes update the unified view. This is bounded history polling, not push delivery or a complete offline mailbox mirror. Open Gmail searches and pages the provider directly. The browser refreshes the visible list every minute while no composer is open. Disconnect removes credentials and stops synchronization; saved private copies remain.

**Beyond this checkpoint:** draft autosave, sender aliases, custom labels/spam controls, snooze/scheduled send, complete offline history, and Google verification for broad public Gmail access. Real-provider consent and live send validation remain separate from simulated-provider tests.

See [competitive design decisions](GMAIL-DESIGN-BENCHMARKS.md) for the source-backed comparison and acceptance criteria.

## Standing product requirements — John, 2026-09-22

The target is a fully functional Gmail client within a unified personal inbox. The recent-message reader was the first checkpoint; the live actions workspace is the next, not the accepted finished scope. Complete Gmail requires compose, send, reply/reply-all, forward, drafts, attachments, mailbox actions, search, older mail, reliable automatic synchronization, and account management.

Before designing or implementing the next inbox slices, compare the proposed experience with:

- **Superhuman:** email setup, reading and triage, compose/reply, keyboard speed, search, reminders/follow-ups, and how advanced features stay out of the way.
- **Unified messaging products:** apps that bring messages from multiple messaging platforms together. Research currently available products and their actual platform support; compare connection flows, unified vs. per-platform views, account switching, identity/thread handling, notifications, attachments, and reconnect/failure recovery.

Use current primary sources and, where accessible, hands-on product flows. Distinguish documented capabilities from observed behavior and from marketing claims. Record which patterns Project Room should adopt, adapt, or avoid and the reason. Evaluate the number of actions needed to connect and complete common tasks, clarity for a first-time user, everyday functionality, privacy, and cross-platform consistency. Preserve platform-specific capabilities where a generic interface would hide or break them.

Keep the user's desired experience central: a short, skippable setup questionnaire, a single connection action followed by the provider's required authentication/consent, and a simple inbox with full everyday functionality. Do not mistake a successful OAuth connection for a complete integration or present a planned platform as connected. Keep these comparisons in the implementation and acceptance criteria, not just a separate competitive report.

## Enablement (operator only)

The user-facing action remains unavailable until the service is configured:

1. Enable Gmail API in the Google project that owns the OAuth web client. Configure the consent screen for Gmail read, send and organize access (`gmail.modify`), and test users while the app is in testing. Broad public access requires Google's applicable restricted-scope verification.
2. Register the exact canonical redirect URI: `https://<ROOM_ORIGIN host>/api/auth/gmail/callback`. It is distinct from the existing Google sign-in callback. All entry Workers must continue using the canonical Room service.
3. Retain `ROOM_GOOGLE_CLIENT_ID` and `ROOM_GOOGLE_CLIENT_SECRET`. Supply `ROOM_GMAIL_TOKEN_KEY` as a cryptographically random 32-byte key encoded as 64 hex characters; store it as a deployment secret, not a checked-in variable. Set `ROOM_GMAIL_ENABLED=1` only with that configuration. Keep the encryption key stable across restarts and recovery; replacing it makes existing encrypted grants unreadable.
4. Until Google verifies the restricted scope, set `ROOM_GMAIL_PILOT_ONLY=1` alongside the existing `ROOM_OPERATOR_ACCOUNT_ID`. Set `ROOM_GMAIL_PILOT_ACCOUNT_ID` to use a specific pilot account without replacing the operator identity. Only the selected Room account can see or start Gmail connections; other accounts retain normal Google sign-in and setup. Remove the pilot restriction only after verification and live validation. Deploy the tested revision through the normal release procedure. In Cloudflare, invalid Gmail settings disable Gmail without preventing Room startup. Local boot uses the same explicit configuration.
5. Verify with an approved test account: complete setup, consent, see recent mail, repeat sync, disconnect, and verify no further mailbox reads or writes. Use deliberately addressed test messages to check live send/drafts and revoke/reconnect behavior. No real mailbox connection was made by the automated tests.

OAuth state and refresh grants use AES-256-GCM with context-bound authenticated encryption. Pending state expires after ten minutes, is consumed once, survives service restarts, and is cancelled by disconnect or a new authorization attempt. A short-lived HttpOnly SameSite=Lax flow cookie binds the Google return to the initiating browser; the account cookie stays Strict. Completion rechecks the initiating session before and after provider calls. Reads and writes require account sessions; writes require Origin and CSRF. The API never returns tokens. Account deletion removes grants and saved setup preferences. Disconnect deletes local credentials; Google’s app permission can also be removed in the user's Google Account.

Sources: [Gmail server authorization](https://developers.google.com/workspace/gmail/api/auth/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Earlier read-only checkpoint validation (2026-09-22)

- Full `node scripts/check.mjs`: 4,962 passed, 0 failed, 1 existing TODO. Includes source syntax, route docs, schema, lint, secret scan, wiki and the core suite.
- Latest Gmail guards: 10/10 targeted tests pass, including wrong-browser callbacks, revoked grants, account isolation, expiry, consent refusal, reconnect/disconnect races and deletion cleanup. Google sign-in regressions also pass.
- Inbox/setup/unified browser run: 90/90 pass. Account workspace/settings: 15/15. Guest/invitation/room lifecycle: 12/12. Latest setup/quarantine run: 5/5. Desktop and phone screenshots inspected in `test-results/gmail-setup/`.
- Recovery suite: 21/21 pass, covering all 89 tables and substantive encrypted Gmail/setup rows. Release packaging and empty-state checks: 13/13 pass.
- Final browser-cookie and quiet-empty-inbox refinements were verified with their focused suites after the full check. No live provider credentials or mailbox data were used.

## Live-actions checkpoint validation (2026-09-22)

- Full `node scripts/check.mjs`: 4,970 passed, 0 failed, 1 existing TODO; syntax, route/schema checks, lint, secret scan, recovery and release packaging passed. Recovery covers all 90 tables, including the operation journal.
- Final Gmail service/OAuth tests: 18/18. Includes consent upgrades, threaded draft sends, CC/BCC, duplicate and concurrent request handling, uncertain receipts across service restart, changed/unsupported drafts, session/disconnect fencing, CSRF, account isolation and deletion.
- Inbox/unified/Gmail browser regression: 89/89. Setup plus Gmail focused run: 23/23. Final desktop/mobile Gmail scenarios: 2/2, extended after the broad run to cover lost HTTP send acknowledgements and cross-tab sign-out clearing both reader and unsaved composer.
- Final changed-module lint and `git diff --check` passed. Updated phone/desktop screenshots inspected in `test-results/gmail-workspace/`.
- Provider behavior is tested with an in-process stateful Gmail double. No real outbound email, live OAuth, deployment or Google Console change was performed. Production quotas, provider behavior, verification and live account compatibility remain to validate.

## Google configuration observed 2026-09-22

Project `project-room-508502` already has Gmail API enabled. The existing production Project Room OAuth client now includes `https://room.trydemigod.com/api/auth/gmail/callback`, preserving its Google sign-in callback. The consent declaration now includes existing sign-in scopes and `gmail.modify`, with the Email client use case and justification. Google reports External / In production, Gmail scope unverified, and 1 of 100 unverified users consumed. No end-user mailbox permission was granted by these configuration changes.

Broad public Gmail rollout still requires the verification process, including the requested demo video and any further Google requirements. Keep the operator-only pilot enabled while completing that process. Never change the existing OAuth application back to testing merely to test Gmail: it also serves existing Room sign-ins.
