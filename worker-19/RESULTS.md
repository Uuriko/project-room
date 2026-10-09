# WORKER 19 — results (fuzz target 18: account-rooms + from-template)

## Shard resolution
Launcher shard spec (`grep -nE 'app\.(get|post|put|patch|delete|use)\(' server/http.mjs`,
index mod 50 == 18) matches **0 handlers**: server/http.mjs is a raw
`node:http` dispatch (line 920), no Express anywhere in the repo, and the
pattern never existed in the file's history. Partition as written is vacuous
for all 50 workers. Worker 19 instead ran the guild's own 50-target fuzz plan
(fuzz/targets.mjs): 18 mod 50 == 18 → target 18.

## What was fuzzed
- Guild runner: `node fuzz/run.mjs 18 18 worker-19/target-18.json` — 51 cases
  (method matrix incl. raw TRACE, malformed JSON bodies, invalid UTF-8,
  16k headers/host-spoof/bearer-garbage, 8k queries, null bytes).
  Result: **0 findings, 0 crashes** → target-18.json.
- Gap sweep `post-gap-18.mjs`: POST /api/account-rooms JSON-body fuzz (38 cases;
  target 18's case list never POSTed a body to the create endpoint).
  Result: **0 findings** (1 FETCH-ERROR was my script mishandling the raw-TRACE
  case — harness noise, not a server signal).
- Wrong-status probes `wrong-status-18.mjs` (with well-formed x-session-binding):
  unauthenticated → 401 `unauthenticated` on all 3 routes; `?after=` x2 → 422
  `invalid_room`; malformed bodies → 401 (auth runs before body parse, by
  design). All correct.

## Findings
None. No crash, hang, or wrong-status in shard 19's routes.

## Blocking infra bug found + fixed (shared harness, uncommitted)
`fuzz/adversarial.mjs:34-36` — `jsonCases()` referenced undefined `body`
(→ `ReferenceError: body is not defined`) for the `json:no-content-type`,
`json:text-plain`, `json:charset-param` cases. Any `fuzz/run.mjs` invocation
over a target using `p()` (most of the 50 targets) crashed before sending a
single case. Fixed to `body: '{"a":1}'` (one-line-class, matches intent).
No other fuzz processes were running; `fuzz/` is untracked so the coordinator's
final commit carries the fix.

## Coverage gap (honest)
Authenticated path (valid session + CSRF + binding → body parsing inside
`createAccountRoom`/`applyRoomTemplate`) was NOT fuzzed: the acceptance fixture
ships no accountAccessKey to mint a logged-in session. All probes stopped at
401, which is correct behavior, but handler bodies past auth are unexercised
by this worker. Recommend a follow-up worker with a login-capable fixture.
