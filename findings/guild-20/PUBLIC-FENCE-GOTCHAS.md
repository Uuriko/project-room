# public-work-claim-fence gotchas (`server/public-work-claim-fence.mjs`)

## 1. The permit is a row, not a lock — and that's fine

`withPublicWorkClaimWriter` serializes concurrent entrants via `BEGIN IMMEDIATE`, not via the
permit. The permit's job is narrower: make *unpermitted* writes fail loudly at the SQL layer
even if a code path forgets to wrap itself. Don't add locking around the permit; the database
already does it. (Verified: 2 processes × 60 concurrent entries → serialized, 0 gate violations.)

## 2. Nesting is refused by the *check*, not by SQLite

`store.transaction` re-enters (nested call runs inside the parent txn). So a nested
`withPublicWorkClaimWriter` reaches the inner permit check, sees `enabled=1`, and throws
`Public claim writer permit must be closed before entry`. The outer `finally` then resets the
permit and the outer transaction rolls back. Net effect: nesting fails cleanly, nothing commits.
If you need nested public-claim writes, restructure — the fence will not let you through.

## 3. The `finally` close is load-bearing

Mutation M-04 (removing the `UPDATE permit SET enabled=0`) breaks everything downstream: the
next entry throws "must be closed before entry", and `verifyPublicWorkClaimFence` fails at rest.
The `isTransaction` guard on the close exists because an I/O failure may already have rolled
the transaction back — without it, the close would mask the real error with "no transaction".

## 4. Async functions are refused

`fn()` returning a thenable throws `Public claim transactions must remain synchronous`. The
permit must never be held across an event-loop turn: an interleaved `await` inside would let a
second logical writer observe `enabled=1`... actually no — it would just hold the DB write lock
across I/O. The refusal keeps transactions short and the permit window tight.

## 5. Trigger scope is `public_work_tasks.namespace_key = NEW.room_id`

The fence protects a claim row iff its `room_id` appears as a `namespace_key` in
`public_work_tasks`. Rows in private namespaces pass without the permit — by design (this is
upgrade compatibility, not a security boundary against the DBA; see the header comment).
`verifyPublicWorkClaimFence` additionally requires the permit **closed at rest** — an open
permit on a quiescent database is always a bug.

## 6. Schema evolution needs both halves

Adding a protected table means: a trigger definition in `definitions`, the table in the schema,
and the `verifyPublicWorkClaimFence` shape check updated. The `normalize()` comparison is
whitespace-insensitive but otherwise exact — same verbatim-SQL discipline as the writer fence.
