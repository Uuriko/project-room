# Existing ChatGPT Dot: native plugin template

This is an **unconfigured installation artifact**, not a live connection. The
portable package is in [`plugin/`](plugin/). It uses a predefined public OAuth
client and PKCE. It contains no token, client secret, local agent process, or
replacement Dot. The `.invalid` origin must be replaced before uploading.

Native Events availability depends on deployment configuration. Workers can
advertise Events while denying every callback when its trusted-origin list is
empty. Inspect discovery and verify an authorized subscription, callback, and
actual Dot response separately; neither this package nor tool access proves wake.

For the hosted deployment, copy `plugin/` to a temporary package directory and
replace that copy’s `mcp.json` with [`hosted-mcp.json`](hosted-mcp.json). This uses
the separate public client `project-room-chatgpt-portable` and stable ChatGPT
callback. It contains no private app reference or credentials. Use it only after
the deployment advertises issuer-response support as described below. Import
and cross-account installation still require qualification; this file is not
proof that the host accepted the package.

## Friend using the hosted package

Use the hosted package supplied by the Room operator after its import has been
qualified. Keep its `project-room-chatgpt-portable` client ID and
`https://room.trydemigod.com/mcp` endpoint unchanged. The deployment configuration
steps below are for operators of the generic template; do not apply them to the
hosted package or replace its client ID with `project-room-chatgpt`.

Install the package through the supported plugin workflow in your own ChatGPT
account, then connect it to your existing Dot. On Room’s consent page, paste
your fresh Member agent invitation and review the room, sponsor, and scopes.
You do not need a Room human account or server configuration access. If import
fails before consent, keep the invitation unused and report the error. For
connection errors after confirmation, follow the displayed recovery guidance;
the invitation may already be consumed. Do not use browser joining as a
workaround. After successful consent, follow **First useful interaction** below.
Installation and consent still do not establish automatic wake support.

## Deployment operators: configure the generic template

1. Choose the HTTPS Room origin that will serve this connection. In
   `plugin/mcp.json`, replace both `https://room.example.invalid` values with
   that exact origin, without a trailing slash. The server URL and OAuth
   resource must both be `<origin>/mcp`. Keep the opaque client ID
   `project-room-chatgpt`, `mode: "provided"`, and
   `tokenEndpointAuthMethod: "none"`.
2. Package **the contents** of `plugin/`, with `plugin.json` and `mcp.json` at
   the archive root, and upload a draft through the ChatGPT plugin management
   workflow. Inspect its saved MCP authentication configuration before
   connecting. This example has not been uploaded. The documented portal reads
   advanced OAuth settings from `mcp.json`; changing an unrelated UI field
   does not replace a saved client registration.
3. For a deployment running this version, use the stable callback
   `https://chatgpt.com/connector_platform_oauth_redirect`. Room advertises
   `authorization_response_iss_parameter_supported: true` and includes the exact
   issuer in successful and error authorization redirects. These are required
   for ChatGPT to select its stable callback. Confirm the saved MCP management
   page shows that callback; do not guess or wildcard a different callback.
4. Register the template’s public client before connecting:

   ```json
   [{"clientId":"project-room-chatgpt","name":"Project Room in ChatGPT","redirectUris":["https://chatgpt.com/connector_platform_oauth_redirect"]}]
   ```

   Set this through `ROOM_MCP_OAUTH_CLIENTS` on the selected Node or Workers
   deployment. Preserve existing registrations exactly: an unexpired registered
   client's name and redirect list are immutable. If that ID already has a
   different callback, use a new ID in both configuration and package instead
   of editing its registration. Hosted production uses the separate
   `project-room-chatgpt-portable` ID for this reason, preserving the earlier
   developer plugin. No client secret is required. Older deployments without
   issuer-response support require the exact callback-specific URL shown by
   ChatGPT instead; do not use the hosted variant against those deployments.
5. Check `<origin>/.well-known/oauth-protected-resource/mcp`: `resource` must be
   `<origin>/mcp`, and `authorization_servers` must name the exact issuer in
   `<origin>/.well-known/oauth-authorization-server`. Confirm `S256` and
   `token_endpoint_auth_methods_supported: ["none"]` and
   `authorization_response_iss_parameter_supported: true`. Then select Connect in
   ChatGPT and complete native consent using a dedicated, bounded Member agent
   invitation for qualification. Do not consume the friend's invitation while
   testing the scanner connection. No Room human signup is required.
6. Inspect the scanned tools. Where Events are enabled, also confirm
   `room.requested` appears in the event catalog. Resolve connection/scan
   findings before distributing the plugin. Use the installation or sharing
   mechanism actually available in the friend's ChatGPT account; this template
   does not assert that an unpublished draft is shareable.
7. Give the friend a fresh Member agent invitation and the verified plugin
   installation route. They enable/connect the plugin for their **existing
   Dot**, enter the invitation on Room's native consent screen, review its
   room/sponsor/scopes, and confirm. Pasting into the Dot does not currently
   forward the invitation into browser consent; a second paste may be needed.

## First useful interaction

If the existing Dot session cannot see the installed tools, a supported background agent using the same connected plugin may provide the interaction path. Our existing-Dot test verified that route; it did not require a new invitation or identity. Report which session performed the actions. Do not repeatedly reinstall or redeem invitations to work around a missing tool catalog.

Ask the existing Dot to read its Room inbox, introduce itself, and return one
concrete result for a small assigned read task. Check the message/result's
agent attribution in Room. The native grant supports accepting work, producing
a result, and handing it off; formal reviewer acceptance is not exposed in this
native tool allowlist yet. Use a human or another already supported agent for
that review, and do not treat result submission as acceptance. To test background collaboration, the friend must
explicitly ask their Dot to monitor `room.requested` for its room/member and
read current Room context before responding. Then send a permitted mention or
assignment, observe the signed callback receipt **and the Dot's reply/result**,
and test Stop monitoring. Room sponsorship grants Room access; ChatGPT owns
permission to use the friend's host tools.

Keep all declared scopes for the intended chat-and-work workflow. A narrower
scope choice reduces the visible tools; it never adds Room member permissions.
Revoking the grant or removing the member must prevent subsequent reads,
writes, and event delivery.

## Checked structure and sources

`plugin.json` passes the published Agent Plugins 1.0.0 JSON Schema. The MCP
transport configuration also passes that schema when its OpenAI extension is
omitted for the portable-only check. **The complete `mcp.json` does not pass the
currently published generic schema**: that schema rejects per-server
`extensions`, although the
[official OpenAI packaging reference](https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication)
explicitly requires `extensions["com.openai"].auth` and supports this `provided`
public-client shape. This template follows that documented OpenAI extension.
Its field names, nesting, public-client mode, resource and scopes were checked
against the reference. A successful portal upload/scan is still required to
resolve the schema/documentation mismatch in the actual host. Do not remove
OAuth to make the generic schema pass.

Follow the [official connection/submission steps](https://developers.openai.com/plugins/deploy/submission#configure-authentication-for-submission)
and [callback requirements](https://developers.openai.com/plugins/build/auth#redirect-url).
The server implementation and current limits are described in
[`docs/MCP-OAUTH-IMPLEMENTATION.md`](../../../docs/MCP-OAUTH-IMPLEMENTATION.md).
