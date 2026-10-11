import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Exercise the real CLI and real node:test events in disposable files. Nothing
// imports a browser or connects to Room, and no mocked process supplies a pass.
function fixture(t, source, specs) {
  const dir = mkdtempSync(join(tmpdir(), "quarantine-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["scripts", "tests"]) mkdirSync(join(dir, name));
  for (const name of ["run-quarantined-tests.mjs", "quarantine-test-reporter.mjs"]) {
    if (existsSync(join("scripts", name))) cpSync(join("scripts", name), join(dir, "scripts", name));
  }
  writeFileSync(join(dir, "tests/probe.mjs"), `import { test, describe, it } from 'node:test';\nimport { appendFileSync } from 'node:fs';\n${source}\n`);
  writeFileSync(join(dir, "tests/quarantine.json"), JSON.stringify({ quarantined: specs.map(name => ({ test: name == null ? "tests/probe.mjs" : `tests/probe.mjs > ${name}` })) }));
  const env = { ...process.env, QUARANTINE_TEST_TIMEOUT_MS: "5000" };
  delete env.NODE_TEST_CONTEXT;
  return {
    dir,
    run: (more = {}) => spawnSync(process.execPath, ["scripts/run-quarantined-tests.mjs"], { cwd: dir, env: { ...env, ...more }, encoding: "utf8", timeout: 10000 }),
  };
}

test("quarantine rejects a missing or renamed exact name, even when a substring passes", t => {
  const { run } = fixture(t, `test('renamed target', () => {});`, ["target", "absent"]);
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /no non-skipped test executed/i);
  assert.match(result.stderr, /2\/2 quarantined test\(s\) failed/);
});

test("quarantine rejects skipped and TODO-only matches", t => {
  const { run } = fixture(t, `test('skipped', { skip: true }, () => { throw Error('must not run'); });\ntest('todo', { todo: true }, () => { throw Error('unfinished'); });`, ["skipped", "todo"]);
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /2\/2 quarantined test\(s\) failed/);
});

test("quarantine requires actual file tests rather than a successful empty-file wrapper", t => {
  const { run } = fixture(t, `// No registered tests.`, [null, "tests/probe.mjs"]);
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /2\/2 quarantined test\(s\) failed/);
});

test("quarantine runs exact literal and nested names with QUARANTINE_RUN, preserving real failures", t => {
  const { run, dir } = fixture(t, `
    test('literal [target]+', () => { if (process.env.QUARANTINE_RUN !== '1') throw Error('missing gate'); appendFileSync('ran.txt', 'literal\\n'); });
    test('literal [target]+ suffix', () => { throw Error('wrong test selected'); });
    describe('parent', () => { it('nested', () => appendFileSync('ran.txt', 'nested\\n')); });
    test('broken', () => { throw Error('real failure'); });
  `, ["literal [target]+", "parent nested", "broken"]);
  const result = run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /1\/3 quarantined test\(s\) failed/);
  assert.deepEqual(readFileSync(join(dir, "ran.txt"), "utf8").trim().split("\n"), ["literal", "nested"]);
});

test("quarantine accepts a real named pass and a nonempty whole-file pass", t => {
  const { run } = fixture(t, `test('actual pass', () => {});`, ["actual pass", null]);
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /all 2 quarantined test\(s\) passed/);
});

test("quarantine times out a stuck entry and still reports the following entry", t => {
  const { run, dir } = fixture(t, `
    test('hang', () => { while (true) { /* event loop cannot enforce a test timeout */ } });
    test('after hang', () => appendFileSync('ran.txt', 'after\\n'));
  `, ["hang", "after hang"]);
  const result = run({ QUARANTINE_TEST_TIMEOUT_MS: "1500" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /timed out/i);
  assert.match(result.stderr, /1\/2 quarantined test\(s\) failed/);
  assert.equal(readFileSync(join(dir, "ran.txt"), "utf8"), "after\n");
});
