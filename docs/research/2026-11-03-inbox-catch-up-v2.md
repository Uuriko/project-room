# Inbox catch-up V2: witnessed progress after verified delivery

Source: base `bf44fdc5ec5c739fc867b790924ce4642de6fdaf`; Claude patch `bea225689d486b34fc14302937e62efc090e35c0` applied unchanged as `4a694cc88`. Patch SHA256 `19e3358eaf75a95ae8504486e6ee762e728fdb16e314826b129c4e468e440432`. Root-approved correction `e6fbcc0f4`; qualification `08ae07ce5`. This is an offline candidate, not a deployment receipt.

The original candidate failed both legal 64-event near-4 KiB cases (addressed DM first/last): bulk skip charging exhausted the shared input allowance before normal delivery. It also selected raw event IDs before scalar size admission. The correction completes the existing verified four-source window and standing-obligation discovery first. Optional witnessed skipping then uses only remaining records/bytes to advance the explicit continuation. It never loads a second body window or acknowledges attention.

Numeric scalar admission precedes event IDs, projected envelopes, witness payloads/receipts and canonical routing fields. Existing protected witness reads share the original allowance; projection fields only deny a skip. Missing, legacy, oversized or inconsistent routing stops skipping and leaves the next event to the full reader. No schema, header format, authorization or global budget change. Unwitnessed mention-state trust remains exactly the baseline's limitation, not a new integrity guarantee.

Actual Native SQLite synthetic complete traversal:

| DM position | Baseline calls / SQL / physical reads / returned SQL text bytes | Corrected calls / SQL / physical reads / returned SQL text bytes |
| --- | --- | --- |
| First | 16 / 2032 / 6801 / 1656234 | 2 / 713 / 2701 / 253134 |
| Last | 16 / 2032 / 6801 / 1656234 | 3 / 816 / 3041 / 331095 |

Both return the exact DM once, no unrelated body, and write zero rows; cold reopen preserves the first cursor. These are local physical counters and serialized SQL-result text, not database storage bytes, CPU or production latency. Existing 1k/5k private-backlog and tombstone checks also pass. Forty short unrelated messages before a mention take two calls; 100 unaddressed messages take three. The earlier first-page/11→1 claim does not describe this correction. Old/missing-header snapshots get no speculative gain; no genuine historical-header Native performance claim is made.

Validation: 59 affected Node tests pass (zero skips), including first/last large noise, nested precharged 200/512-record contexts, revocation, cold continuation, corrupt lookup/witness parity, private delivery, needs-me and digest; actual Worker check 1/1; changed-file ESLint exits0. Original candidate causal check was 0/2. Existing Native check/fixture registration is reused, with no new runtime module or boot allowlist entry.

Commands (Node24, repository root):

```
node --test tests/current-native-inbox.test.mjs tests/current-native-inbox-skip-integrity.test.mjs tests/current-native-inbox-skip-budget.test.mjs tests/needs-me-conversation-attention.test.js tests/needs-me-digest-coverage.test.js tests/needs-me-digest-overflow.test.js tests/agent-inbox.test.js tests/agent-inbox-keys.test.js tests/agent-inbox-optional-args.test.js tests/agent-inbox-work-discovery.test.js
node --test cloudflare/current-native-inbox-worker.check.mjs
node node_modules/eslint/bin/eslint.js server/current-native-inbox.mjs tests/current-native-inbox.test.mjs tests/current-native-inbox-skip-budget.test.mjs tests/current-native-inbox-skip-integrity.test.mjs cloudflare/current-native-inbox-worker.check.mjs cloudflare/current-native-inbox-worker.test-fixture.mjs
```

Hashed compressed causal/final logs and detailed per-call counters: `audit/evidence/inbox-catch-up-v2-20261103/receipt.json`. Formal work/request coverage remains independent and explicitly incomplete; conversation completion is not global attention completion.

## Follow-up: corrupt optional tail must not poison verified delivery

Root's independent counterexample reproduced on `ac3012608`: a valid addressed DM in the original four-source page was withheld when the optional fifth-source witness failed integrity verification. Baseline delivered the DM before encountering the error on its next page. Runtime correction `7fee39b7f` stops the optional per-source classifier on its existing integrity/bounded-input errors, retaining only earlier fully verified skips. It does not catch baseline errors or mark the source complete. The unconsumed corrupt row is verified normally on the next call and raises the exact original error.

The regression tests both first-optional-row corruption and corruption after two valid skips, asserting exact DM delivery, frontier, incomplete cursor and identical next-page integrity error. Before: 0/1. After: 29/29 focused Node tests, Native existing check 1/1, changed-file lint and diff secret scan clean. Native rerun qualifies unchanged healthy/cold/cost behavior; the new deliberate corrupt-tail controls are Node SQLite tests, not a new Worker corruption claim. Logs/hashes are in `later-corrupt-receipt.json` alongside the original receipt. No additional schema, routing, grants or reader changes.
