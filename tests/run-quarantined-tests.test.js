// T-4 vacuity canaries for scripts/run-quarantined-tests.mjs
// (find:run-quarantined-tests-001 / SYSTEMIC-MAP F-28): the quarantine
// lane must be able to fail on a dangling entry, and an empty list must
// announce itself instead of passing as a silent no-op.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { checkEntries, parseEntry } from "../scripts/run-quarantined-tests.mjs";

const ioFor = files => ({
  exists: abs => Object.keys(files).some(name => abs.endsWith(name)),
  read: abs => files[Object.keys(files).find(name => abs.endsWith(name))],
});

test("parseEntry splits the file > name convention", () => {
  assert.deepEqual(parseEntry({ test: "tests/a.test.js > does a thing" }),
    { spec: "tests/a.test.js > does a thing", file: "tests/a.test.js", name: "does a thing" });
  assert.deepEqual(parseEntry({ test: "tests/a.test.js" }),
    { spec: "tests/a.test.js", file: "tests/a.test.js", name: null });
});

test("existence check passes for a real file and a real test name", () => {
  const io = ioFor({ "tests/a.test.js": 'test("does a thing", () => {});' });
  assert.deepEqual(checkEntries([{ test: "tests/a.test.js > does a thing" }, { test: "tests/a.test.js" }], io), []);
});

test("existence check FAILS on a missing file (the gate can fail)", () => {
  const io = ioFor({});
  const problems = checkEntries([{ test: "tests/gone.test.js" }], io);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not exist/);
});

test("existence check FAILS on a named test that no longer exists (zero-test pattern match)", () => {
  const io = ioFor({ "tests/a.test.js": 'test("some other name", () => {});' });
  const problems = checkEntries([{ test: "tests/a.test.js > renamed away" }], io);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not found/);
});

test("existence check FAILS on an entry with no file", () => {
  assert.equal(checkEntries([{ test: "" }], ioFor({})).length, 1);
  assert.equal(checkEntries([{}], ioFor({})).length, 1);
});

test("the live runner prints the EMPTY canary for the committed empty list", () => {
  const result = spawnSync(process.execPath, ["scripts/run-quarantined-tests.mjs"], {
    cwd: new URL("..", import.meta.url).pathname, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /EMPTY — quarantine list is empty; zero tests run/);
});
