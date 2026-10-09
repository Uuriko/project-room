# R10 — deep review: wave500/presence-w4-delta (boardSeq / ?since= deltas)

Branch: `origin/wave500/presence-w4-delta` — "F3 (wave500 W4, ported from
wave300-fanout-perf)". Headline feature: every room carries a monotonic
`boardSeq`, bumped on every claim mutation; the board list accepts
`?since=N` and returns only claims with `boardSeq > N` (delta mode),
plus room-wide open/terminal counts. Clean rebase onto origin/main;
2/2 suites pass.

## The feature works — in tests only

The branch stamps `boardSeq` in exactly one place: the **in-memory**
`createWorkClaimRegistry()` in `server/work-claim-routes.mjs`:

```js
set(roomId, item) {
  const stamped = { ...item, boardSeq: nextBoardSeq(roomId) };
  ...
}
boardSeq(roomId) { return seqs.get(roomId) ?? 0; },
```

But production never uses that registry. `server/http.mjs:3584` passes
`registry: store.workClaims`, and `server/store.mjs:1119` builds it as:

```js
this.workClaims = createDurableWorkClaimRegistry(this.db, { ... });
```

The durable registry (`server/work-claim-sqlite.mjs`) has **zero**
`boardSeq` references on this branch (verified via `git grep`).

Consequences in production:
1. `typeof registry.boardSeq === "function"` is false → the list route
   passes `boardSeq = 0` → every page reports `boardSeq: 0`, forever.
2. Stored items carry no `boardSeq` → the delta filter
   `(item.boardSeq ?? 0) > deltaSince` is false for every `since >= 0` →
   `?since=N` returns an **empty delta, permanently**.
3. A client polling `?since=<last seen>` will never observe a single
   board change. The feature is a silent no-op.

Why the suite is green: every test exercises the in-memory registry,
where stamping works. This is the classic test-seam/production
divergence — the branch's own tests cannot catch it because the seam
they test is not the seam production uses.

## Secondary findings

- **Shape leak (minor):** the strip-everywhere-else discipline misses one
  path — the review route (line 1213):
  `return json(res, 200, duplicate ? stripBoardSeq(item) : reviewed);`
  The fresh `reviewed` item (spread from the stored, stamped item)
  carries `boardSeq` on the response while the duplicate path strips it.
  Inconsistent with the documented invariant that non-board surfaces
  keep their existing shape.
- **Status-code inconsistency (minor):** `boardDeltaSinceOf` rejects with
  `400 invalid_input`; the module's query-param convention everywhere
  else is 422 via `invalidInput`.
- **Unbounded delta (advisory):** delta mode sets `hasMore: false` and
  returns *all* changed claims without applying `limit` — a busy board's
  delta payload is unbounded. Consider honoring `limit` with a
  continuation cursor.

## Verdict

Do not merge as-is. The fix is to port `boardSeq` stamping to the
durable registry (`server/work-claim-sqlite.mjs`): persist a per-room
sequence (a `board_seq` counter row or a MAX over a stamped column),
stamp it on every write path, and expose `boardSeq(roomId)`. Add a
regression test that runs the `?since=` flow against the **durable**
registry, not just the in-memory one — the current test suite is blind
to exactly this failure. This is the most significant re-verify finding
of the wave for this slice: a green-suite feature that does nothing in
production.
