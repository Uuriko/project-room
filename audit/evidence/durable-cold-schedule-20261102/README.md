# Meaningful Native cold recovery schedule

Base: `ff3350cb8d2be1d1c7278677211eeea3282b7c75`. Test-only source: `4326857837025b57b814d040e2408504562bb752`.

Run: `node --test --test-name-pattern='verified offline archive runs the actual Native durable restore qualification' tests/runtime-package.test.js` using Node 24.22.1. Terminal exit 0, 1/1 passed, 48.7108 seconds. The verified archive contains the production source; test fixtures remain outside it. The wrapper re-verifies the archive unchanged after execution.

The old schedule restarted every tenth recovery continuation (plus the first), and after every cleanup call: 112 + 144 scheduled restarts, plus three fixed transitions. The new schedule uses 49 scheduled restarts (40 recovery, 9 cleanup) plus those same three fixed transitions: 52 rather than 259. Root's separate isolated original ff335 wrapper completed in 152.98 seconds. This comparison measures wall-clock fixture overhead in separate runs, not runtime CPU or a production recovery algorithm speedup. Both runs execute 1118 recovery continuations and 144 cleanup calls; the new receipt retains the same 6096 covered rows. The 160-second Native test and 180-second package wrapper limits are unchanged.

Cold coverage is explicit and asserted:

- The first recovery continuation, every observed recovery phase / audit-stage transition (19 transitions across 19 distinct observed stages (including return to the rooms stage)), and geometric progress calls 1 through 1024.
- The first observation of each of 27 distinct nested subsystem stages. This is deliberately not a restart at every report table's repeated source/sort transition.
- First cleanup, cleanup state transitions and geometric cleanup calls through 128. This fixture removes guards and report workspace concurrently; its observed labels are workspace then complete, not a separately observed guards-only stage.
- Partial import → fresh production constructor, sealed target → fresh constructor, and final fresh reopen remain mandatory.
- After EVERY scheduled restart, the exact just-acknowledged request is replayed against the fresh constructor and must return the exact receipt. Pending recovery readiness must remain 503.

EVERY existing per-call exact retry, incomplete verification, <=128-row advancement, revision increment, pending readiness503, cleanup drop/workspace/progress/source-derived call bound, publication verification, original independent final audit, cleanup completion, final readiness and saved message/work exact retry assertion remains. The full report version is still 1 and final unbounded oracle remains required. This patch does not change recovery runtime, schema, source input, budgets, authority or privacy rules.

The receipt includes observed and cold-covered main stage transitions, nested stage names, geometric checkpoints, every actual scheduled restart and its reasons. Equality assertions prevent silently observing a new returned stage without cold coverage. No separate direct Native run duplicated the packaged qualification. Targeted syntax/lint checks pass; committed-diff secret scan is retained separately.
