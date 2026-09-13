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

Configuration factory: `server/gmail-runtime.mjs` accepts all three opt-in paths:
`ROOM_GMAIL_CLIENT_FILE`, `ROOM_GMAIL_KEY_FILE` (32 raw bytes), and
`ROOM_GMAIL_VAULT_FILE`. It refuses partial configuration, source-tree secrets,
symlinked secret files, non-owner/private file modes, wrong redirect URIs, non-private
vault directories, and existing non-vault database tables. It creates no encryption
key and makes no network requests. Five tests cover private opening/reopening and
rejection paths using disposable synthetic credentials. The Node server now calls this
factory only when at least one Gmail configuration variable is supplied, and closes its
vault on shutdown. Partial configuration fails startup rather than silently disabling it.

Packaging now includes the six Gmail/vault modules and callback asset, while retaining
historical asset lists for revisions without Gmail. The sole allowed bare import is
`postal-mime` in the Gmail normalizer; version, registry URL, integrity hash and lack of
transitive dependencies are verified against the locked declaration. The artifact is a
source package, not an installed runtime: run `npm ci --omit=dev --ignore-scripts` in a
separate runtime copy after verifying the source package. Installed `node_modules` are
not covered by the source-tree verifier. A disposable candidate runtime installed from
the lock passed module loading, MIME parsing, Node server startup, and disabled-Gmail
503 behavior outside the development checkout. No private credentials were used.

Lifecycle checkpoint: `server/gmail-connections.mjs` now joins the OAuth boundary,
credential vault and page reader to the existing account-private Inbox import.
Tests exercise consent exchange, encrypted storage, reading/import, reconnect,
stale callbacks, concurrent scans and disconnect during an in-flight read with mocked
Google responses. Real accounts begin at authorization epoch zero; the new modules
now match that invariant. Session bindings and account epochs come from the store.
Source revision preconditions are captured before fetching so concurrent changes cannot
be silently overwritten. Failed configuration can leave an inert unmatched vault
revision; reads require a matching active import connection. Cross-database crash
recovery still needs operational testing, not an atomicity claim.

Still not live: production bootstrap/configuration, concise Inbox UI, external key provisioning and private
database file permissions, Google-side revocation, durable worker scheduling,
runtime dependency packaging, and real-user consent/testing. The existing importer’s
legacy `mode: fixture` marker is not an assertion of live connectivity; it must be
reconciled before public UI claims. Token renewal is implemented with narrow-scope
validation, refresh-token rotation/preservation, shared in-flight requests and vault
version checks. Session/connection authority is checked again before saving refreshed
credentials; disconnect during renewal cannot restore them. Renewal failure fails closed.

Storage checkpoint: `server/mail-credential-vault.mjs` now provides AES-256-GCM
credential encryption in a separate caller-supplied SQLite database. The key is supplied
externally and is not written by the module. Account, connection, epoch, mailbox and
version are authenticated with the ciphertext. Compare-and-swap updates and disconnect
tombstones reject late refreshes; reconnect requires a newer connection revision.
The module does not itself authorize callers, provision a key, revoke Google grants,
erase backups, or wire the Inbox. Host lifecycle integration remains required.

1. Optional account-authenticated, CSRF-protected start/complete/sync/disconnect routes
   are implemented under `/api/inbox/connections/gmail/`, activated only when a host
   supplies `gmailConnections` to `createRoomServer`. A GET callback serves inert HTML
   without exchanging consent or reflecting query values. Its same-origin script clears
   the query from browser history, obtains the existing account session, and completes
   through a CSRF-protected POST. Strict account cookies remain unchanged. A Chromium
   test verifies callback completion and history cleanup; route tests cover missing
   authority, cross-origin/CSRF rejection, and sanitized errors. Host bootstrap, Inbox
   connect controls, and real Google callback acceptance remain to be completed.
2. Store tokens privately using authenticated encryption with keys outside the database
   and repository. Serialize connection writes; verify epoch/revision again at persistence.
   Implement refresh, disconnect/revocation, restart recovery, and deletion semantics.
3. Gmail normalization now exists in `server/gmail-email.mjs`, using pinned `postal-mime`
   3.0.0 with a 1 MiB raw-message limit, bounded MIME depth/headers, no inline expansion
   of attached emails, and no attachment bytes in the resulting envelope. The shared
   email contract accepts Gmail, while Graph-specific boundaries explicitly reject it.
   A fixture integration test proves import into private Inbox and draft retention after
   disconnect without room events. Live network synchronization and its HTTP/UI wiring
   remain incomplete. Large-message fallback and attachment retrieval remain pending.
   Never disguise Gmail as Graph, reuse fixture send transport, or publish mail into room events.

   Reader checkpoint: `server/gmail-mail-reader.mjs` now fetches a bounded page
   (up to 25 messages) from fixed Gmail endpoints, checks mailbox identity first,
   rechecks account/epoch/connection authorization before and after each response,
   and normalizes complete RAW messages. Failures discard the page rather than
   silently advancing its cursor. Page tokens cannot become URLs or extra query
   parameters. A mocked-provider-to-real-Inbox test verifies the import seam.
   This is a page scanner, not a Gmail history/delta implementation or a consistent
   mailbox snapshot. Host must persist cursor and source revision preconditions
   atomically, serialize scans, refresh credentials, and recheck authority at commit.
   No actual mailbox has been read and no HTTP route calls this reader yet.
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
- [Gmail message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [PostalMime parser and security limits](https://github.com/postalsys/postal-mime)

OAuth verification and testing constraints must be rechecked before public release.
