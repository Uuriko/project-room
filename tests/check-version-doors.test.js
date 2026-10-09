import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { classifyDoors, waitDoors } from "../scripts/check-version-doors.mjs";

const script = fileURLToPath(new URL("../scripts/check-version-doors.mjs", import.meta.url));
const NEW = "b".repeat(40);
const OLD = "a".repeat(40);

test("classifyDoors names each door combination", () => {
  assert.equal(classifyDoors({ sha: NEW, doRev: NEW, workerRev: NEW }), "converged");
  assert.equal(classifyDoors({ sha: NEW, doRev: OLD, workerRev: NEW }), "do-stale");
  assert.equal(classifyDoors({ sha: NEW, doRev: NEW, workerRev: OLD }), "worker-stale");
  assert.equal(classifyDoors({ sha: NEW, doRev: OLD, workerRev: OLD }), "other");
  assert.equal(classifyDoors({ sha: NEW, doRev: null, workerRev: null }), "other");
});

function fakeOrigin(revs) {
  const server = createServer((req, res) => {
    const rev = req.url === "/api/version" ? revs.doRev : req.url === "/api/version/worker" ? revs.workerRev : undefined;
    if (!rev) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sourceRevision: rev }));
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}
const run = (args) => new Promise(resolve => execFile(process.execPath, [script, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));

test("waitDoors waits out a DO that is still on the old revision", async () => {
  const revs = { doRev: OLD, workerRev: NEW };
  const { server, origin } = await fakeOrigin(revs);
  try {
    let polls = 0;
    const out = await waitDoors({ origin, sha: NEW, waitMs: 5000, pollMs: 1, sleep: async () => { if (++polls === 2) revs.doRev = NEW; } });
    assert.equal(out.state, "converged");
    assert.ok(polls >= 2, "it polled again instead of trusting the first read");
  } finally { server.close(); }
});

test("CLI exit codes: converged 0, DO still old 3, worker old 4, other 5", async () => {
  const cases = [[{ doRev: NEW, workerRev: NEW }, 0], [{ doRev: OLD, workerRev: NEW }, 3], [{ doRev: NEW, workerRev: OLD }, 4], [{ doRev: OLD, workerRev: OLD }, 5]];
  for (const [revs, code] of cases) {
    const { server, origin } = await fakeOrigin(revs);
    try {
      const r = await run(["--origin", origin, "--sha", NEW, "--wait-ms", "0"]);
      assert.equal(r.code, code, JSON.stringify(revs));
      assert.equal(JSON.parse(r.stdout).sha, NEW);
      if (code === 3) assert.match(r.stderr, /DO still on old revision/);
    } finally { server.close(); }
  }
});

test("CLI rejects a missing origin or a short sha", async () => {
  assert.equal((await run(["--sha", NEW])).code, 2);
  assert.equal((await run(["--origin", "http://127.0.0.1:1", "--sha", "abc"])).code, 2);
});

test("workflows read both doors: gate skips on converged or do-stale, drift settles", () => {
  const prod = readFileSync(new URL("../.github/workflows/deploy-prod.yml", import.meta.url), "utf8");
  parse(prod);
  assert.match(prod, /node scripts\/check-version-doors\.mjs --origin "\$PROD_ORIGIN" --sha "\$SHA"/);
  assert.match(prod, /3\) skip "auto: .*Durable Object door is still on its old revision"/);
  assert.doesNotMatch(prod, /curl[^\n]*\/api\/version" \| jq/, "the single-door live read is gone from the gate");
  const drift = readFileSync(new URL("../.github/workflows/deploy-drift.yml", import.meta.url), "utf8");
  parse(drift);
  assert.match(drift, /--settle-ms 120000/);
});
