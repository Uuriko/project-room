# Mutation results — wave1000 guild-07 (client-web)

Run started 2026-10-09T06:17:41.915Z. One mutant per source file line, affected test file(s) per mutant. KILLED = test failed. SURVIVED = tests passed despite the bug.

## M1 client/room-agent.mjs — KILLED
- scanBackward: bound=lo drops each window's boundary sequence (historic Instinct-3 VERDICTS 40 regression)
- tests: tests/room-agent-paginate.test.js, tests/mcp-room-messages-paging.test.js
- tests failed (exit 1); tail: 11,  13,  14,  16,  17, |        20,  22,  23,  25,  26,  28,  29,  31,  32,  34,  35,  37, |        38,  40,  41,  43,  44,  46,  47,  49,  50,  52,  53,  55, |        56,  58,  59,  61,  62,  64,  65,  67,  68,  70,  71,  73, |        74,  76,  77,  79,  80,  82,  83,  85,  86,  88,  89,  91, |        92,  94,  95,  97,  98, 100, 101, 103, 104, 106, 107, 109, |       110, 112, 113, 115, 116, 118, 119, 121, 122, 124, 125, 127, |       128, 130, 131, 133, 134, 136, 137, 139, 140, 142, 143, 145, |       146, 148, 149, 151, |       ... 46 more items |     ], |     expected: [ |         1,   2,   4,   5,   7,   8,  10,  11,  13,  14,  16,  17, |        19,  20,  22,  23,  25,  26,  28,  29,  31,  32,  34,  35, |        37,  38,  40,  41,  43,  44,  46,  47,  49,  50,  52,  53, |        55,  56,  58,  59,  61,  62,  64,  65,  67,  68,  70,  71, |        73,  74,  76,  77,  79,  80,  82,  83,  85,  86,  88,  89, |        91,  92,  94,  95,  97,  98, 100, 101, 103, 104, 106, 107, |       109, 110, 112, 113, 115, 116, 118, 119, 121, 122, 124, 125, |       127, 128, 130, 131, 133, 134, 136, 137, 139, 140, 142, 143, |       145, 146, 148, 149, |       ... 47 more items |     ], |     operator: 'deepStrictEqual', |     diff: 'simple' |   } | 

## M2 client/room-agent.mjs — SURVIVED
- scanForward: off-by-one on MESSAGE_SCAN_PAGES cap (allows 101 pages)
- tests: tests/room-agent-paginate.test.js
- tests passed with the mutant in place

## M3 client/agent-connection.mjs — KILLED
- privateStat: flipped uid identity check (accepts foreign-owned config)
- tests: tests/agent-connection.test.js
- tests failed (exit 1); tail: CLI save/check/task/watch and revocation preserve room authority and state (12955.825648ms) |   AssertionError [ERR_ASSERTION]: {"type":"agent_connection_error","code":"config_not_private","message":"Use an owner-only local directory and regular private file, without links.","status":"action_required","reason":"config_not_private","hint":"Unknown error 'config_not_private'. Re-check access and current work; if it repeats, report the code and full message to the room owner.","next":[{"tool":"room_check_access"},{"tool":"room_list_work"},{"command":"If it repeats, report error.code 'config_not_private' with the full message to the room owner — this code has no known recovery."}]} |    |    |   1 !== 0 |    |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000-guild-07/tests/agent-connection.test.js:184:10) |       at process.processTicksAndRejections (node:internal/process/task_queues:104:5) |       at async Test.run (node:internal/test_runner/test:1404:7) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) { |     generatedMessage: false, |     code: 'ERR_ASSERTION', |     actual: 1, |     expected: 0, |     operator: 'strictEqual', |     diff: 'simple' |   } | 

## M4 client/agent-connection.mjs — SURVIVED
- saveAgentConnection: dropped O_EXCL flag — silently overwrites existing connection
- tests: tests/agent-connection.test.js
- tests passed with the mutant in place

