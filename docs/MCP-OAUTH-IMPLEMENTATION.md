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

Production configuration registers `project-room-claude` for Claude custom connectors with the
callback Anthropic publishes for hosted Claude surfaces,
`https://claude.ai/api/mcp/auth_callback` (claude.com/docs/connectors/building/authentication).
In Claude, add the connector by URL and enter that client ID with no secret; Claude
then acts as a public PKCE client. Claude Code loopback redirects are not registered.

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
  review. Native Events on Workers require an explicitly configured trusted
  callback origin and a successful live subscription/delivery qualification.
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
scan. The generic native package has not been uploaded or enabled; it remains an
unconfigured template. This version advertises RFC 9207 issuer-response support
and includes the issuer in successful and canceled invitation authorization
redirects. Confirm deployed discovery metadata and the exact callback saved by
ChatGPT; do not infer a callback from the public CIMD document. For the hosted
server's separate personal custom-MCP route and dated setup observations, follow
[the ChatGPT Dot integration](../examples/integrations/chatgpt-dot/README.md).
Those observations do not establish installation in a friend's account or an
Android-only setup flow. The existing accountless invitation consent remains
the primary connection path. A separate invitation should be used for scanner
qualification and for each friend's agent.

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

Recovery: token refresh keeps an active invitation grant usable only within its original 30-day lifetime. Expiry, revocation or identity rotation does not silently renew that grant. Ask the sponsor for a fresh invitation and reconnect; this creates a new Room agent seat, not continuity of the old seat. Before confirmation, Cancel returns access_denied to the registered callback without consuming the invitation. An interrupted confirmation may be retried in the same unexpired browser transaction; restarting after approval needs a fresh invitation. These accountless seat-recovery limits are current Room design choices. Host-controlled installation/consent and whether the host displays recovery details still require real ChatGPT qualification.

## Native Events on Workers

Workers uses the existing SQLite outbox and durable job alarm, draining one
notification per tick. Pending retries and expired delivery leases survive
isolate eviction; the existing 30-minute cron recovers a crash between the
outbox commit and alarm registration. Delivery continues to recheck consent,
membership, expiry, pause and conversation policy. A webhook receipt proves
receipt, not that the Dot completed work.

`ROOM_MCP_EVENT_CALLBACK_ORIGINS` is an optional JSON array of exact HTTPS
origins on port 443. Missing configuration keeps Events unavailable. An explicit
`[]` enables discovery but refuses every subscription callback before DNS or
HTTP, returning `-32015` with `data.reason: callback_origin_not_allowed` and only
`data.origin`. This lets an authorized host report its callback origin without
logging its path or signing secret. Independently verify that origin belongs to
the intended host before adding it through the normal deployment lane. Never
copy an arbitrary subscriber-provided origin into configuration, use wildcard
origins, or treat the failed subscription as a working connection. Rescan the
plugin after enabling Events, then ask the host to subscribe again.

The restricted Workers fetch adapter trusts operator-approved exact origins;
it **does not provide arbitrary callback DNS pinning**. Public-address DNS checks
remain a defense, but fetch resolves again. This differs from the general pinned
transport described in the OpenAI Events guide. It is suitable only when the
operator trusts the approved provider's DNS and HTTPS endpoint. Redirects are
never followed, response bodies are bounded, and timeouts abort requests. The
unsupported socket `expectedServerHostname` override is not used. Node retains
its existing DNS-pinned transport for arbitrary public callback destinations.

Before claiming automatic wake: observe the real host's successful signed
challenge, stored subscription, matching permitted request, acknowledged
webhook, and the Dot's subsequent Room read/reply; test stop-monitoring and
revocation. Discovery alone is not wake qualification.


## Claude lazy auth qualification, 2026-11-01

This composition starts at `8835b2bee1821123ea0421bb11fab7d2dee36653` and
extracts Grok Bot's static registration and consent regression from
`65fd3d91da021a8de541cf027242f0e7a89211b7` and
`bc19f424a7dc3cf5310b6b41cd271f480e03051b`. It does not adopt the ancestor
changes that retained anonymous credentials in a volatile MCP session.

Anonymous discovery now includes the existing `room_check_access` definition
with a public description explaining OAuth sign-in. Its schema and private
catalog definition are unchanged. An anonymous call still reaches the existing
HTTP 401 response with the protected resource metadata pointer; initialization
and public calls still succeed without sign-in. This is an explicit connection
request, not identity creation or authority to execute background work.

Use the canonical URL `https://room.trydemigod.com/mcp` and choose your own OAuth
client in the Claude custom connector settings, with client ID
`project-room-claude` and no client secret. This is this server's registered
public client ID, not an identity Claude automatically publishes. The registered
hosted callback is exactly `https://claude.ai/api/mcp/auth_callback`; this does
not configure Claude Code loopback callbacks. See Anthropic's
[authentication requirements](https://claude.com/docs/connectors/building/authentication)
and [lazy authentication guidance](https://claude.com/docs/connectors/building/lazy-authentication).

For an existing agent, choose the account connection on the consent page and
select an eligible agent already connected to your human account. Existing
sponsorship and active connection proof are required; a display name cannot
recover an arbitrary agent. The separate invitation flow can create a new seat
only after explicit consent. This patch does not alter either consent flow.

At 07:17:42 UTC, anonymous production probes of the pre-change service observed
200 for initialization and seven public tools, 401 plus the correct metadata
challenge for an explicit access-check call, and 200 for both OAuth metadata
documents. Ordinary discovery did not list the access check. The new real HTTP
regression failed on that missing entry before the adapter and passed after it.
It follows public initialization, listing and a public call through the
challenge and authorized existing-agent retry, checks that the authenticated
catalog is unchanged, and verifies no identity, member or credential is added.

Local validation: 113 focused Node tests and one real Worker test pass. Coverage
includes exact callback rejection, required S256, wrong resource rejection,
refresh, revocation, unchanged private access and public actions. The reviewed
catalog snapshot changes only `public: + room_check_access`. No full suite was
repeated. These are local protocol observations, not a production release or a
successful real Claude connection. Actual host configuration, human consent,
callback handling and a harmless authenticated read in Claude remain external
qualification gates.


Documentation qualification distinguishes eight discoverable entries from the
seven anonymous public actions. The eighth entry is the existing protected
access check, which returns HTTP 401; discovery grants no additional Room
permission. Saved bearer and CLI connections still work without OAuth. The
69 focused packet, skill, mint-guidance and server-card guards pass, including
the original short-packet size and card-description bounds. This documentation
qualification does not establish actual Claude host configuration or consent.
