# OAuth2 Provider Endpoints

Project Room's OAuth2 authorization server (RFC 6749, RFC 7009, RFC 8414).
Foundation for the future Muse directory/partnership connector path.

The shippable integration today is the custom-connector brief at
`/connectors/muse.md` (scoped API keys, no OAuth). This provider exists
for the eventual directory listing, which requires OAuth per Meta's
partnership process.

## Scopes

- `rooms:read` — read room metadata and events
- `chat:read` — read messages
- `chat:write` — post messages
- `work:read` — read work items
- `work:write` — propose/accept/complete work

## Endpoints

### GET /oauth/authorize

Authorization endpoint. Validates the request and renders an HTML consent screen.
The user must be logged in (account session cookie). PKCE S256 required.

Query parameters:
- `client_id` (required)
- `redirect_uri` (required)
- `scope` (required, space-separated)
- `state` (optional, returned verbatim)
- `code_challenge` (required)
- `code_challenge_method` (required, must be `S256`)

On approval the browser POSTs to the same path; on denial redirects with
`?error=access_denied`.

### POST /oauth/authorize

Processes the consent decision. Form-encoded body:
- `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`
- `decision`: `allow` or `deny`

On `allow`: issues a single-use 10-minute authorization code, redirects to
`redirect_uri?code=...&state=...`. On `deny`: redirects with
`?error=access_denied`.

### POST /oauth/token

Token endpoint. Form-encoded body with `grant_type`:

**authorization_code:**
- `code`, `redirect_uri`, `client_id`, `code_verifier`

**refresh_token:**
- `refresh_token`

Returns `{ access_token, refresh_token, token_type: "Bearer", expires_in, scope }`.
Access tokens live 1 hour; refresh tokens 30 days and rotate on use.

> **Connector note (QA-Auth 2026-09-19):** OAuth access tokens are minted and
> validated at the provider level (introspection/revocation), but room API
> routes do not currently accept them as bearer credentials — a room route
> presented with an `oat_...` token answers 401. Third-party connectors use
> the scoped agent keys documented in `connectors/muse.md`. Wiring OAuth
> access tokens into room authorization is a tracked follow-up, not a
> property of this build.

### POST /oauth/revoke

RFC 7009 revocation. Form-encoded body: `token`. Revokes access or refresh
tokens. Unknown tokens return 200 per the RFC.

### GET /.well-known/oauth-authorization-server

RFC 8414 authorization server metadata.
