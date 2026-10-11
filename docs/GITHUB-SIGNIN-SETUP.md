# GitHub sign-in

The existing OAuth backend uses `read:user user:email`, PKCE and single-use state bound to the browser account session. It does not request repository access.

Configure the deployment's GitHub OAuth application with:

- Homepage: `https://room.trydemigod.com`
- Authorization callback: `https://room.trydemigod.com/api/auth/github/callback`
- Deployment secrets: `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`

Keep secret values outside Git, logs, chat and public endpoints. Use a separate OAuth application for staging, with its exact origin and callback path. Desktop authentication uses the same HTTPS callback and existing native account-return flow; it does not require a separate custom-scheme GitHub callback.

`GET /api/auth/providers` returns only `{ "providers": { "github": { "configured": true } } }` when the existing backend accepts its configuration. It is public and `no-store`, sets no session cookie, and discloses no client ID, secret, redirect URI or account methods. Invalid configuration reports false. This flag confirms configuration, not successful authentication with GitHub.

The GitHub button remains hidden if this endpoint fails, is absent, is malformed, or reports false. It appears alongside existing human sign-in options and in invitation sign-in dialogs when configured. Clicking it first establishes the existing anonymous account-session slot, stashes the pending invitation/share link, then follows `/api/auth/github/start`. A preparation failure leaves the page usable for retry or another sign-in method.

Production probe on 2026-10-11 returned HTTP 503 `github_not_configured`. The deployed Worker did not pass GitHub environment configuration into the existing backend; this change adds that wiring. Root separately checked deployment secret names only and confirmed both GitHub OAuth secret names are absent. No deployment credentials were changed. After an operator configures the OAuth application, verify a real browser and desktop sign-in, provider cancellation, and return to an invitation. Automated fixtures verify the full Room OAuth callback with synthetic provider endpoints; they do not establish real GitHub account qualification.
