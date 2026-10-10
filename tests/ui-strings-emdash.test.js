// Anti-slop adoption #4: build-ui-strings --check rejects em dashes in UI copy.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("strings/en.json has no em dash in any user-facing string", () => {
  const catalog = JSON.parse(readFileSync(new URL("../strings/en.json", import.meta.url), "utf8"));
  const dashed = Object.entries(catalog).filter(([key, value]) => key !== "_meta" && typeof value === "string" && value.includes("\u2014"));
  assert.deepEqual(dashed.map(([key]) => key), []);
});

test("build-ui-strings --check passes on the current catalog and names the em-dash rule", () => {
  const run = spawnSync(process.execPath, ["scripts/build-ui-strings.mjs", "--check"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(new URL("../scripts/build-ui-strings.mjs", import.meta.url), "utf8"), /must not use an em dash/);
});
