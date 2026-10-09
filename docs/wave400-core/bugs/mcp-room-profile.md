# Suspected bugs — server/mcp-room-profile.mjs

Read-only review of the full file plus targeted checks against `mcp-hosted-tools.mjs`,
`mcp-full-profile.mjs`, `agent-heartbeats.mjs`, and `http.mjs`. NOT fixed.

## Suspected bugs

- **`server/mcp-room-profile.mjs:936–941`** — Identity-mint and public-work pre-auth dispatch match on the
  *raw* tool name (`isIdentityMintMcpTool(message.params?.name)`, `isPublicWorkMcpTool(message.params?.name)`),
  but the authed path canonicalizes dotted aliases first (`canonicalMcpToolName(called)`). If any mint or
  public-work tool has a dotted alias, the alias form skips the pre-auth branch, hits auth, and returns
  `unknown_tool`. Alias handling is inconsistent between the pre-auth and authed paths.
- **`server/mcp-room-profile.mjs:297` (`validWakeArgs`, `webhook_subscribe`)** — `validEvents` checks only
  array length/count, not membership in `EVENT_CATALOG`. Unknown event names pass MCP arg validation and fail
  later at the store with 422. The tool description says "Unknown names are refused with the known list" —
  true, but one layer later than the validator implies. Loose validation gap, low severity.
- **`server/mcp-room-profile.mjs:907` (`mcpRoomAllowlist`)** — When `verifyPresentedApiKey` fails (record
  falsy) it returns `[]` (empty allowlist → filters out *every* room in the no-`roomId` `room_check_access`
  branch). But `identityBearer`+`resolveMcpIdentity` already rejected unknown/revoked keys before this is
  reached, so the `[]` branch is unreachable in practice — dead-ish defensive path that would silently
  return zero rooms instead of an error if it ever were reached. Needs owner confirm whether fail-closed
  to an error is intended.
- **`server/mcp-room-profile.mjs:306–313` (`validWakeArgs`, `heartbeat_set`)** — Accepts `wakeUrl` when
  `mode` is `pull-only`; the store rejects it later (`agent-heartbeats.mjs:332`, 422
  "pull-only hosts cannot register a wake URL"). The tool description documents the refusal, so behavior is
  correct end-to-end, but the MCP layer accepts-then-fails instead of failing fast — inconsistent with the
  other arg checks in the same function.

## Checked — no auth skipping found

- Every write path authenticates: command writes via `store.command`; `squads_*` via `squads.mjs`
  (secret passed through); land-queue writes via `callLandTool` (+ `enforceAutonomyTierForAction`);
  attachments/invites/access-requests via their sub-stores. The only no-membership branches are
  intentional: `room_create`/`room_join` (onboarding), `room_check_access` without `roomId`
  (own-identity metadata), inbox/wake tools (identity-scoped).
- Call-time catalog denial (`enforceMcpCallVisibility`, line 402; `enforceHostedStdioCallVisibility` in
  `mcp-full-profile.mjs`) mirrors the `tools/list` filter, so t1_readonly/guest agents can't bypass a
  withheld write by calling it directly. Inbox (`mcp:inbox`) and wake (`mcp:wake`) API-key scope checks
  are present on their dispatcher branches.

## Checked — documented tools all implemented and vice versa

- All 107 tools in `hostedMcpToolDefs` (38 room + 4 inbox + 10 wake + 55 stdio) resolve through
  `handleAuthed`'s `tools/call` to a dispatcher; the module-load drift check guarantees the list matches
  `HOSTED_ROOM_MCP_TOOLS`.
- `validRoomArgs` covers all 38 room tools by name; `dispatchRoomToolCall` has a branch for each
  (final `throw` is the unreachable fallback).
- No tool in the validators lacks a dispatcher branch, and no dispatcher branch lacks a tool definition.

## Checked — arg validation

- `room_join` enforces exactly-one-of (`linkToken` XOR `inviteCode`); `report_tip` requires at least one
  of `sourceRevision`/`buildId` (checked in both `validRoomArgs` and `argumentFailure`); bond scopes are
  checked against `BOND_SCOPES`; `roomId`/`id`/id-like args go through `validId` in both the validators
  and the `argumentFailure` diagnostic's `ID_KEYS` sweep; `since_version` must be 64 hex chars.
- `handleAuthed` rejects unknown tools (with closest-name suggestion), invalid `tools/list` profile/focus
  combos, and cursors. Notifications (no `id`) return `null` per JSON-RPC.
