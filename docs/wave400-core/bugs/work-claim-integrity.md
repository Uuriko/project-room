# Suspected bugs — server/work-claim-integrity.mjs

Flagged, not fixed. All in `server/work-claim-integrity.mjs`.

- `:readBoardDeployStatus` — the `finally` clears `entry.promise` but leaves the stale `entry` in the WeakMap, so `flight.atMs` freshness is evaluated against a dead entry on the next call; combined with the `flight?.promise` early-return this is benign today, but the cache-invalidation story is subtle and worth an owner read.
- `:assertDependsOnKnown` — non-string ids are silently skipped ("the state machine reports the shape"); if the state machine ever stops checking shapes, garbage dependency ids pass validation.
- `:boardText` — `value.isWellFormed()` is called before the `typeof value === "string"` guard returns non-strings; safe today because of the early return, but reordering the checks would throw on non-strings.

Checked and clear: NFC/bidi/control-char handling, lease-hour bounds, PR input allowlisting (url-only), budget-reserve math, single-flight dedup structure.
