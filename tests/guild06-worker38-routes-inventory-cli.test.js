// GUILD-06 worker-38: fail-first CLI hardening tests for scripts/routes-inventory.mjs.
// Convention (guild-06 direct pass): unknown CLI flags -> usage on stderr + exit 2.
// audit-invitations.mjs CLI-arg coverage lives in tests/guild06-worker37-shard.test.js
// (worker-37 fixed + covered it first); this file covers routes-inventory only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args) =>
  spawnSync(process.execPath, [`${root}/scripts/routes-inventory.mjs`, ...args], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, TMPDIR: `${root}/.tmp` },
  });

test("routes-inventory: unknown option exits 2 with usage (does not silently dump)", () => {
  const r = run(["--bogus"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr, /--check/);
  assert.match(r.stderr, /--write/);
  assert.equal(r.stdout, "", "no silent inventory dump on usage error");
});

test("routes-inventory: a typo'd --write (e.g. --writ) must not silently no-op", () => {
  const r = run(["--writ"]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
  assert.match(r.stderr, /unknown option/i);
  assert.equal(r.stdout, "", "no silent inventory dump on usage error");
});

test("routes-inventory: --help exits 0 and documents --check/--write", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--check/);
  assert.match(r.stdout, /--write/);
});

test("routes-inventory: no args still prints the inventory (behavior preserved)", () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^GET\s+\//m, "route dump on stdout");
});
