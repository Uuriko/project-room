# Mutation ledger (guild-19)

16 units (m1–m15 + m2b), 57 mutants total, run 2026-10-09 against origin/main @ b53c52af1.
Per-mutant JSON: `mutants-<unit>.json`; raw test output: `mutantlog-<unit>-<name>.txt`.

**Headline: no mutant exposed a bug in the original code.** Every behavior-changing
mutant was either killed by the suite or survived because no test pins that guard
(test gap, listed below). One mutant was behaviorally equivalent.

## Killed (suite is solid here) — 33

- m1 claim-validate: 5/5 (task-id shape, lease range, `*` in files, bare `failed`, flipped task-id check)
- m2 display-name: 2/4 + m2b pending→(see gaps)
- m3 mime: 3/5 (headers cap, nesting depth, control-char stripping)
- m4: 0/3 — all survived, see gaps
- m5 attachments: 2/4 (separator flip, blocked extension)
- m6 manifest: 3/4 (http origin, version drop, flows-empty)
- m7 webhook: 2/3 (unknown events, sig length check)
- m8 magic-links: 0/3 — all survived (1 equivalent, 2 gaps)
- m9 ip-blocklist: 0/3 — all survived, see gaps
- m10 guest-invites: 1/4 (credential TTL min)
- m11 http body: 3/3 (415 content-type, array-body 400, declared-length 413)
- m12 email-import: 1/2 (journal byte cap)
- m13 attachment-schema: 0/2 — survived, see gaps
- m14 analytics: 0/2 — survived, see gaps
- m15 api-keys: 3/4 (identity pattern, scope pattern, label length)

## Test gaps (survived, non-equivalent) — 23

Guards that are correct in the code but unpinned: deleting/weakening them
would not fail any test. Recommended regression tests are one-liners in the
named test files.

| # | Unit/mutant | Guard unpinned | Suggested test |
|---|---|---|---|
| 1 | m2 flat-reserved | `FLAT_RESERVED` check (`"ProjectRoom"`, `"Roomadmin"` refused) | `tests/display-name-guard.test.js`: `isReservedRoleName("ProjectRoom") === true` |
| 2 | m2b colon-label | trailing-colon labels (`"Admin:"`) | same file: `"Admin:"` refused |
| 3 | m3 rawbytes | MIME raw cap 1MiB | `tests/mime-message.test.js`: >1MiB raw → `MimeError` |
| 4 | m3 addresses | address count cap 200 | same: >200 addresses → `MimeError` |
| 5–7 | m4 ×3 | envelope-shape guards (`envelope must be an object`, non-empty body content, no arrays) | `tests/inbox-import-guards.test.js`: `scannableOfEnvelope(null/[]/{body:{content:""}})` throws |
| 8 | m5 filename-len | filename ≤255 chars | `tests/attachments.test.js`: 256-char name → `invalid_attachment` |
| 9 | m5 size-int | `Number.isInteger(sizeBytes) && >= 0` (mutant `\|\|` survived!) | same: `sizeBytes: 1.5` and `-1` rejected |
| 10 | m6 scopes-empty | non-empty apiKeyScopes | `tests/agent-plugin-manifest.test.js`: empty scopes → `invalid_manifest` |
| 11 | m7 max-events | `MAX_SUBSCRIPTION_EVENTS` (32) | `tests/agent-plugin-webhook-subs.test.js`: 33 events → rejected |
| 12 | m8 length-cap | returnTo ≤2048 chars | `tests/magic-links.test.js`: 2049-char path → `null` |
| 13 | m8 hash-check | hash allowlist (`#invite/…`, `#join/…`, `#code/…`) | same: `#evil` hash → `null` |
| 14–16 | m9 ×3 | `parseIpv4` strictness (octet ≤255, exactly 4 parts, ≤3 digits) | ssrf tests or a new `tests/ip-blocklist.test.js`: `"1.2.3.256"`, `"1.2.3"`, `"1.2.3.4444"` → `null` |
| 17 | m10 code-anchor | invite code `$` anchor (`GX-…` + trailing junk) | `tests/guest-invite-flow.test.js`: `isGuestInviteCode(code + "!") === false` |
| 18 | m10 redeem-max | redeem window max | same file: `redeemWindowMs: MAX+1` → 422 |
| 19 | m10 safe-int | `Number.isSafeInteger` on TTLs | same file: `credentialTtlMs: 1.5` → 422 |
| 20 | m12 commands-cap | email import ≤5000 commands | `tests/email-import.test.js`: 5001 commands → rejected |
| 21 | m13 byte-check | `byte_length` CHECK 0–1MiB | schema test: insert 2MiB `byte_length` → constraint error |
| 22 | m13 sha-check | `sha256` length 64 | schema test: short sha → constraint error |
| 23 | m15 expires-int | `expiresAt` integer | `tests/agent-plugin-api-keys.test.js`: `expiresAt: 1.5` → rejected |
| — | m14 ×2 | `utcDay` format / `addDaily` default | analytics tests (helpers currently unpinned) |

## Equivalent mutant — 1

- **m8 double-slash**: removing `value.startsWith("//")` from
  `validateMagicReturnTo` changes nothing observable — `new URL("//evil.com",
  base)` yields origin `https://evil.com`, which the origin lock already
  rejects (verified by direct execution). The check is defense in depth;
  the origin lock is the real boundary. No test needed, but don't delete
  the check either (it fails earlier and clearer).

## Not bugs (investigated, cleared)

- f2 `"sуpport"` (cyrillic у): folds to `"sypport"` — visually correct, not an
  impersonation of "support". Fuzz-corpus false positive.
- f5 `"."` / `".."` filenames: pass the no-separators contract; bytes live in
  sqlite, names served in JSON — no path/header use. Degenerate, not exploitable.
- f5 `validateAttachment(null)` TypeError: destructuring; callers always pass
  objects (route `body()` guarantees it). Robustness note only.
- f7 `assertKnownEvents([])` no-throw: narrow validator; non-empty enforced at
  subscription creation (`agent-webhook-subscriptions.mjs:130`).
- f9 `parseIpv4`/`isBlockedIp` TypeError on non-strings: callers pass URL
  hostnames / DNS answers (always strings). Robustness note only.
- f15 `"lease=01h"` accepted: leading zeros are harmless (`Number("01")=1`).
- f4 sanitizer "no-throw on non-string": sanitize-html coerces; only ever
  called with strings.

## Bugs confirmed: 0

No BUG CONFIRMED posts. The validation code is correct; the action item is
coverage of the 23 unpinned guards above.
