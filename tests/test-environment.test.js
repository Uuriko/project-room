import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-tools-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const versions = { node: "v24.19.0", npm: "11.0.0", gh: "gh version 2.103.0", jq: "jq-1.7", git: "git version 2.50.0", python3: "Python 3.13.0", ...overrides };
  for (const [name, version] of Object.entries(versions)) {
    if (version === null) continue;
    writeFileSync(join(directory, name), `#!/bin/sh\n[ "$1" = "--version" ] || exit 99\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  }
  return directory;
}
function run(script, path, flags = ["--full"], env = {}) {
  return spawnSync(process.execPath, [script, ...flags], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: path, ...env }, timeout: 15000 });
}

test("project preflight reports missing gh before expensive source checks", t => {
  const result = run("scripts/verify-preflight.mjs", fixture(t, { gh: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing executable: gh/);
  assert.doesNotMatch(result.stdout, /check-deps: ok|runtime source files checked/);
});

test("environment check accepts usable tools and reports child paths", t => {
  const path = fixture(t);
  const result = run("scripts/check-test-environment.mjs", path);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["node", "npm", "gh", "jq", "git", "python3"]) assert.ok(result.stdout.includes(join(path, name)));
});

test("environment check rejects an old child node even under a supported parent", t => {
  const result = run("scripts/check-test-environment.mjs", fixture(t, { node: "v22.0.0" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /child node must satisfy/);
});

test("environment check rejects a broken launcher instead of accepting its presence", t => {
  const path = fixture(t);
  writeFileSync(join(path, "npm"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
  const result = run("scripts/check-test-environment.mjs", path);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm .*failed its version probe \(42\)/);
});

test("environment check includes Python required by deployment metadata tests", t => {
  const result = run("scripts/check-test-environment.mjs", fixture(t, { python3: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing executable: python3/);
});

// Optional prerequisites must not block small affected/UI selections.
test("default profile warns instead of blocking tests that do not need gh", t => {
  const result = run("scripts/check-test-environment.mjs", fixture(t, { gh: null }), []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: missing executable: gh/);
});

test("full preflight rejects an unusable socket directory before source checks and cleans its fixture", t => {
  const tools = fixture(t), deep = join(tools, "long-".repeat(40));
  mkdirSync(deep);
  const result = run("scripts/verify-preflight.mjs", tools, ["--full"], { TMPDIR: deep });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /error: Unix socket fixture unavailable/);
  assert.doesNotMatch(result.stdout, /check-deps: ok|runtime source files checked/);
  assert.deepEqual(readdirSync(deep), []);
});

test("optional socket diagnostics warn and clean up without blocking a small suite", t => {
  const tools = fixture(t), deep = join(tools, "long-".repeat(40));
  mkdirSync(deep);
  const result = run("scripts/check-test-environment.mjs", tools, [], { TMPDIR: deep });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: Unix socket fixture unavailable/);
  assert.deepEqual(readdirSync(deep), []);
});

test("a short private alias to deep storage supports a real socket roundtrip and leaves no fixture", t => {
  const tools = fixture(t), deep = join(tools, "long-".repeat(40));
  mkdirSync(deep);
  const aliasRoot = mkdtempSync("/tmp/pr-env-");
  t.after(() => rmSync(aliasRoot, { recursive: true, force: true }));
  const alias = join(aliasRoot, "t");
  symlinkSync(deep, alias);
  const result = run("scripts/check-test-environment.mjs", tools, ["--full"], { TMPDIR: alias });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Unix socket roundtrip usable/);
  assert.deepEqual(readdirSync(deep), []);
});
