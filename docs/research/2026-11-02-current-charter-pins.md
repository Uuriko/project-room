# Current charter and bounded pins

Source: main `00888c52110d36250d3e07629036701b72926d09`, then `3e5f8cb6b` and `9172ada16`. No deployment or production mutation performed.

Current charter reads use protected metadata. Default/current and revision zero work after cold restart; older normalized revisions return an explicit 409 and latest Link. Historical events remain stored. Legacy historical reads retain their behavior.

Pin/unpin reuses existing commands, permissions, reducer, canonical row and witness updates. GET pins contract 2 admits four unfiltered source candidates per page, filters DM/history/tombstone visibility, and returns an opaque viewer/head-bound continuation. Count describes only this page. An empty visible page may still have more. Restart invalidates cursors explicitly. The original fifty-pin global capacity remains enforced. Activation includes selected pinned bodies and an actionable continuation.

The default snapshot previously exposed private pin IDs through metadata. The fix filters against already-visible conversation records without additional body queries and marks `pinsWindow` partial with a GET pins pointer. A real bystander causal control fails without this filter; party visibility remains positive.

Focused behavioral qualification: 47/47, zero skipped. Includes private hidden-only pages, forged/rebound/stale cursors, all fifty pins over thirteen pages, since-join exclusion, reply ancestry, rollback after head insertion, exact command retry, cold restart, and full recovery audit. Actual production Native fixture: 1/1 at 1k and 5k history. Both sizes use identical pin-write 289 SQL / 1,566 physical reads / 41 writes; charter GET 114 / 947 / 0; pins GET 144 / 980 / 0. Unknown counters zero. These are warm request counters; constructor cost is separate. Pin mutation reads one legitimate 131-byte closed carrier, rather than whole state. Local Native wall time was 3.16s, not a CPU measurement.

Commands (Node 24):

```sh
node --test tests/current-pins-http.test.mjs tests/current-charter-read.test.mjs tests/pins-dm-visibility.test.js tests/pins-redacted-pin.test.js tests/current-charter-command.test.mjs tests/room-charter.test.js tests/room-activation-pack.test.js
node --test cloudflare/current-charter-pins-native.check.mjs
node scripts/secret-scan-diff.mjs --base 00888c52110d36250d3e07629036701b72926d09
```

The broader run including `openapi-source.test.js` is 47/48: its route-inventory mismatch reproduces with the exact original base HTTP source. The checker/allowlist was not relaxed. Native instrumentation initially mistook the small integrity-carrier read for full-state hydration; that failed assertion and corrected bounded measurement are both retained. Lint has zero errors with inherited warnings; source closure and secret diff checks pass.

Compressed causal, final and negative logs with uncompressed SHA-256 hashes are under `audit/evidence/current-charter-pins-20261102/receipt.json`. This is bounded selected pin serving, not a full-history or whole-recovery boundedness claim.
