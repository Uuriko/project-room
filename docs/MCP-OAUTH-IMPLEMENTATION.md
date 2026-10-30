# Native agent OAuth implementation checkpoint

This is an implementation checkpoint, not installation instructions or a claim
that ChatGPT Dot currently connects. A Codex ACP adapter runs Codex; it does not
carry an existing Dot's identity or conversation context.

The friend must join as a human, then explicitly connect an agent sponsored by
that human. The OAuth consent must select that exact agent and room. An agent
invitation's issuer must never silently become the friend's accountable human.

## Implemented foundation

`server/oauth-provider.mjs` supports optional resource-bound agent grants. A
binding contains the exact HTTPS resource URL, room, agent identity, agent member,
and accountable human member. Code exchange and refresh require the same
resource; access verification without that audience fails. The binding survives
SQLite persistence and refresh rotation. Existing desktop account grants remain
separate and cannot be upgraded to agent grants.

`server/mcp-oauth.mjs` provides metadata/challenge builders and a principal
resolver. It verifies the live account, human account membership, agent identity
link, active human and agent memberships, accountable human, requested room,
audience and requested OAuth scopes. It returns a principal, never an identity
secret. Each actual operation must additionally enforce ordinary Room command
permissions and privacy rules.

## Required before native installation can be advertised

1. Verified client registration/callback metadata from the actual host. Do not
   invent a ChatGPT callback or accept arbitrary redirects. The existing provider
   supports predefined clients; deployment must configure real client metadata
   or implement a separately reviewed standards-compliant registration path.
2. Friend-sponsored enrollment lifecycle and explicit consent agent selection.
   Validate the binding before code issuance, not only at tool invocation.
3. Shared HTTP discovery/authorization/token routing must pass the resource and
   server-validated binding. Current HTTP routes do not yet do this.
4. MCP dispatch and RoomStore authentication must accept bounded OAuth principals
   and intersect scopes with live member permissions. Do not replace an OAuth
   token with a broad saved identity secret or act as its human account.
5. Mount resource metadata and challenges only with that operational flow. The
   helper builders alone do not make an OAuth endpoint usable.
6. Verify HTTP and Cloudflare parity, then one real Dot connect/read/reply/work
   result/review. Background events/listening require separate observed evidence.

The current foundation intentionally does not advertise or enable this unfinished
OAuth installation path. `tests/mcp-oauth.test.js` covers audience substitution,
omitted audience, scope/room escalation, durable rotation/restart, revocation,
account deletion, human/agent removal, ownership and identity replacement, and
legacy account-grant substitution.
