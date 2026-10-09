# D4 — Validation gotchas (guild-19)

Traps this codebase has already hit, or that the fuzz/mutation sweeps probed.
Each is verified against the code cited.

## 1. The `//` in `validateMagicReturnTo` is defense in depth, not load-bearing
`value.startsWith("//")` looks essential against open redirects, but
`new URL("//evil.com", base)` sets the origin to `evil.com`, which the
`url.origin !== "https://return.invalid"` check rejects anyway (verified by
executing the validator; the M8 `//`-removal mutant is behaviorally
equivalent). Keep the check — it fails earlier and clearer — but don't treat
it as the security boundary. The origin lock is.

## 2. Cyrillic у folds to `y`, not `u` — and that's correct
"sуpport" (U+0443) is *not* an impersonation of "support": the skeleton is
"sypport" because у genuinely looks like Latin y. The lookalike table maps
by visual resemblance, not by the attacker's intent. When adding mappings,
check the glyph, not the word.

## 3. `assertKnownEvents([])` doesn't throw — and shouldn't have to
Empty arrays pass `assertKnownEvents` (no unknown events in an empty list).
The non-empty requirement lives at subscription *creation*
(`agent-webhook-subscriptions.mjs:130`). Narrow validators stay narrow; the
boundary check belongs where the object is constructed.

## 4. `validateAttachment` allows `.` and `..` as filenames
The contract is "no path separators", and `.`/`..` satisfy it. They're
degenerate but harmless here: bytes live in sqlite BLOBs, filenames are
served inside JSON bodies, never interpolated into paths or headers
(verified: no `Content-Disposition` interpolation of stored filenames; the
MIME path in `gmail-content.mjs` strips `[\r\n\0/\\]` itself). If a future
consumer puts filenames on a filesystem, revisit.

## 5. Pure validators throw `TypeError` on non-string input
`parseIpv4(null)`, `isBlockedIp(undefined)`, `validateAttachment(null)` all
throw TypeError instead of returning null/false. Safe today because every
caller passes strings (URL hostnames, destructured JSON objects), but a
validator that *can* be reached with missing input should fail typed, not
TypeError — TypeError on the request path is a 500. Convention: validate the
shape first, parse second.

## 6. `columnExists(table)` interpolates into SQL
`PRAGMA table_info(${table})` in `server/analytics/schema.mjs`. Safe only
because callers pass literals. Mark it: any new caller with user input is a
SQL-injection bug. (f20 sweep: hostile table names → `false`, no injection,
table intact.)

## 7. Lease `01h` is valid — and that's fine
`LEASE_RE` accepts leading zeros; `Number("01")` is 1, in range. Don't
"fix" this into a rejection — it's harmless and someone's client may emit it.

## 8. The `failed` state check order is load-bearing
In `claim-validate.mjs`, bare `failed` must report "failed requires a
failure code" *before* the unknown-state-word catch-all (the jq original has
this as dead code; the JS deliberately reorders). The M1 `state-failed`
mutant was killed — the ordering is pinned by tests.

## 9. `body()`'s 415 regex allows charset suffixes but not `+json` suffixes
`application/json-patch` → 415 (verified f16). `Application/JSON` (case) →
accepted. If a client sends `application/problem+json`, it gets 415 — correct
per the strict contract, but a plausible integration surprise.

## 10. Filename length is checked in UTF-16 code units, not bytes
`filename.length <= 255` counts JS string length. A 255-emoji filename is
1020 bytes in UTF-8 — fine for sqlite TEXT, but any byte-oriented consumer
downstream should know.

## 11. `scoreImportedEnvelope` never throws — by contract
Unscannable envelopes return `{score: 0, unscannable: true}` instead of
failing the import, because journal replay must be deterministic. Don't add
a throw there without updating the replay path.

## 12. ReDoS: the regexes are safe *because* they're boring
All validation regexes are anchored with no nested quantifiers (f11: 72
adversarial inputs × 9 regexes, worst case <1s, most <1ms). The invariant to
preserve: never interpolate untrusted text into a regex (mime-message
explicitly notes boundaries use `indexOf` for this reason).
