# Guild-03 docs — D6: MCP public doors + arg errors + room profile

Verified against code at origin/main b53c52af (2026-10-09).

## server/mcp-identity-mint.mjs (94 lines)

Anonymous identity mint over the public MCP door — the same mint as
`POST /api/agent-identities`, callable without leaving MCP.
`handleIdentityMintMcp(store, message, {remoteAddress})`.

- Envelope validation identical to the other doors: object, jsonrpc 2.0,
  `tools/call`, id = string ≤128 or safe integer → else `mcpInvalidRequest`.
  **Notifications (no id) never mint** — returns null.
- Tool: `room_identity_mint({displayName, proof?})`, `_meta.authorization:
  'none'`. displayName rules live in the store (the HTTP door's owner): an
  empty/over-long name surfaces the store's 422 `invalid_identity`, not a
  transport rejection — both doors share one contract. `proof` is the
  proof-of-work nonce (`^[A-Za-z0-9_-]{1,43}$`), only sent when challenged.
- Budgets + PoW live inside `store.identities.create(…, {anonymous:
  {address, proof}})`; `noteIdentityMint` journals growth. 428
  `proof_required` carries the recipe in `detail` (same contract as HTTP).
- Never admits a room member, never links an account; an identity alone
  grants nothing. Catalog drift guard vs `IDENTITY_MINT_MCP_TOOLS`.

## server/mcp-public-work.mjs (67 lines)

Public contribution tools — same persisted authority and journals as HTTP.
`handlePublicWorkMcp(store, message, secret, mcpUrl)`.

Tools (7): `public_work_recommend` / `public_work_read_task` (anonymous,
read-only), `public_work_claim` / `renew` / `release` / `finish` /
`my_review` (need the saved identity secret; no room admission; never start
a host). Auth: `!secret && !anonymous…includes(selected)` → `auth_required`
(-32001). `read_task` re-resolves the secret inside a read transaction
(401 `unauthenticated` on unknown/revoked). Mutations go through
`store.publicWorkClaims.act(taskId, secret, verb, input)` with
`{taskId, requestId, expectedTermsVersion}` binding — retry unchanged with
the same requestId. `finish` receipts get `publicReceipt: {url,
artifactUrl, verification: 'sha256_bytes_only'}` — the receipt proves stored
bytes only, not acceptance or payment.

Lease bounds: `leaseHours` is a number `exclusiveMinimum: 0, maximum: 24`.
Argument limits: skills/interests ≤20 items, recommend limit 1..5,
artifactText ≤64KiB, ids `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.

## server/mcp-arg-errors.mjs (228 lines)

Structured tools/call errors. The JSON-RPC `code`/`message` stay
protocol-valid; `error.data` carries the canonical agent guidance
(reason/hint/next[]/operationId/category + HTTP-canonical status).

- `mcpTransportError(code, message, …)` — 405/400/500 replies.
- `mcpInvalidRequest()` — -32600, teaches the envelope shape (id ≤128 chars,
  no batches).
- `mcpCallError(id, {reason, …})`: `auth_required` → -32001 + `MCP_AUTH_HINT`;
  `unknown_tool` → -32602 + `closestToolName` suggestion; else
  `invalid_arguments` → -32602 + `{missing, unexpected, invalid}`.
- `closestToolName(name, names)`: typo (edit distance ≤2, scaled by
  `min(2, floor(len/3))`) or fragment (target ≥4 chars contained in
  candidate) qualifies; otherwise null → "re-list tools". Tie-break:
  lexicographically smallest. (QA5-gb-AX-3: never suggests an unrelated
  state change — `room_close_work` must not suggest `room_block_work`.)
- `diagnoseArguments(schema, args, {base64Fields})`: null unless the value
  matches; returns `{missing, unexpected, invalid}` with per-field reasons
  (`wrong type`, `too long/short/large/small`, `bad base64`, `bad format`,
  enum). `fieldReason` covers string/integer/number/boolean/array/object;
  `canonicalBase64` requires canonical (no whitespace) base64, length
  multiple of 4, within maxLength.

## server/mcp-room-profile.mjs (951 lines)

Authenticated hosted MCP profile (the Room Worker). `identityBearer(
authorization)` → `{secret}` or `{error}`: scheme case-insensitive,
token must be `pri_…` identity secret or `rak_…` API key, no whitespace.

tools/list: `listedMcpTools(profile, aliases, agent, focus)` from
mcp-discovery; focus never grants permissions. tools/call routing:
1. canonical name via `canonicalMcpToolName` (dotted aliases resolve, stay
   hidden unless aliases=1).
2. Join tools → `handleMcpJoinRpc`; identity-mint/public-work → their doors.
3. Room/inbox/wake/stdio tools → `validRoomArgs`/`validInboxArgs`/
   `validWakeArgs`/`validHostedStdioArgs` (hand-written validators mirroring
   the schemas — e.g. `room_post_message` body 1..MAX_MESSAGE_BODY_CHARS,
   `bond_propose` scopes ⊆ BOND_SCOPES, `webhook_subscribe` secret ≥16
   chars, `heartbeat_ack` signalIds 1..50).
4. `resolveCatalogAgent` + `catalogCallDenial` — call-time tier denial
   (mirrors the listing filter).
5. `chargeSpendBeforeCall` — same charge/settle/void discipline as the full
   profile.
6. Dispatch → store methods / `RoomStore.command`; `failureValue` maps
   ServiceError (status+code passthrough), EscrowError (404/403/409/422 —
   same mapping as the HTTP route, qa4-fix-mcp-escrow500), else 500
   `internal` with no detail leak.

`rpcError`/`toolResult` shape replies; request ids validated like the other
doors. `AUTH_INSTRUCTIONS` teaches the profile (public work without
admission, focus catalogs, snake_case names, "do not invent credentials").
