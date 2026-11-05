# Adopted OAuth selected-work read reservation

Source: main `7320a9354`; runtime `707247372`; Native check `6fc5c3fd8`.

The actual hosted MCP `room_read_work` single brief returned 409 on a legitimate five-member room with two tasks, an account-adopted existing agent, an OAuth grant, a saved native-text result, independent verification at task revision 4, and twelve subsequent posts. The failure occurred after authentication while reading the protected history floor. The same HTTP fixture passes after giving `RoomStore.workContext` a fixed 512-record reservation. The prior 200-record default remains for other operations. Protected readers, per-record 128 KiB, aggregate 256 KiB, source bounds, authentication and permissions are unchanged. An inherited outer 200-record context remains stricter and still refuses.

The measured selected context fails at 201 charged records / 102,245 input bytes and completes at 206 / 104,305. This is a record-count false refusal, not excessive content. No caching, broad hydration, new schema or grant was introduced.

Actual hosted HTTP tests cover single brief, two-item batch, exact saved-result read, cold reopen, missing work, revoked identity and unchanged sequence. The new test plus existing post/fault/oversize, MCP work-context and private-existence boundary tests pass 14/14. Native SQLite passes 1/1 for the equivalent OAuth principal gate and selected tool composition, batch and cold reopen; this Native fixture calls the existing tool helpers rather than HTTP. It resolves the principal before the tool transaction, matching hosted MCP's gate. Whole-room hydration throws in both fixtures.

Native warm bundled brief/result: 780 SQL statements, 4,542 physical rows read, 876,149 returned SQL string bytes, 77,156 SQL text bytes, 27,290 bound-parameter bytes, zero adapter writes and six raw permit writes. Batch: 522 statements, 2,295 rows, 432,177 returned bytes, 51,382 SQL text bytes, 15,724 parameter bytes, zero adapter writes and two raw permit writes. Cold bundled read: 787 statements / 6,179 rows / 877,981 returned bytes, zero adapter writes and eight raw permit writes. No unknown counter operations. Worker wall observations 19/6/19 ms are local illustrative measurements, not production latency or CPU. Repeated authentication and metadata transfer remain substantial; the logical input cap does not cap total repeated SQL transfer.

Commands:

```
node --test tests/current-oauth-work-read.test.mjs tests/current-work-linked-post.test.mjs tests/private-existence-boundary.test.js tests/mcp-work-context.test.js
node --test cloudflare/oauth-work-read-native.check.mjs
```

Node executable: `/Users/johnpotter/.local/bin/node` (24). Lint has zero errors and 30 inherited Store warnings. Synthetic causal and result logs, hashes and raw Native counters are in `audit/evidence/oauth-work-read-budget-20261102/receipt.json`. No production writes, push or deployment occurred. This does not qualify arbitrary large rooms or eliminate remaining bounded refusals.
