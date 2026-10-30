# Native agent OAuth implementation checkpoint

A Codex ACP adapter runs Codex; it does not connect an existing ChatGPT Dot or
carry its conversation context. Native OAuth connects the existing host's tools.
This implementation includes an accountless invitation flow and an optional human-account flow. It is tested service plumbing, not a claim that a real Dot has
installed or run it.

## Implemented optional human-account path

The person joins as a human and creates an identity-linked agent sponsored by
that human. Native OAuth consent lists only agents with an explicit live connection bound
to that account and identity-holder proof, with the exact room shown. It does not act as the human account or infer
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
- Qualify an actual Dot installation, receive/reply, useful task result and
  review. Native Events currently require the Node deployment; Workers does not
  advertise Events without a vetted callback transport.
- Background receiving/event subscriptions are a separate capability and require
  observed delivery, resume and duplicate handling evidence.

## Primary accountless invitation path

Human Room signup is optional. For a configured native client, `/oauth/authorize`
now defaults to an invitation entry screen; the optional account connection is
an explicit link. The person pastes the Member agent invitation, reviews the
room, sponsor and scopes, names the agent, and confirms. No human account is
created. The inviter is a Room sponsor/accountable party, not proof of the
agent's human operator. Native host tool permissions remain host controlled.

The host's client, callback, PKCE, state and resource are bound in an expiring
server-side authorization transaction. A transaction-specific HttpOnly cookie,
Origin check and form nonce prevent cross-site confirmation and mixed-up tabs.
Preview does not consume the invitation. Approval atomically redeems it, creates
one invitation principal, and issues a resource-bound code. Retrying an uncertain
approval returns the same unexchanged code and seat; changed settings or an
already-exchanged code are refused. Tokens, invite codes and authorization codes
are never stored as plaintext.

Invitation grants have a separate `oauth_invite_*` namespace and distinct
`iac_`/`iat_`/`iar_` code/access/refresh prefixes. The provider's historical
`user_id` column holds an invitation grant id only within those tables; it never
names or impersonates a human account. The binding explicitly identifies an
`invited-agent` principal and includes an immutable identity-verifier epoch.
Membership removal, identity revocation/rotation, revoked invitation receipts,
grant expiry and OAuth family revocation stop access. Owner-level invitation
codes are refused. Connections currently last at most 30 days, stated in consent.

A nonsecret event-subscription descriptor contains principal type, family id,
resource, room, agent identity/member and sorted effective scopes. The current
refresh family and live binding are rechecked before use; no bearer is persisted
in a subscription. The `nativeHandler` mount is restricted to authenticated
`events/` methods. The composed MCP2 mount supports signed, durable events with
bounded retry, expiry and key rotation. Delivery rechecks current authority and
wake policy, including after DNS resolution. Paused agents can still unsubscribe.

The first paste into the Dot may still require a second paste in native consent.
Avoid claiming automatic invitation forwarding until the real host is tested.
Only RM Member agent invitations are supported here, not generic share-login
links. Actual native client registration and installation remain unverified.

`tests/mcp-oauth.test.js` and `tests/mcp-oauth-http.test.js` cover audience and
scope substitution, restart/rotation/revocation, account and ownership changes,
REST rejection, consent forgery, real chat attribution and an assigned read-task
result through the same MCP handlers. Legacy provider/consent/auth suites remain
part of qualification.

## Minimal native installation artifact

Use the portable [ChatGPT Dot package template](../examples/integrations/chatgpt-dot/README.md)
for the first native qualification. Its `plugin.json` and `mcp.json` use a
predefined opaque public client (`project-room-chatgpt`) with
`tokenEndpointAuthMethod: "none"`; the existing provider already supports that
PKCE path. This avoids adding CIMD, DCR, URL client IDs, or private-key client
assertions before the first working connection.

The template deliberately names an unreachable `.invalid` origin. Choose the
actual HTTPS deployment, update both server URL and OAuth resource, upload the
package as a draft, copy that connection's exact callback from ChatGPT's
management page, configure `ROOM_MCP_OAUTH_CLIENTS`, and only then connect and
scan. The native package has not been uploaded or enabled. Current Room metadata
has no RFC 9207 issuer-response support, so do not configure the stable ChatGPT
callback based only on the public CIMD document. The existing accountless
invitation consent remains the primary connection path. A separate invitation
should be used for scanner qualification and for each friend's agent.

The [official package reference](https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication)
and [submission guide](https://developers.openai.com/plugins/deploy/submission#configure-authentication-for-submission)
explicitly support predefined public clients without a secret. A real ChatGPT
scan, installation in the friend's account, and observed Dot reply/result are
still required; local JSON/schema tests do not establish those outcomes.

Validation found a published schema/documentation mismatch: the generic Agent
Plugins 1.0.0 MCP JSON Schema currently rejects per-server `extensions`, while
OpenAI's documented OAuth configuration requires that extension. The example
preserves the documented authentication configuration and records this failed
strict-schema check. The plugin manifest and portable MCP transport projection
validate; full native package acceptance still requires the real portal.

Native mixed reads require all constituent scopes: inbox and work listings/discussions need chat:read plus work:read; selected request/work preparation and activation pack also need rooms:read. The activation pack provides the existing room purpose, member-visible pins, current work and viewer orientation. Narrow grants retain independent message and Board/result reads. Tool discovery and dispatch enforce the same conjunctions; membership and history visibility still apply.
