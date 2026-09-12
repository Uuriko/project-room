# PR #122 post-merge security audit (agent identities)

Audited 2026-09-12 against `main` (merge `b2f691d` + backlog batch).

## Scope

`server/agent-identities.mjs`, `POST /api/agent-identities`,
`*/identity-links` routes, v26→v27 migration, credential handling.

## Findings

### 1. manage_members vs owner-only linking — OK (doc nit)

`link()`/`unlink()` require `manage_members`, while the code comments say
"owner-only". This is consistent with the platform's membership model:
`member.added` requires the same `manage_members`, and both go through
`requireScopedMemberAdministration` — a non-owner admin cannot grant
permissions they do not hold. Linking therefore grants no more authority
than the linker already has. The comments should say "membership
administration" rather than "owner-only".

### 2. Unauthenticated identity creation — FIXED

`POST /api/agent-identities` is unauthenticated by design (an identity
alone grants nothing), but it had no rate limit, unlike the other open
routes (`guest-agent-mint`, `invitation-preview`, `account-slot`). An
attacker could grow `agent_identities` without bound. Added
`rate(identity-create:<ip>, 30)`, matching the other open routes.

### 3. Permission escalation — OK

`link()` passes caller-supplied `permissions` into `member.added`, which
runs `requireScopedMemberAdministration`: non-owner linkers cannot grant
permissions they do not hold; the owner bypasses it (as with direct member
adds). `validatePermissions` rejects unknown permissions. No escalation
path beyond what `member.added` already permits.

### 4. Account/session/human fences — OK

Identity auth (`resolveIdentityAuth`) returns a room-scoped auth object
with `kind: "identity"`, `account: null`, no CSRF token. Bearer sessions are
rejected where browser sessions are required (`credentialScope !== "room"`
→ 403). Unlinking deactivates the member; `resolveIdentityAuth` returns
null for inactive members, so a stale secret stops working.

### 5. Credential absence — OK

- Only `secret_hash` (SHA-256) is stored; the secret is returned once at
  creation and never again (`get()` selects id/display_name/created_at only).
- `authenticate()` hashes before lookup; hashes never leave the DB.
- Identity secrets are not written into events, and `identityId` on the
  member record is the public `ai_*` id, not the secret.
- No `console.*` logging of secrets in the identity module.

### 6. Invalid/oversized fields — OK

- `create()`: displayName 1–80 chars, trimmed; `exact(data, ["displayName"])`
  rejects extra fields at the HTTP layer.
- `link()`: `identityId` must match `IDENTITY_ID_PATTERN`; `memberId`
  must match `MEMBER_ID_PATTERN`; `permissions` must be a non-empty array.
- `isIdentitySecret()` validates the `pri_` prefix and token shape before
  any DB lookup, so malformed credentials fail fast with 401.

### 7. v26→v27 migration — OK

`migrateAgentIdentitiesV27()` is purely additive
(`CREATE TABLE IF NOT EXISTS` for `agent_identities` and
`identity_links`); no data transformation, no backfill, nothing to
corrupt. Writer fence bumped to `project_room_writer_v27`.

### 8. CLI parsing and OpenAPI — OK

`docs/openapi.yaml` documents `/api/agent-identities` and
`/api/rooms/{roomId}/identity-links` and parses as valid YAML. There is no
dedicated identity CLI; identity operations go through the HTTP API and
the runtime client.

## Changes made

- `server/http.mjs`: rate-limit unauthenticated identity creation
  (30/min per IP).
