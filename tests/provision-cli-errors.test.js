// Worker-46 fail-first: provision.mjs CLI error paths must print a clean
// message to stderr and exit 2 — never an uncaught stack trace. Covers the
// four worker-2 findings: unknown flag, --account-key without --account,
// double --init, and a room that does not exist.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = `${root}/scripts/provision.mjs`;
const NO_STACK = /^\s*at\s/m;

function provision(args, dbFile) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ROOM_DB: dbFile },
    encoding: "utf8", timeout: 60000, cwd: root,
  });
}

test("provision.mjs --bogus: usage error exits 2 without a stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "w46-provision-"));
  try {
    const r = provision(["--bogus"], join(dir, "room.sqlite"));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /Usage:/i, "usage goes to stderr");
    assert.doesNotMatch(r.stderr, NO_STACK, "no stack trace");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provision.mjs --account-key without --account: clean error, exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "w46-provision-"));
  try {
    const r = provision(["--account-key", "--print-key"], join(dir, "room.sqlite"));
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /requires --account/i, "names the missing option");
    assert.doesNotMatch(r.stderr, NO_STACK, "no stack trace");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provision.mjs --init twice: second init is a clean error, exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "w46-provision-"));
  const dbFile = join(dir, "room.sqlite");
  try {
    const first = provision(["--init", "--print-key"], dbFile);
    assert.equal(first.status, 0, `first init must succeed, got ${first.status}: ${first.stderr.slice(0, 300)}`);
    const second = provision(["--init", "--print-key"], dbFile);
    assert.equal(second.status, 2, `expected exit 2, got ${second.status}: ${second.stderr.slice(0, 300)}`);
    assert.match(second.stderr, /already initialized/i, "says the room is already initialized");
    assert.doesNotMatch(second.stderr, NO_STACK, "no stack trace");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provision.mjs missing room: clean error, exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "w46-provision-"));
  try {
    const r = provision(
      ["--room", "w46-no-such-room", "--member", "owner", "--name", "X", "--print-key"],
      join(dir, "room.sqlite"),
    );
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /not found/i, "says the room was not found");
    assert.doesNotMatch(r.stderr, NO_STACK, "no stack trace");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provision.mjs new member without --name: clean error, exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "w46-provision-"));
  const dbFile = join(dir, "room.sqlite");
  try {
    const init = provision(["--init", "--print-key"], dbFile);
    assert.equal(init.status, 0, `init must succeed, got ${init.status}: ${init.stderr.slice(0, 300)}`);
    const r = provision(["--member", "w46-newbie", "--print-key"], dbFile);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /requires --name/i, "names the missing option");
    assert.doesNotMatch(r.stderr, NO_STACK, "no stack trace");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});