// The self-host journey harness (scripts/selfhost-journey.mjs) boots the real server.mjs on a
// disposable SQLite file and runs the join/invite/task/review/changes/accept, restart, retry,
// backup/revoke/restore/reconcile and export/import legs. CI has no Caddy, so this runs
// `--proxy none`: the TLS leg must be NOT-RUN and every other leg must PASS.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("self-host journey passes every non-TLS leg against the real server process", { timeout: 180000 }, () => {
  const run = spawnSync(process.execPath, ["scripts/selfhost-journey.mjs", "--proxy", "none", "--json"], { cwd: root, encoding: "utf8", timeout: 170000 });
  assert.equal(run.status, 0, run.stdout.slice(-2000) + run.stderr.slice(-500));
  const result = JSON.parse(run.stdout);
  assert.equal(result.fail, 0);
  assert.equal(result.blocked, null);
  assert.equal(result.pass, result.legs.length - 1);
  const notRun = result.legs.filter(leg => leg.status === "NOT-RUN");
  assert.deepEqual(notRun.map(leg => leg.name.split(":")[0]), ["TLS"]);
  assert.match(result.label, /not the invite-only deployment/);
  assert.equal(JSON.stringify(result).includes("room-selfhost-journey-"), false, "output must not carry temporary paths");
});
