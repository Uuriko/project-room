# Native agent OAuth implementation checkpoint

A Codex ACP adapter runs Codex; it does not connect an existing ChatGPT Dot or
carry its conversation context. Native OAuth connects the existing host's tools.
This implementation is tested service plumbing, not a claim that a real Dot has
installed or run it.

## Implemented optional human-account path

The person joins as a human and creates an identity-linked agent sponsored by
that human. Native OAuth consent lists only that account's currently sponsored
agents, with the exact room shown. It does not act as the human account or infer
ownership from the invitation issuer. Friend-sponsored enrollment requires the
separate agent-connections lifecycle implementation.

The shared HTTP server accepts explicitly configured `mcpOAuthClients` entries
using the existing provider's exact registered redirect matching and PKCE S256.
Cloudflare reads the same list from JSON `ROOM_MCP_OAUTH_CLIENTS`. The list is
empty by default: no guessed client IDs, callbacks or advertised native install.
Configured clients enable `/.well-known/oauth-protected-resource/mcp` (root alias
also provided), OAuth consent with agent selection, form-encoded token exchange,
and MCP 401 resource metadata challenges. The canonical resource is the configured
HTTPS origin plus `/mcp`; callbacks must use that exact resource during code
exchange and refresh.

Grants persist the account, exact resource, room, agent identity/member and human
member. A revoked grant, inactive account/member, changed ownership, invalid
connection authority, expired connection or revoked connection key fails closed.
Existing desktop account grants remain separate and cannot be upgraded to agent
grants. SQLite persistence and refresh rotation preserve the full binding.

MCP dispatch uses request-local authentication: an OAuth token is accepted only
inside its MCP request context, not through REST or account endpoints. Each
operation rechecks live binding, normal Room authorization and privacy. The
allowlisted catalog includes scoped chat reads/replies and assigned work
accept/start/block/claim/text-result tools. It excludes wrapper dispatch, global
identity creation, agent invitations and administrative tools. OAuth scope never
adds Room permissions. No surrogate identity secret is minted or exposed.

## Remaining deployment and product work

- Configure verified native-host client/callback information, or implement a
  separately reviewed standard client registration path. Do not guess callbacks.
- Compose friend-sponsored enrollment and the native connection UI; test the
  actual non-owner friend path with its ownership lifecycle.
- Qualify Cloudflare execution and an actual Dot installation, receive/reply,
  useful task result and review. Node HTTP tests do not establish these facts.
- Background receiving/event subscriptions are a separate capability and require
  observed delivery, resume and duplicate handling evidence.

## Accountless invitation path

Human Room signup is optional in the product target. The path above remains an
optional way to bind a verified Room account; it is not a requirement for every
native connection. An accountless invite grant needs a separate explicit
principal type and a receipt-bound lifecycle, not a synthetic human account or
an OAuth token impersonating the invitation issuer.

The lowest-assumption native flow is an invitation input on the OAuth consent
page, beside optional account sign-in. It preserves the host's ordinary client,
PKCE, state and callback exchange. A dedicated one-time enrollment transaction
must validate and atomically redeem the invite only after consent, and bind the
new agent identity/member to the exact client and resource. Reconnect reuses the
same grant family. The invitation issuer is the sponsor; the agent's controller
must remain explicitly unverified until separately proven. A smoother prefilled
handoff depends on documented native-host installation parameter support and
must not rely on an unbound last-invitation browser cookie.

`tests/mcp-oauth.test.js` and `tests/mcp-oauth-http.test.js` cover audience and
scope substitution, restart/rotation/revocation, account and ownership changes,
REST rejection, consent forgery, real chat attribution and an assigned read-task
result through the same MCP handlers. Legacy provider/consent/auth suites remain
part of qualification.
