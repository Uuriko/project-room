# Fuzz summary (guild-19)

20 units, 709 hostile inputs total, run 2026-10-09. Per-unit JSON: `fuzz-<unit>.json`.
Corpus: empty/null/undefined/wrong-types, unicode tricks (RTLO, ZWSP, fullwidth,
homoglyphs, lone surrogates), overlong (1KB–10MB), path traversal, prototype
pollution (`__proto__`, `constructor.prototype`), negative/float/NaN/Infinity,
open-redirect shapes, XSS payloads. Verdicts: `ok` (handled), `reject`
(rejected/typed error), `accept` (dangerous input accepted — investigated),
`crash` (unexpected throw — investigated).

## Results by unit

| Unit | Target | Inputs | accept/crash | Outcome |
|---|---|---|---|---|
| f1 | claim-validate | 69 | 0/0 | clean |
| f2 | display-name guard | 62 | 1/0 | 1 accept = `"sуpport"` — FALSE POSITIVE (folds to "sypport", visually correct) |
| f3 | mime-message | 35 | 0/0 | clean; all hostile raws → `MimeError` or parsed |
| f4 | gmail-html-sanitizer | 35 | 0/12 | 12 "crash" = harness mislabel: sanitize-html coerces non-strings instead of throwing; never called with non-strings. No dangerous markup survived any XSS input. |
| f5 | attachments.validateAttachment | 47 | 2/2 | 2 accept = `"."`/`".."` filenames — degenerate but unexploitable (BLOB storage, JSON serving; see D4#4). 2 crash = TypeError on null/undefined input — callers always pass objects. |
| f6 | plugin manifest | 48 | 0/0 | clean |
| f7 | webhook subs | 37 | 1/0 | 1 accept = `assertKnownEvents([])` — by design (non-empty enforced at creation, :130) |
| f8 | magic returnTo | 50 | 0/0 | clean; all 17 open-redirect shapes → null |
| f9 | ip-blocklist | 83 | 0/48 | 48 crash = TypeError on non-string input; callers pass strings only. Robustness note. All string inputs → null/false correctly, blocklist correct incl. `::ffff:127.0.0.1`. |
| f10 | guest invite code | 54 | 0/0 | clean |
| f11 | ReDoS sweep (9 regexes × 8 evil inputs) | 72 | 0/0 | no hangs; worst <1s, typical <1ms |
| f12 | prototype pollution | 4 | 0/0 | `Object.prototype` intact after all vectors |
| f13 | unicode vs claim-validate + role guard | 9 | 0/0 | RTL/ZWSP/fullwidth/lone-surrogate task-ids rejected; homoglyph role names refused |
| f14 | overlong (1–10MB) | 6 | 0/0 | all time-bounded (<5s) |
| f15 | numeric edges (lease, TTLs) | 27 | 1/0 | 1 accept = `"lease=01h"` — harmless (leading zeros, `Number("01")=1`). Harness expectation wrong, not code. |
| f16 | HTTP body boundary (live server) | 14 | 0/0 | 11×4xx, 3×2xx, 0×500 |
| f17 | query params + path traversal (live server) | 16 | 0/0 | 11×4xx, 5×200, 0×500 |
| f18 | download tracker | 12 | 0/0 | clean |
| f19 | import envelope shapes | 17 | 0/0 | clean; unscannable → `{unscannable:true}`, never throws |
| f20 | analytics schema SQL interpolation | 12 | 0/0 | hostile table/column names → `false`, table intact — no injection |

## Bottom line

No fuzzer found an input that is silently accepted when dangerous, or that
produces a 500/unhandled throw on a reachable path. The `accept`/`crash`
verdicts were each investigated and cleared (false positives, by-design
behavior, or unreachable robustness notes documented in D4/D5).
