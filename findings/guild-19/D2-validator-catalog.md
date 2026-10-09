# D2 — Validator catalog (guild-19)

Every input validator in the slice, what it guards, how it fails, and where its tests live.
Surveyed 2026-10-09. "Fails" = the typed error / rejection the caller sees.

## Transport

| Validator | File | Guards | Fails | Tests |
|---|---|---|---|---|
| `readText(req, limit, tooLarge)` | `server/http.mjs:818` | body byte cap, declared-length pre-check, abort | 413 `too_large` (names limit + actual) | M11 mutants all killed |
| `body(req, {limit})` | `server/http.mjs:841` | JSON content-type, object-only, no arrays | 415 `json_required`, 400 `invalid_json` | M11; f16 (14 hostile bodies, 0×500) |
| NDJSON line check | `server/http.mjs:4226` | per-line JSON validity on import | 422 `invalid_import` | — (gap: no dedicated test file found) |

## Field validators (pure)

| Validator | File | Guards | Fails | Tests |
|---|---|---|---|---|
| `validateClaimText` / `validateClaimFields` / `extractClaimBlock` / `parseClaimFields` | `server/claim-validate.mjs` | room-claim fence shape, task-id `RC-YYYY-MM-DD-N`, lane/files/lease/state/reason presence, lease `1–72h`, state word incl. `failed(code)`, no `*` in files | `{valid:false, errors[]}` | `tests/claim-validate.test.js` (M1: 5/5 killed) |
| `isReservedRoleName` / `assertNotReservedRoleName` / `assertAdmissibleMemberName` | `server/display-name-guard.mjs` | role-like names at admission: skeleton vs reserved words, bracket/colon labels, CJK decorations, flattened compounds | `Error` 422 `display_name_unavailable` | `tests/display-name-guard.test.js`, `tests/display-name-impersonation.test.js` (M2: gaps — flat-reserved + colon-label mutants survived) |
| `displayNameSkeleton`, `assessMemberDisplayName`, `checkAgentDisplayName` | `src/display-name-guard.js` | NFKD confusable folding, mixed-script, invisible/bidi controls | `null` / `{available:false}` | same as above |
| `parseMimeMessage` (+ `parseAddressList`, `parseMailbox`, `splitMultipart`, `decodeEncodedWords`, `cleanHeaderValue`) | `server/mime-message.mjs` | bounded MIME parse: raw ≤1MiB, ≤200 headers, header ≤8KiB, ≤50 parts, depth ≤4, ≤200 addresses; control-char stripping; linear scans | `MimeError(code)` | `tests/mime-message.test.js`, `tests/mime-fuzz.test.js` (M3: rawBytes + addresses mutants survived — bound tests missing) |
| `sanitize` (generated sanitize-html bundle) | `server/vendor/gmail-html-sanitizer.mjs` | XSS: discards scripts/event handlers/javascript: URLs; allowlisted tags/attrs/schemes | stripped output | f4 (35 inputs, no dangerous markup survived) |
| `validateAttachment` | `server/attachments.mjs` | filename 1–255, no `/` `\` NUL, integer ≥0 size, non-empty mime, blocked extensions, size ≤ max | `invalid_attachment` / `blocked_extension` / `file_too_large` | `tests/attachments.test.js` (M5: filename-len + size-int mutants survived) |
| `checkedFile`, `validAttachmentData` | `server/room-attachment-bytes.mjs` | well-formed filename, canonical base64 ≤1MiB | 422 `invalid_attachment` | `tests/attachments.test.js` (R5/R6 re-verify clean) |
| `validatePluginManifest` | `server/agent-plugin-manifest.mjs` | object, exact version `1.0.0`, https-only origin, non-empty schemes/scopes/flows | `invalid_manifest` | `tests/agent-plugin-manifest.test.js` (M6: scopes-empty survived) |
| `assertKnownEvents`, `verifySignature`/`signPayload` | `server/agent-webhook-subscriptions.mjs` | event names ∈ catalog/`*`; HMAC-SHA256 timing-safe verify | `invalid_subscription` / `false` | `tests/agent-plugin-webhook-subs.test.js` (M7: max-events survived) |
| `validateMagicReturnTo` | `server/magic-links.mjs` | relative path ≤2048, no `//`/backslash/controls, origin-locked, allowlisted params, invite-shaped hash | `null` | `tests/magic-links.test.js` (M8: length-cap + hash-check survived; `//` check is defense-in-depth — equivalent mutant) |
| `isGuestInviteCode`, TTL checks | `server/guest-invites.mjs` | `GX-`+32 chars; TTL `Number.isSafeInteger` + min/max | `false` / 422 `invalid_guest_invite` | `tests/guest-invite-flow.test.js` (M10: code-anchor + redeem-max + safe-int survived) |
| `validateIssue` (in `createAgentApiKeys`) | `server/agent-api-keys.mjs` | identity pattern, non-empty valid scopes, positive-int expiresAt, label ≤80 | `invalid_api_key` (check) | `tests/agent-plugin-api-keys.test.js` (M15: expires-int survived) |
| `parseIpv4`, `parseIpv6`, `isBlockedIp`, `extractEmbeddedIpv4` | `server/ip-blocklist.mjs` | strict IP parsing → SSRF blocklist (private/loopback/link-local/multicast/reserved/doc/CGNAT/benchmark + v4-embedded forms) | `null` / `false` | `tests/webhook-subscription-ssrf.test.js`, `tests/web-fetch-ssrf-hardening.test.js` (M9: all 3 parse mutants survived; f9: throws TypeError on non-string input — callers always pass strings, robustness note) |
| `scannableOfEnvelope`, `scoreImportedEnvelope` | `server/inbox-import-guards.mjs` | envelope object shape, non-empty string body | `Error("envelope…")` / `{unscannable:true}` (never throws past the guard) | `tests/inbox-import-guards.test.js` (M4: all 3 guard mutants survived) |
| `emailImportLimits` | `server/email-import.mjs` | journal ≤16MiB, ≤5000 commands | — | `tests/email-import.test.js` (M12: commands-cap survived) |

## Schema validators (storage layer)

| Validator | File | Guards | Tests |
|---|---|---|---|
| `ensureAttachmentSchema` / `verifyAttachmentSchema` | `server/attachment-schema.mjs` | `byte_length` 0–1MiB, `sha256` len 64, staged⇔bytes invariant; migration only from v28 | M13: both CHECK mutants survived — no schema-constraint tests |
| `ensureAnalyticsSchema`, `tableExists`, `columnExists` | `server/analytics/schema.mjs` | additive tables; `columnExists` interpolates table name into PRAGMA (f20: hostile names → false, no injection — callers pass constants) | M14: utcDay/addDaily mutants survived |

## Regex inventory (all anchored, no nested quantifiers — f11 ReDoS sweep: 72 evil inputs, 0 hangs)

`TASK_ID_RE`, `LEASE_RE`, `STATE_RE`, `FENCE_RE`, `FIELD_LINE_RE` (claim-validate);
`addressPattern` (mime-message); `GUEST_INVITE_CODE_PATTERN` (guest-invites);
`urlPattern` (inbox-import-guards); route-param patterns `/^\/api\/rooms\/([^/]{1,384}).../`
(http.mjs — length-capped, no-match → 404).
