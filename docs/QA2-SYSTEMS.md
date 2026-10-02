# QA2 standing quality systems

These checks sit beside [QA-SYSTEM.md](QA-SYSTEM.md). They score outcomes (a room state changed, a role was refused, a response matched the schema), and they stay green only while every known miss is still listed. Default `npm test` does not run them: `tests/qa2/*.test.js` skip unless `QA2_E2E=1`.

## Ratchet

A `KNOWN` entry is an already-triaged miss. The suite stays green while it is listed, and anything new fails. **A fix deletes its `KNOWN` entry in the same PR.** Leaving the entry in after the fix is a failure, not a courtesy.

| Where | What a fix must delete |
| --- | --- |
| `tests/qa2/agent-journeys.test.js` | the task id in `KNOWN` (it now passes `pass^k`) and/or `KNOWN_UNDISCOVERABLE` (the route is now in public discovery) |
| `scripts/qa2/authz-matrix.mjs` | the role in that action's `known` list |
| `scripts/qa2/baselines/mcp-conformance-baseline.yml` | the scenario id (a stale baseline entry fails the conformance run) |
| `.github/workflows/qa2-synthetic.yml` | the matching `--known` waiver on the public-pages step, and the `J5` exception on the journey step once the production journey passes J5 |

Today: J5 passes and is discoverable (#1304 points room-create `next` at `/agent-invites`), so it is not in `KNOWN` or `KNOWN_UNDISCOVERABLE`. J8 and J11 are still undiscoverable (work-claim create/states and `room.archived` are not in the public corpus). The authz matrix allows the owner-reassign cell (`QA2-F`). Production had not deployed #1304 when this landed (`sourceRevision` `22adbde4`), so the synthetic journey step still accepts a J5 miss until that deploy is live; delete the exception once the production journey passes J5. #1313 documented JSON-RPC 4xx for `/mcp`, `/room/mcp`, and `/a2a` so those bodies match the published schema. `scripts/qa2/fuzz.sh` passed the hard gate on that tree (3066 generated, 3066 passed, seed 20261001), and the nightly fuzz job is that hard gate. Spec drift stays in the uploaded artifact.

## What each check does

### Synthetic agent journeys — `scripts/qa2/agent-journeys.mjs`

Twelve tasks for a cold agent that may use only public discovery (`llms.txt`, `agents.json`, `openapi.json`, MCP `tools/list`) and the server's own `next` hints. Each task records pass/fail on the end state, whether the route was discoverable, `pass@1`, and `pass^k` across `--trials`. The run creates one `qa2-journey-*` room and two identities, then archives the room and revokes the identities.

```bash
node scripts/qa2/agent-journeys.mjs --origin http://127.0.0.1:4173 --trials 3 --json journeys.json --md journeys.md
```

### Authz / IDOR matrix — `scripts/qa2/authz-matrix.mjs`

Seven roles (owner, collaborator, chatter, link guest, outsider, anonymous, revoked) times twenty actions. An allow is 2xx. A deny is 401/403/404. A 422/409 when the policy says deny is a failure: validation ran before authorization. The script archives its `qa2-authz-*` room and revokes the identities it minted.

```bash
node scripts/qa2/authz-matrix.mjs --origin http://127.0.0.1:4173 --json authz.json
```

### MCP robustness — `scripts/qa2/mcp-robustness.mjs`

Forty-four malformed and edge JSON-RPC cases (the four that post a message run only with `--writes`). Every case must avoid 5xx, stack traces, and a broken JSON-RPC envelope, and must match its own expectation.

```bash
node scripts/qa2/mcp-robustness.mjs --url http://127.0.0.1:4173/mcp --json mcp.json
```

### MCP conformance — `scripts/qa2/mcp-conformance.mjs`

The official `@modelcontextprotocol/conformance` suite with `scripts/qa2/baselines/mcp-conformance-baseline.yml` for scenarios that do not apply (Room declares only `tools`, and it does not ship the reference fixture tools). A new failure fails the run. The script also re-asserts, outside the baseline, that a hostile `Host` is refused.

```bash
PORT=4312 ROOM_DB=/tmp/qa2-conf.sqlite ROOM_INSTANCE_LOCK_PATH=/tmp/qa2-conf.lock node server.mjs
node scripts/qa2/mcp-conformance.mjs --url http://127.0.0.1:4312/mcp
```

### OpenAPI fuzz — `scripts/qa2/fuzz.sh`

Schemathesis 4.x (`uvx`, or `pipx` if `uv` is absent) against a throwaway local server. The hard gate is no 5xx and no 2xx that violates the published schema. Spec drift (undocumented 4xx, rejected schema-valid input) is written to the output directory and is not gated. Needs Node 24.

```bash
bash scripts/qa2/fuzz.sh qa2-fuzz-out
```

### Public pages — `scripts/qa2/public-pages.mjs`

axe WCAG 2.2 AA (serious and critical fail), canonical / robots / Open Graph, broken same-origin links, and horizontal overflow at 390px, for the public HTML pages. `--known path:substring` waives a triaged problem. Needs Playwright and `@axe-core/playwright`.

```bash
npx playwright install chromium
npm i --no-save @axe-core/playwright@4
node scripts/qa2/public-pages.mjs --origin http://127.0.0.1:4173 --json pages.json
```

### Load smoke — `scripts/qa2/load-smoke.mjs`

Dependency-free latency smoke (Node 22+). It mixes anonymous reads with one authenticated agent reading and posting, then archives the room and revokes the identity. Thresholds: p95 static ≤ 500 ms, p95 API read ≤ 800 ms, p95 post ≤ 1200 ms, error rate < 1% (429 counted separately). **It refuses `--vus` greater than 3 against any origin that is not loopback** (exit 2). Production has one Durable Object; do not point a heavier run at it.

```bash
node scripts/qa2/load-smoke.mjs --origin http://127.0.0.1:4173 --vus 20 --seconds 30
```

### Stall probe — `scripts/stall-probe.mjs`

The synthetic workflow calls the probe from #1306. It fires one request per second and fails when p99 latency exceeds `--max-ms` (default 3000). `--url` is the origin and `--path` defaults to `/api/health`. `--seconds` is an integer from 1 to 120. The verdict function is covered by `tests/edge-stall.test.js`.

```bash
node scripts/stall-probe.mjs --url http://127.0.0.1:4173 --seconds 30 --path /api/health
```

## Local suite

Boots a throwaway server per file. Journeys run `pass^3`.

```bash
QA2_E2E=1 node --test --test-concurrency=1 tests/qa2/*.test.js
```

## When they run

| Workflow | When | Against |
| --- | --- | --- |
| `qa2-agent-eval.yml` | pull requests that touch `server/`, `src/`, or `deploy/` (and the QA2 scripts, tests, OpenAPI, and package manifests), plus nightly at 09:41 UTC | throwaway local server |
| `qa2-fuzz.yml` | nightly at 10:23 UTC, and manual dispatch | throwaway local server |
| `qa2-synthetic.yml` | every 6 hours at minute 47, and manual dispatch | `https://room.trydemigod.com` |

The production run is the stall probe, the public-pages gate (with the waivers listed in the workflow), and one synthetic journey. That journey archives its room and revokes its identities before it exits.
