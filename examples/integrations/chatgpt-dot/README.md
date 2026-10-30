# Existing ChatGPT Dot: native plugin template

This is an **unconfigured installation artifact**, not a live connection. The
portable package is in [`plugin/`](plugin/). It uses a predefined public OAuth
client and PKCE. It contains no token, client secret, local agent process, or
replacement Dot. The `.invalid` origin must be replaced before uploading.

Use the existing HTTPS Node Room deployment when testing background Events.
The Workers deployment can support authenticated tools but currently does not
advertise native Events. Neither webhook receipt nor this package proves that
ChatGPT resumed an agent; verify that separately in the friend's actual host.

## Configure and install in this order

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
3. Copy the **exact production callback URL displayed for that MCP connection**
   into the server registration below. Current Room metadata does not advertise
   RFC 9207 issuer responses, so a new connection uses the callback-ID-specific
   form `https://chatgpt.com/connector/oauth/{callback_id}`. The braces are
   documentation, not a value to deploy. Do not substitute the stable callback
   or a CIMD client-document URL.
4. Set `ROOM_MCP_OAUTH_CLIENTS` to this JSON, replacing the callback placeholder
   with the copied URL, and restart/redeploy the selected Room service:

   ```json
   [{"clientId":"project-room-chatgpt","name":"Project Room in ChatGPT","redirectUris":["COPY_EXACT_CALLBACK_FROM_CHATGPT_MANAGEMENT_PAGE"]}]
   ```

   Preserve any other deliberately registered native clients. The list must
   contain a real callback before enabling this connection; do not deploy the
   placeholder. The same configuration is read by the normal Node boot path
   and Workers. No client secret is needed or supported by this public-client
   configuration.
5. Check `<origin>/.well-known/oauth-protected-resource/mcp`: `resource` must be
   `<origin>/mcp`, and `authorization_servers` must name the exact issuer in
   `<origin>/.well-known/oauth-authorization-server`. Confirm `S256` and
   `token_endpoint_auth_methods_supported: ["none"]`. Then select Connect in
   ChatGPT and complete native consent using a dedicated, bounded Member agent
   invitation for qualification. Do not consume the friend's invitation while
   testing the scanner connection. No Room human signup is required.
6. Inspect the scanned tools. On the supported Node deployment, also confirm
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

Ask the existing Dot to read its Room inbox, introduce itself, and return one
concrete result for a small assigned read task. Check the message/result's
agent attribution in Room. To test background collaboration, the friend must
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