## M5 client/watch-journal.mjs — SURVIVED
- attentionCapacity: wrong version gate (v2 journals get 1001 slots)
- tests: tests/current-attention.test.js, tests/assignment-watcher.test.js
- tests passed with the mutant in place

## M6 client/watch-journal.mjs — TIMEOUT
- reconcile: off-by-one throws history_changed on equal sequence (G-eligible normal case)
- tests: tests/current-attention.test.js, tests/assignment-watcher.test.js
- test run exceeded 240s — possible hang, needs manual review

## M7 client/public-work-claims.mjs — SURVIVED
- match: wrong bound allows limit up to 50 (service contract is 5)
- tests: tests/public-work-claims-client.test.js
- tests passed with the mutant in place

## M8 client/public-work-claims.mjs — KILLED
- receipt: flipped state validation (rejects valid receipts, accepts garbage)
- tests: tests/public-work-claims-client.test.js
- tests failed (exit 1); tail: esponse |       at invalid (file:///home/hatch/workspace/pr-wave1000-guild-07/client/public-work-claims.mjs:7:23) |       at receipt (file:///home/hatch/workspace/pr-wave1000-guild-07/client/public-work-claims.mjs:30:117) |       at #action (file:///home/hatch/workspace/pr-wave1000-guild-07/client/public-work-claims.mjs:105:7) |       at process.processTicksAndRejections (node:internal/process/task_queues:104:5) |       at async TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000-guild-07/tests/public-work-claims-client.test.js:134:23) |       at async Test.run (node:internal/test_runner/test:1404:7) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) { |     status: 200, |     code: 'invalid_response', |     retryAfterMs: null, |     reason: 'invalid_response', |     hint: "Unknown error 'invalid_response'. Re-check access and current work; if it repeats, report the code and full message to the room owner.", |     next: [ { tool: 'room_check_access' }, { tool: 'room_list_work' }, { command: "If it repeats, report error.code 'invalid_response' with the full message to the room owner — this code has no known recovery." } ], |     errorStatus: 'action_required' |   } | 

## M9 client/request-runner.mjs — TIMEOUT
- isRequestEligible: flipped — closed/cancelled requests become runnable (G-L2)
- tests: tests/reply-agent.test.js
- test run exceeded 240s — possible hang, needs manual review

## M10 client/host-result.mjs — KILLED
- hostReplyBody: flipped XOR invariant on patch/artifactUrl (accepts both-or-neither)
- tests: tests/host-result.test.js
- tests failed (exit 1); tail: rnal/test_runner/test:969:18) |       at Test.postRun (node:internal/test_runner/test:1537:19) |       at Test.run (node:internal/test_runner/test:1462:12) |       at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) |  | test at tests/host-result.test.js:20:1 | ✖ linked artifact requires exact revisions and warns that the page can change (0.748874ms) |   Error: Invalid host result; return { body } with optional codeResult and keep the complete reply within 4096 characters |       at fail (file:///home/hatch/workspace/pr-wave1000-guild-07/client/host-result.mjs:7:28) |       at hostReplyBody (file:///home/hatch/workspace/pr-wave1000-guild-07/client/host-result.mjs:34:98) |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000-guild-07/tests/host-result.test.js:23:16) |       at Test.runInAsyncScope (node:async_hooks:227:14) |       at Test.run (node:internal/test_runner/test:1397:25) |       at Test.processPendingSubtests (node:internal/test_runner/test:969:18) |       at Test.postRun (node:internal/test_runner/test:1537:19) |       at Test.run (node:internal/test_runner/test:1462:12) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) | 

## M11 client/work-actions.mjs — KILLED
- confirmsAgentCommand: accepts sequence 0 receipts (weakens receipt validity)
- tests: tests/work-actions.test.js
- tests failed (exit 1); tail: ded requirements; the flip is event-sourced and replayable (2876.047721ms) | ✔ room policy: only the room owner sets it, and the command shape is strict (3415.643244ms) | ℹ tests 9 | ℹ suites 0 | ℹ pass 8 | ℹ fail 1 | ℹ cancelled 0 | ℹ skipped 0 | ℹ todo 0 | ℹ duration_ms 22749.866668 |  | ✖ failing tests: |  | test at tests/work-actions.test.js:63:1 | ✖ exact receipts bind operation fingerprint, event identity, cause, ordered arrays and omitted fields (17.017538ms) |   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |    |   true !== false |    |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000-guild-07/tests/work-actions.test.js:70:63) |       at Test.runInAsyncScope (node:async_hooks:227:14) |       at Test.run (node:internal/test_runner/test:1397:25) |       at Test.processPendingSubtests (node:internal/test_runner/test:969:18) |       at Test.postRun (node:internal/test_runner/test:1537:19) |       at Test.run (node:internal/test_runner/test:1462:12) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) { |     generatedMessage: true, |     code: 'ERR_ASSERTION', |     actual: true, |     expected: false, |     operator: 'strictEqual', |     diff: 'simple' |   } | 

