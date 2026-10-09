// d07: gotchas.
import { writeFileSync } from "node:fs";
const OUT = process.argv[2] + "/docs";
writeFileSync(OUT + "/gotchas.md", `# Gotchas (guild-11 slice docs)

## 1. Nanosecond vs millisecond (the a61e07c29 bug)

\`monitorEventLoopDelay().percentile(99)\` returns NANOSECONDS. The pre-fix
code stored the raw value into a gauge named \`event_loop_delay_ms_p99\` —
every real tick read ~250,000,000 "ms" and tripped critical instantly. The fix
divides by 1e6. If you touch this path, re-run repro r07.

## 2. Empty histograms lie

A fresh \`monitorEventLoopDelay\` reports a constant 511ns with \`count === 0\`.
511ns stored as ms would false-trip. \`collect()\` ignores count-0 ticks
entirely (no reset either — nothing was sampled). The gauge keeps its neutral
default instead of reporting a phantom reading.

## 3. The inclusive flag is a contract, not a default

Only \`write_limiter_penalty_entries\` sets \`inclusive: true\`. Every other
gauge trips STRICTLY above/below its threshold. Copy-pasting a gauge def
without the flag silently changes the boundary semantics — the contract test
pins warn >= 5 / critical >= 20 for the penalty gauge.

## 4. "unknown" is not "ok" (but the contract view maps it to ok)

Internal status "unknown" (never held a numeric value) is distinct from "ok".
\`telemetry/gauges.mjs\` maps both to contract "ok" ("no data yet reads as
nominal"). The /api/health/tripwires endpoint exposes the RAW internal
statuses — don't conflate the two shapes.

## 5. Threshold in the contract view is criticalAt, not warnAt

\`gauges[name].threshold\` is the TRIP threshold. Mutation u09 proved the
contract test does NOT pin which one it is (warnAt passes the shape check) —
only the harness does. If you change the view, assert the 0.1 on
event-budget-low explicitly.

## 6. Three copies of the finding spec

The finding-record validation logic is hand-duplicated in validate.mjs,
verify.mjs (validateRecord), and collect.mjs (validateRecord). They AGREE
today (verify additionally requires strict ISO UTC form; collect is the most
lenient on timestamp). Change one, change all three — or better, unify them.

## 7. submit.mjs / collect.mjs are cwd-relative

Both resolve \`telemetry/...\` against \`process.cwd()\`, not the script
location. Run them from the repo root. build-dashboard-data.mjs and
capture-baseline.mjs instead resolve against their own directory.

## 8. collect.mjs --live is a loaded gun

It reads the PRODUCTION room event API. The script itself warns: live wiring
is the telemetry-bus lead's call. Fuzz units only ever use --events fixtures.

## 9. pruneWindows is the only decay

There is no explicit gauge reset. Windowed gauges decay because
\`pruneWindows()\` runs on every record call AND on the slow tick. If you
add a windowed gauge, wire it into pruneWindows or it will never decay.

## 10. trackCommandOutcome's once-listener

The "close" listener records "timeout" ONLY if no terminal outcome was
recorded AND \`res.writableEnded !== true\`. An explicit \`record("ok")\`
before close always wins (settled flag). Mutation u07 proved the suite pins
this ordering.

## 11. SKIPPED_RECHECK_MS is unpinned

The 10-minute skipped-delivery recheck constant has no test coverage
(mutation u15 survived). Changing it changes retry latency silently.

## 12. Worker-safe imports

server/tripwires.mjs has NO static node: imports — the event-loop sampler
resolves lazily via \`process.getBuiltinModule\` so the module loads in
Cloudflare workerd (sampler degrades to null -> neutral default). Don't add
a static node: import to this file.
`);
console.log("d07 wrote docs/gotchas.md");
