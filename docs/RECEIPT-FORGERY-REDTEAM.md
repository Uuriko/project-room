# Receipt-forgery red-team — 2026-10-07

Target: `src/audit-receipts.mjs` (F020) — hash-chained HMAC-SHA256 audit
receipts. `receipt = { seq, prevHash, entry, timestamp, hash, signature }`
with `hash = SHA-256(prevHash || canonicalJson(entry) || timestamp)` and
`signature = HMAC-SHA256(hash, key)`. The signing key is caller-supplied,
never hardcoded, never read from env inside the module.

Method: 12 forgery/tampering attacks executed against the real module
(scratch runner, not committed — the attacks are throwaway, the results are
not). 11 blocked; 1 residual filed as a hardening task below.

## Results

| # | Attack | Result | Blocking control |
|---|---|---|---|
| A1 | Forge a receipt with the attacker's key, verify with the real key | BLOCKED | HMAC-SHA256 signature check (`safeEqualHex` on recomputed signature) |
| A2 | Tamper the entry body after issuance | BLOCKED | Content hash recomputation (`hash = SHA-256(prevHash \|\| canonicalJson(entry) \|\| timestamp)`) |
| A3 | Tamper the timestamp | BLOCKED | Same content-hash check — timestamp is hashed |
| A4 | Replay a valid receipt at the wrong chain position | BLOCKED | `prevHash` link check + seq continuity (`receipt.seq === prev.seq + 1`) |
| A5 | Splice receipts from two chains | BLOCKED | `prevHash` must equal the previous receipt's `hash` |
| A6 | Truncate the chain tail (drop the last receipts) | **NOT BLOCKED** | None in-module — see hardening task H1 |
| A7 | Fake genesis receipt signed with the attacker's key | BLOCKED | HMAC signature check against the real key |
| A8 | Issue with an empty signing key | BLOCKED (throws `TypeError`) | `keyBytes` rejects empty keys — fail-closed |
| A9 | Type confusion: non-string `hash` field | BLOCKED | `isHex64` shape check rejects non-strings |
| A12 | Entry containing `undefined` (silent data-loss smuggling) | BLOCKED (throws `TypeError`) | `canonicalJson` throws on non-JSON values |
| A13 | Valid receipt verified against the wrong `prevHash` | BLOCKED | `receipt.prevHash !== prevHash` strict check |
| A14 | Chain with a seq gap | BLOCKED | Seq continuity check in `verifyChain` |

## Code-reviewed (not executed)

- **Timing side-channel on signature comparison:** `safeEqualHex` uses
  `timingSafeEqual`; the length pre-check cannot leak because every compared
  value is fixed 64-char hex. No measurable timing signal.
- **Key-substitution MITM (caller verifies with the attacker's key):** not
  blockable inside the module — the module correctly treats the caller key
  as authoritative. Residual risk, controlled by operator key custody
  (`docs/SECRETS-ROTATION.md`: key never hardcoded, never in env inside the
  module, rotation with checkpoint). No code change possible here; the
  control is procedural and already documented.

## Hardening task filed

**H1 — chain truncation is undetectable in-module.** `verifyChain` returns
`-1` (valid) for any authentic prefix, so a truncated chain is
indistinguishable from a complete one. Detection needs an external
checkpoint: the caller must know the expected head (seq/hash) and compare.
`docs/SECRETS-ROTATION.md` §3.4 already defines a checkpoint receipt `seq`
for key rotation; the same checkpoint discipline should anchor the chain
head (e.g. publish the latest seq+hash alongside each checkpoint, and have
verifiers assert the chain reaches it). Filed as a GitHub issue: https://github.com/Uuriko/project-room/issues/1847
suggested shape is backward-compatible: optional
`verifyChain(receipts, key, { expectedLength, expectedHeadHash })`.

## Verdict

The receipt chain resists forgery, tampering, replay, splicing, and
type-confusion attacks at the module boundary. The one residual (truncation)
is inherent to any hash chain without an external head anchor and is filed
as H1. Key custody remains procedural — the module's "never hardcoded, never
from env" design is the correct boundary.
