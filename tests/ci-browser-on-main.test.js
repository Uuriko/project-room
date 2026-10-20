// Contract: a push to main runs the browser shards. A main push skips the
// `changes` job, so the shards' condition must not exclude push events.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");

function jobBlock(name) {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("browser shards are not skipped on main pushes", () => {
  const block = jobBlock("browser-shards");
  const cond = block.match(/\n    if: (.+)\n/)[1];
  assert.doesNotMatch(cond, /event_name\s*!=\s*'push'/);
  assert.match(cond, /needs\.changes\.result != 'success'/);
});

test("the browser gate fails closed on an unexpected skip for every event", () => {
  const block = jobBlock("browser");
  assert.doesNotMatch(block, /Main push defers browser shards/);
  const failClosed = block.match(/Fail closed when shards were skipped unexpectedly\n\s+if: (.+)\n/)[1];
  assert.doesNotMatch(failClosed, /event_name/);
});
