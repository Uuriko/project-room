# D1 — Validation architecture (guild-19)

Where input validation lives in Project Room's server, and what each layer is responsible for.
Surveyed 2026-10-09 on origin/main @ b53c52af1. All paths are `server/…` unless noted.

## The four layers (outside → in)

### L1 — Transport: `http.mjs` `body()` / `readText()` (+ `stream()` NDJSON import)
The single trust boundary for every JSON route.

- `readText(req, limit, tooLarge)`: declared `Content-Length` over the limit is
  refused immediately (413) while the socket drains in the background, so a
  stalled sender can't hold a connection open. Unknown-length bodies are
  counted while draining; over-limit chunks are dropped but counting
  continues so the 413 names the real size (G7).
- `body(req, { limit })`: 415 unless `Content-Type` is `application/json`
  (charset suffix allowed); 413 past `JSON_BODY_BYTES` (16384); 400
  `invalid_json` unless the parsed value is a non-array object.
- Consequence: **no route ever sees a non-object JSON body, an array body, or
  an unbounded body.** Route code may assume `data` is a plain object — but
  must still validate every field (see L2).
- The NDJSON import path (line ~4226) validates per line: non-JSON lines are
  422 `invalid_import`, never a 500.

### L2 — Route: per-route param & body checks in `http.mjs` and route modules
Route params are matched by anchored regexes with explicit length caps, e.g.
`/^\/api\/rooms\/([^/]{1,384})\/.../` — overlong ids never reach a handler
(the route simply doesn't match → 404). Body fields are checked per route
with `reject(4xx, code, message)`; the `exact(data, [...])` helper rejects
unknown keys on strict routes.

Field-level validators used at this layer (all pure, all throw typed errors):

| Module | Validator | Guards |
|---|---|---|
| `attachments.mjs` | `validateAttachment()` | filename 1–255 chars, no `/` `\` NUL, non-negative integer size, non-empty mime, blocked extensions, size ≤ max |
| `room-attachment-bytes.mjs` | `checkedFile()` | `validateAttachment` + `isWellFormed()` filename; `validAttachmentData()` for base64 |
| `agent-plugin-manifest.mjs` | `validatePluginManifest()` | object shape, exact version, https-only service origin, non-empty schemes/scopes/flows |
| `agent-webhook-subscriptions.mjs` | `assertKnownEvents()` | event names ∈ catalog or `*`; creation also enforces non-empty array + `MAX_SUBSCRIPTION_EVENTS` (32) |
| `magic-links.mjs` | `validateMagicReturnTo()` | relative-path only, ≤2048 chars, no `//`, no backslash/controls, origin-locked, allowlisted query params, invite-shaped hash |
| `guest-invites.mjs` | `isGuestInviteCode()` | `GX-` + 32 `[A-Za-z0-9_-]`; TTL bounds `Number.isSafeInteger` + min/max |
| `agent-api-keys.mjs` | `validateIssue()` | identity pattern, non-empty scopes + scope pattern, positive-int expiresAt, label ≤80 |
| `ip-blocklist.mjs` | `parseIpv4/parseIpv6/isBlockedIp` | strict dotted-quad / RFC-5952-ish IPv6 → blocklist for SSRF guards |
| `display-name-guard.mjs` | `isReservedRoleName()` | NFKC skeleton vs reserved role words, bracket/colon labels, CJK decorations, flattened compounds |
| `src/display-name-guard.js` | `displayNameSkeleton()` etc. | NFKD+mark-strip+lowercase confusable folding, mixed-script checks |
| `claim-validate.mjs` | `validateClaimText()` | room-claim fence extraction, field rules (task-id shape, lease 1–72h, state word, no `*` in files) |
| `inbox-import-guards.mjs` | `scannableOfEnvelope()` | envelope object shape, non-empty string body content |
| `mime-message.mjs` | `parseMimeMessage()` | every axis bounded (raw 1MiB, 200 headers, 8KiB header, 50 parts, depth 4); linear scans only |

### L3 — Domain: store/command preconditions
`store.command()` and the `RoomAttachmentBytes` / `createAgentApiKeys` style
managers re-check authorization-adjacent preconditions (`validId()`,
ownership, tiers) even when the route already checked them — the store does
not trust the route layer. Example: `denyGuestFiles()` in
`room-attachment-bytes.mjs` exists precisely because `stage()` bypasses
`store.command` and its guest scope gate.

### L4 — Storage: SQL CHECK constraints as the last line
`attachment-schema.mjs` (`byte_length` range, `sha256` length 64, staged⇔bytes
invariant) and `guest-invites.mjs` (`credential_ttl_ms BETWEEN min AND max`).
These catch bugs, not attackers — by L4 the input is already validated, but a
code path that forgets validation still can't persist nonsense.

## What's trusted where

- **Never trusted**: raw `req` bytes, `Content-Length`, `Content-Type`
  spelling, query strings, route params, JSON field values, filenames,
  display names, URLs, IP strings, MIME text.
- **Trusted after L1**: "body is a JSON object ≤ limit".
- **Trusted after L2**: the specific fields the route validated, with the
  exact predicates it ran — nothing more.
- **Trusted after L3**: identity/ownership/authorization facts the store
  established itself.
- **L4 trusts nothing**: constraints are unconditional.

## Cross-cutting conventions

- Typed errors, never bare throws on the request path: `ServiceError(status,
  code, message)`, `MimeError(code)`, `ManifestError`, `WebhookSubscriptionError`.
  Unknown throwables become 500s — validators are expected to throw only
  their typed errors.
- `check(cond, msg)` local helper pattern (`attachments.mjs`,
  `agent-plugin-manifest.mjs`, `agent-api-keys.mjs`): one-line precondition →
  typed error.
- Pure validators are shared between server and browser where possible
  (`claim-validate.mjs` mirrors `scripts/room`'s jq; `display-name-guard`
  lives in `src/` so the browser loads the same module).