## M12 client/attention-inbox.mjs — KILLED
- currentAttention: off-by-one — hasMore true when count equals returned items
- tests: tests/current-attention.test.js
- tests failed (exit 1); tail: 516369ms) |   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |    |   true !== false |    |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000-guild-07/tests/current-attention.test.js:46:72) |       at async Test.run (node:internal/test_runner/test:1404:7) |       at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) { |     generatedMessage: true, |     code: 'ERR_ASSERTION', |     actual: true, |     expected: false, |     operator: 'strictEqual', |     diff: 'simple' |   } |  | test at tests/current-attention.test.js:161:1 | ✖ bounded pull does not consume unseen rows; instruction and arbitrary work IDs have separate keys (14684.437344ms) |   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |    |   true !== false |    |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000-guild-07/tests/current-attention.test.js:168:70) |       at async Test.run (node:internal/test_runner/test:1404:7) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) { |     generatedMessage: true, |     code: 'ERR_ASSERTION', |     actual: true, |     expected: false, |     operator: 'strictEqual', |     diff: 'simple' |   } | 

## M13 client/host-process.mjs — KILLED
- configuredHost: off-by-one allows exactly one injected env var into sandbox
- tests: tests/host-process.test.js
- tests failed (exit 1); tail:  at Test.run (node:internal/test_runner/test:1397:25) |       at Test.processPendingSubtests (node:internal/test_runner/test:969:18) |       at Test.postRun (node:internal/test_runner/test:1537:19) |       at Test.run (node:internal/test_runner/test:1462:12) |  | test at tests/host-process.test.js:100:1 | ✖ adapter gets a typed data envelope rather than top-level room instructions (7.029068ms) |   Error: Host could not start; inspect its configuration |       at file:///home/hatch/workspace/pr-wave1000-guild-07/client/host-subprocess.mjs:56:20 |       at new Promise (<anonymous>) |       at hostSubprocess (file:///home/hatch/workspace/pr-wave1000-guild-07/client/host-subprocess.mjs:47:10) |       at file:///home/hatch/workspace/pr-wave1000-guild-07/client/host-process.mjs:44:28 |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000-guild-07/tests/host-process.test.js:102:48) |       at Test.runInAsyncScope (node:async_hooks:227:14) |       at Test.run (node:internal/test_runner/test:1397:25) |       at Test.processPendingSubtests (node:internal/test_runner/test:969:18) |       at Test.postRun (node:internal/test_runner/test:1537:19) |       at Test.run (node:internal/test_runner/test:1462:12) | 

## M14 client/agent-setup.mjs — SURVIVED
- connectRoom: off-by-one allows 101 setup destinations
- tests: tests/agent-setup.test.js
- tests passed with the mutant in place

## M15 client/mcp-stdio.mjs — SURVIVED
- room_acknowledge_wake: off-by-one rejects single-signal acks
- tests: tests/mcp-stdio.test.js
- tests passed with the mutant in place


## Totals
- mutants: 15, killed: 7, survived: 6, inconclusive/timeout: 2
