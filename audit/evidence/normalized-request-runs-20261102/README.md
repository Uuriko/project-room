# Normalized request execution reservations

Source is pinned in receipt.json. Runtime changes are 347910d41 then 5c8fa9e17; e37af8e66 and 19b3f36fb add controls. No publication/deployment is claimed.

RequestRuns apply uses protected selected request, opening message/event, room and requester facts instead of Store.room. Existing permanent attempt ownership, no duplicate claim launch, stale-basis, DM, pause, active requester, history, terminal and delivery rules remain. Lost response does not authorize a fresh execution: an already reserved claim still refuses with request_run_owned. Real failed transaction rolls back reservation; actual Native cold restart retains it.

The initial all-room list cap had a privacy bug: 33 unrelated private runs changed a bystander's empty map into a refusal. The retained red reproduces it. The replacement uses four exact derived indexes: requester and recipient prefixes over current request records, plus the independent policy-1 opening events. Each prefix admits at most 33 IDs, then caps the viewer-party union at 32 before payload hydration. Every candidate must bind the protected request, independently protected opening message and opening event. Moving either selector independently cannot silently omit the run. Coordinated corruption of both sources remains full-audit scope. Existing exact serving-index schema admission includes all four indexes; no new table, domain, format version or grant.

The v1 map is complete or refused. More than 32 OWN party requests refuses even if none has a run. Smaller selections can also refuse under the existing 200-record/256 KiB read budget. This is explicit bounded support, not a promise that every 32-request selection fits. Unrelated private requests do not affect that cap. Legacy v1 behavior is unchanged.

## Executed checks

- `/Users/johnpotter/.local/bin/node --test tests/current-request-runs.test.mjs tests/updates-request-context-privacy.test.js`: final 20/20, no skips, exit 0. Includes recipient/requester observations, exact attempt ownership, failed-save rollback, stale basis, terminal transitions, real 32/33 hidden-run boundary, equal-instant since-join source sequence, selector corruption, and four indexed EXPLAIN plans with no temporary sort.
- `/Users/johnpotter/.local/bin/node --test cloudflare/current-request-runs.check.mjs`: actual default July Native, final 1/1, exit 0. Real saved-reservation fault rollback, dispose/cold reopen, duplicate claim refusal and needs_attention, then 33 hidden requests with an unrelated viewer.
- ESLint on the five source/test files: exit 0, zero errors, four existing warnings (three currentrepo, one original members lookup).

Native statement observer excludes constructor and setup from the two bystander list samples. Four party probes read zero source rows before and after 33 hidden requests; both return {} and write zero adapter rows. Whole adapter list cost is 60 statements/1,265 rows before versus 64/1,269 after; the initial exact-equality assertion failed and is retained. The final check attributes the four source probes separately rather than hiding metadata/cache overhead. No Cloudflare CPU, billing or production latency claim. These are adapter SQLite cursor counters, not a complete raw-native maintenance counter.

The old isolated reply-only resume test now passed its request-run and saved-answer steps, then failed its final unlink assertion because this branch lacked the separately integrated unlink cure. Root subsequently reported that entire test green on its current composition. That external result is not counted as this branch's test.

The first broad-list fixture hit the real chat flood guard; its failure is retained. The fixture now advances its synthetic clock 3 seconds per new message, preserving production rate-limit policy. The first event-selector corruption test accidentally matched a command ID instead of an event ID and mutated zero rows; the fixed test addresses the canonical message sequence and asserts exactly one changed event. No runtime control was weakened.

Logs are gzip-compressed complete outputs with hashes in receipt.json. Synthetic fixtures only; no production calls, accounts or credentials.
