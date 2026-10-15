# Security review — 2026-09-12 (Quill)

Static review of the room server and client. No code changes needed;
everything below was already in good shape.

## Findings: all clear

**Share-link token entropy (task 12).** `server/share-links.mjs` mints
tokens with `randomBytes(32)` (256 bits), stored as hashes. Matches the
43-char base64url `tokenPattern` enforced at the edge. No issue.

**Unauthenticated mutating endpoints (task 13).** The only unauthenticated
POSTs are the intentional invite-link flows (`/api/guest-agent-links/*`,
`/api/share-links/preview`, `/api/invitations/preview|accept`) and the
login endpoint (`/api/session` with an access key). All carry per-IP or
per-token rate limits and `checkOrigin` CSRF guards; join/accept still
require account sessions. Every room mutating route sits behind the
credential check at `server/http.mjs:449+`. No issue.

**CORS (task 14).** No `Access-Control-*` headers are emitted anywhere:
cross-origin browser access is denied by default. Cookie-authenticated
browser routes additionally enforce `checkOrigin`. No issue.

**XSS (task 15).** `src/app.js` renders through a single `esc()` helper
(`&<>"'` escaped). Spot-checked: message bodies (`mentionHtml` escapes
non-mention text and both mention label + id), display names, work titles,
`initials()`, and `safeUrl()` (https-only, everything else becomes `#`).
Reaction keys/symbols come from a frozen `REACTIONS` allowlist and the
server rejects anything else (`src/events.js:334`). No unescaped
user-controlled interpolation found. No issue.

**Path traversal (task 16).** Static assets serve from a fixed `Map` —
request paths never reach the filesystem. `pathId()` decodes and
`validId`-checks IDs before use. No issue.

**Rate limiting (task 17).** Blanket per-credential limits on all room
routes (600 reads / 60 writes per window, `server/http.mjs:476-477`) plus
tighter per-endpoint limits on login (10), invite preview (30), and joins
(20). No issue.

**Secrets in history (task 18).** Scanned 30 days of diffs for API keys,
tokens, and private-key markers. No hits (only test-code false
positives). No issue.

## Error-shape consistency (task 20)

All `fail()` calls use string-literal snake_case codes (144 call sites
checked; no dynamic codes). The canonical reference is now
`docs/ERROR-TAXONOMY.md`; the machine-readable contract is
`errorCategory()` in `src/agent-error.mjs`.
