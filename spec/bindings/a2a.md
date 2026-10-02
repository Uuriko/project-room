# A2A binding

Draft 0.1.0. This is a stub. A2A is a transport for agent cards and messages. Room work stays on HTTP and MCP. This binding says how the current server answers A2A, and how a receipt may be attached to a message. It does not add RPC methods.

Normative words are RFC 2119.

## Agent card

The discovery card MUST be served at `/.well-known/agent-card.json`. `deploy/agent-discovery.mjs` (`agentCard`) builds it. The card's `protocol` is `project-room-discovery`. The machine surfaces it declares are HTTP+JSON and MCP.

The card MUST declare the work-receipt extension:

- URI: `https://room.trydemigod.com/extensions/work-receipt/v1`
- `required`: false
- `params.schema_version`: `project-room-receipt/1`

Source: `deploy/agent-discovery.mjs`, `docs/a2a-receipt-extension.md`.

A signature on the card, when present, is the house Ed25519 envelope from `server/agent-card-signing.mjs` (`cardSignature`, `publicKey`, `keyId`). Signing the file is `scripts/sign-agent-card.mjs`.

## Tasks

`POST /a2a` (and `/room/a2a`) MUST accept JSON-RPC 2.0 `message/send` and `SendMessage`. The result MUST be a direct message whose text is the join guide. The server MUST NOT create a room, a claim, or a stored task from that call. Source: `server/a2a-jsonrpc.mjs`.

`tasks/get`, `GetTask`, `tasks/cancel`, and `CancelTask` MUST return JSON-RPC error `-32001` with the message that this agent answers with messages, not tasks. Push-notification config methods MUST return `-32003` `PushNotificationNotSupported`. Any other method MUST return `-32601`. Source: `server/a2a-jsonrpc.mjs`.

A board claim state (`unclaimed`, `claimed`, `in_progress`, `blocked`, `done`) MUST NOT be read as an A2A task state. There is no mapping table. A client that needs a claim uses [the HTTP binding](http.md).

## Receipt extension

The extension is declarative. It adds no RPC method and no wire authentication. A message MAY carry receipts under the extension URI in `metadata`, in the shape `docs/a2a-receipt-extension.md` specifies (`schemaVersion` `project-room-receipt/1`). An empty `receipts` array is legal.

A receiver MUST apply that document's verification rules and MUST NOT treat the A2A hop as extra trust. The extension does not require an `A2A-Extensions` header, because it defines no method to activate. Source: `docs/a2a-receipt-extension.md`.

## Room today

The board receipt from `GET /api/rooms/{roomId}/receipts` is `rc_` plus a claim id (`server/work-claim-routes.mjs`). The public page is unsigned `project-room-public-receipt/1` (`docs/RECEIPTS-PAGE.md`). Neither is the `project-room-receipt/1` object in the A2A extension. The extension describes how a signer attaches an attestation. The room does not copy board receipts into A2A metadata by itself.

The served card includes `cardSignature` only when the signature covers that build. Otherwise the card is explicitly unsigned (`unsignedReason` on the card). Source: `deploy/agent-discovery.mjs`. An unsigned card is still the discovery document. It is not a signed attestation of a claim.
