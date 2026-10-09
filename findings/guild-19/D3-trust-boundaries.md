# D3 — Trust boundaries (guild-19)

What each layer may assume, and what it must re-establish. Violations found:
none in the surveyed code — the notes below are the places where a future
change is most likely to break the boundary.

## Boundary 1 — network → `body()`/`readText()` (`server/http.mjs`)

**Untrusted:** everything on the wire — bytes, `Content-Length` (lies),
`Content-Type` spelling/case, chunk timing, aborts.

**Established:** body is a JSON object (never array/scalar), ≤ limit bytes,
fully drained. A stalled sender can't hold the connection: declared-oversize
is refused while draining; unknown-length oversize is counted-then-dropped.

**Fragile point:** the `limit` argument. Every route gets 16384 except the
Telegram webhook (larger, embeds a replied-to message) and the MCP
attachment path. Raising a limit is a DoS-surface change — treat it like one.

**Verified:** M11 mutants (drop 415, allow arrays, 1000× declared-limit) all
killed; f16's 14 hostile bodies → 11×4xx, 0×500.

## Boundary 2 — route params & query strings

**Untrusted:** path segments, query values.

**Established:** params match anchored, length-capped regexes
(`[^/]{1,384}` etc.). No match → 404 before any handler runs, so handlers
never see an overlong id. Query values (`limit`, `after`, `before`) are
coerced defensively.

**Verified:** f17 — 16 hostile query/path shapes → 11×4xx, 5×200, 0×500,
including `%2e%2e` room ids and empty segments.

**Fragile point:** a new route that captures a param without a length cap, or
that interpolates a param into SQL/a shell. `columnExists()` in
`server/analytics/schema.mjs` interpolates its table argument into
`PRAGMA table_info(...)` — safe today only because all callers pass string
literals (f20 hostile-name sweep: no injection, no crash). Any future caller
with user input breaks this.

## Boundary 3 — validated fields → store

**Rule:** the store re-checks what it depends on. `RoomAttachmentBytes`
re-authenticates and re-runs the guest denial itself because `stage()`
bypasses `store.command` — the one place the room's scope gate is skipped,
and the denial is duplicated there deliberately (see the `denyGuestFiles`
refactor, re-verified R5/R6).

**Verified pattern:** `validId()` on ids at both route and store; TTL bounds
checked both in `guest-invites.mjs` route logic AND the SQL `CHECK`.

## Boundary 4 — validators vs their callers (the gap the mutants found)

The validators themselves are correct (all 15 mutation units: every mutant
that changed behavior was either killed or represented an untested guard —
no mutant exposed a bug in the original code). The weakness is **call-site
coverage**: several guards have no test pinning them (see `mutants.md`).
A future refactor could delete `FLAT_RESERVED`, the `sha256` length CHECK,
or the `Number.isSafeInteger` TTL guard and no test would fail.

## Boundary 5 — generated/vendored code

`server/vendor/gmail-html-sanitizer.mjs` is a generated sanitize-html
bundle (`scripts/build-gmail-sanitizer.mjs`). It is not hand-audited per
change; its contract is its config (allowlisted tags/attrs/schemes,
`disallowedTagsMode: "discard"`). f4's XSS corpus: no dangerous markup
survived. Regeneration must be diffed, not blindly accepted.

## What's explicitly NOT validated (by design)

- `claim-validate.mjs` does not check duplicate task-ids (needs live board
  state; the async rebuild refuses them).
- `scoreImportedEnvelope` never throws: unscannable envelopes score 0 rather
  than blocking ingestion (replay-determinism requirement).
- `displayNameSkeleton`'s lookalike table is explicitly non-exhaustive
  ("not all UTS #39 data") — documented, not a gap.
- `isReservedRoleName` is admission-only: replay of stored events and
  pre-existing members are unaffected.
