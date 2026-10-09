// d03: dashboard data flow.
import { writeFileSync } from "node:fs";
const OUT = process.argv[2] + "/docs";
writeFileSync(OUT + "/data-flow.md", `# Dashboard data flow (guild-11 slice docs)

Two separate pipelines feed the two dashboards. Neither writes to production.

## Pipeline A: findings dashboard (telemetry/dashboard.html)

\`\`\`
telemetry/findings.jsonl        (append-only JSONL, one finding per line)
        |  (or telemetry/seed-findings.jsonl when findings.jsonl is absent)
        v
telemetry/build-dashboard-data.mjs
  - reads every non-blank line, JSON.parse each
  - THROWS on the first corrupt line (fail-fast; names the line number)
  - writes telemetry/findings.json as a pretty-printed JSON array
        v
telemetry/findings.json        (generated artifact, checked in)
        v
telemetry/dashboard.html       (static page; reads findings.json; data hooks
                                data-guild / data-category / data-confidence,
                                or the equivalent dataset.* DOM writes)
\`\`\`

Fail-fast note: a single corrupt JSONL line aborts the whole build. This is
deliberate (mutation u12 proved no test pins the skip-vs-throw choice — the
current contract is throw).

## Pipeline B: ops dashboard (telemetry/ops-dashboard.html)

\`\`\`
live room server
  GET /api/health/tripwires  ->  { updatedAt, gauges: [ {name,value,warnAt,criticalAt,status,updatedAt} x5 ] }
        |
        v (fetch, browser)
telemetry/ops-dashboard.html   ("Load baseline JSON…" compares against a snapshot)
        ^
        |
telemetry/capture-baseline.mjs [--host http://127.0.0.1:8787]
  - fetches the endpoint, writes telemetry/baseline-<ISO>.json
  - coordinators snapshot before/after their change and diff
\`\`\`

The live gauge feed is the in-process singleton from server/tripwires.mjs,
fed by server/http.mjs hook points. The ops dashboard never touches the room
event log.

## Contract pins

- \`telemetry/tripwire-contract.test.mjs\`: 5 canonical kebab-case names,
  {value, threshold, status} shape, status in ok|warn|trip.
- \`telemetry/verify.mjs\` check D: dashboard.html must mention
  "Swarm Telemetry Bus", reference findings.json, and carry the three data
  hooks (literal or dataset.*).
- \`telemetry/verify.mjs\` check F: no .mjs component POSTs to
  room.trydemigod.com (read-only guarantee, grep-enforced).
`);
console.log("d03 wrote docs/data-flow.md");
