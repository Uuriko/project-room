# Gmail pilot connection checkpoint

## Verified setup

- Isolated Google Cloud project: `project-room-508502` (Project Room).
- Gmail API status: Enabled, verified in Google Cloud console.
- OAuth app: External / Testing, one test user added (John's selected mailbox).
- Web client: Project Room Gmail — local pilot.
- Authorized redirect: `http://127.0.0.1:4173/api/inbox/connections/gmail/callback`.
- Downloaded client credentials remain outside the repository with owner-only permissions.
- Existing Grok Cloud project unchanged. No mailbox data read, messages sent, or deployment performed.

## Code added

`server/gmail-oauth.mjs` is a server-only OAuth boundary, **not yet wired into HTTP or Inbox**.
It requests only `gmail.readonly`, uses random single-use state and PKCE S256,
expires attempts after ten minutes, binds attempts to account/session/connection revision,
rechecks authority across network calls, rejects unexpected scopes, and checks the selected
mailbox against Google's profile response. Login hints alone are not identity verification.
Provider endpoints are fixed; redirects are refused; responses have time/size limits;
provider error bodies and credential-bearing errors are not forwarded.

Tokens are returned to the trusted caller only, never written to disk by this module.
The host must not return that object to the browser, room events, diagnostic logs, or agents.
The module reads only the mailbox profile after consent, not messages. It grants no sending capability.

## Required next integration (not complete)

Storage checkpoint: `server/mail-credential-vault.mjs` now provides AES-256-GCM
credential encryption in a separate caller-supplied SQLite database. The key is supplied
externally and is not written by the module. Account, connection, epoch, mailbox and
version are authenticated with the ciphertext. Compare-and-swap updates and disconnect
tombstones reject late refreshes; reconnect requires a newer connection revision.
The module does not itself authorize callers, provision a key, revoke Google grants,
erase backups, or wire the Inbox. Host lifecycle integration remains required.

1. Add account-authenticated, CSRF-protected start route and callback handler with fresh
   server-derived account epoch/session/connection revision. Never accept these bindings
   from browser JSON. Do not log callback query strings; return a clean same-origin redirect
   with no third-party resources and `no-store`/`no-referrer` headers.
2. Store tokens privately using authenticated encryption with keys outside the database
   and repository. Serialize connection writes; verify epoch/revision again at persistence.
   Implement refresh, disconnect/revocation, restart recovery, and deletion semantics.
3. Implement Gmail normalization and bounded synchronization into the existing account-private
   Inbox. Current email contract supports Microsoft Graph, not Gmail. Do not disguise Gmail
   as Graph, reuse fixture send transport, or publish mail into room events.
4. Present Google's actual read-only consent screen to John. No broad Gmail modify/delete
   permission is needed for the first reading pilot. Sending requires its own scoped flow,
   exact reviewed recipients/content, and durable outcome/retry handling.
5. Test real receive privately after consent. Verify disconnect prevents further access,
   reconnect does not revive old grants, and no email body leaks into shared activity.
6. Before public launch: production redirect/client, privacy policy/branding, Google's
   applicable restricted-scope verification requirements, operational token protection,
   and per-account consent. Testing is not production readiness.

## Sources

- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

OAuth verification and testing constraints must be rechecked before public release.
