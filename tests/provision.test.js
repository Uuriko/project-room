import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";

test("operator account-key provisioning creates no membership and rotation ends prior account sessions", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-provision-"));
  const filename = join(directory, "room.sqlite");
  const script = fileURLToPath(new URL("../scripts/provision.mjs", import.meta.url));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const provision = () => {
    const result = spawnSync(process.execPath, [script, "--account-key", "--account", "pilot-human", "--print-key"], {
      env: { ...process.env, ROOM_DB: filename }, encoding: "utf8"
    });
    assert.equal(result.status, 0, "account provisioning command must succeed");
    assert.match(result.stdout, /does not grant Room membership/);
    const key = result.stdout.trim().split("\n").at(-1);
    assert.equal(/^[A-Za-z0-9_-]{43}$/.test(key), true, "command returns one usable private account key");
    return key;
  };
  const firstKey = provision();
  store = new RoomStore(filename);
  const slot = store.createAccountSessionSlot();
  const firstSession = store.loginAccountSession(slot.token, firstKey, 0);
  assert.equal(firstSession.account.id, "pilot-human");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get("pilot-human").n, 0);
  const secondKey = provision();
  assert.equal(firstKey === secondKey, false);
  assert.throws(() => store.authenticateAccountAccessKey(firstKey), { code: "unauthenticated" });
  assert.throws(() => store.authenticateAccountSession(slot.token), { code: "unauthenticated" });
  const anonymous = store.accountSessionSlot(slot.token);
  assert.equal(anonymous.sessionRevision, firstSession.sessionRevision + 1);
  assert.equal(store.loginAccountSession(slot.token, secondKey, anonymous.sessionRevision).account.id, "pilot-human");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get("pilot-human").n, 0);
});

test("provisioning creates the database without group or world read access", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-provision-mode-"));
  const filename = join(directory, "room.sqlite");
  const script = fileURLToPath(new URL("../scripts/provision.mjs", import.meta.url));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Run under a permissive umask so the script's own setting is what protects the file.
  const result = spawnSync("sh", ["-c", `umask 022 && "${process.execPath}" "${script}" --init --print-key`], {
    env: { ...process.env, ROOM_DB: filename }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(filename).mode & 0o077, 0, "database file is private to the service account");
});

test("keys are withheld from non-terminal stdout unless explicitly requested", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-provision-redact-"));
  const filename = join(directory, "room.sqlite");
  const keyFile = join(directory, "owner.key");
  const script = fileURLToPath(new URL("../scripts/provision.mjs", import.meta.url));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ROOM_DB: filename }, encoding: "utf8",
  });
  run("--init", "--room", "commons", "--member", "owner", "--name", "Owner", "--print-key");
  // Piped stdout with no flag: no key on stdout, nonzero exit, guidance on stderr.
  const withheld = run("--room", "commons", "--member", "owner");
  assert.equal(withheld.status, 2);
  assert.match(withheld.stderr, /key withheld/);
  assert.equal(/^[A-Za-z0-9_-]{43}$/m.test(withheld.stdout), false, "no key material on piped stdout");
  // --key-file: key lands in a 0600 file, never on stdout.
  const filed = run("--room", "commons", "--member", "owner", "--key-file", keyFile);
  assert.equal(filed.status, 0);
  assert.equal(/^[A-Za-z0-9_-]{43}$/m.test(filed.stdout), false, "no key material on stdout with --key-file");
  const saved = readFileSync(keyFile, "utf8").trim();
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(saved), true, "key file holds one usable key");
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, "key file is owner-only");
});

// H-17 regression: writeFileSync's `mode` option applies only at creation, so
// a pre-existing world-readable key file kept its mode and leaked the bearer
// key. --key-file must lock the file down to 0600 whether it is new or not.
// Contract: the key file is owner-only after every --key-file run.
// Credible regression: the pre-fix writeFileSync(..., { mode: 0o600 }) leaves
// a pre-existing 0644 file at 0644 -> the mode assertion fails.
// Existing coverage gap: the test above only exercises the newly-created
// file case. Real CLI boundary via spawnSync; no new production seams.
test("key-file with pre-existing loose permissions is locked down to 0600", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-provision-keymode-"));
  const filename = join(directory, "room.sqlite");
  const keyFile = join(directory, "owner.key");
  const script = fileURLToPath(new URL("../scripts/provision.mjs", import.meta.url));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ROOM_DB: filename }, encoding: "utf8",
  });
  run("--init", "--room", "commons", "--member", "owner", "--name", "Owner", "--print-key");
  // Simulate a key file left behind by an older run (or the operator) with
  // loose permissions; chmodSync pins the mode even under a strict umask.
  writeFileSync(keyFile, "old-key-material\n");
  chmodSync(keyFile, 0o644);
  assert.equal(statSync(keyFile).mode & 0o777, 0o644, "precondition: fixture file is world-readable");
  const filed = run("--room", "commons", "--member", "owner", "--key-file", keyFile);
  assert.equal(filed.status, 0, filed.stderr);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600, "pre-existing key file is locked down to owner-only");
  const saved = readFileSync(keyFile, "utf8").trim();
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(saved), true, "key file holds one usable key");
});

// M-27: revocation-before-delivery strands operators — when the new key
// cannot be delivered, provision must refuse BEFORE revoking the old key.
test("M-27: non-TTY stdout with no key-file refuses to revoke the old account key", async t => {
  const dir = mkdtempSync(join(tmpdir(), "project-room-provision-m27-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "room.sqlite");
  const script = fileURLToPath(new URL("../scripts/provision.mjs", import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ROOM_DB: db }, encoding: "utf8",
  });
  const first = run(["--account-key", "--account", "u1", "--print-key"]);
  assert.equal(first.status, 0, first.stderr);
  const key1 = first.stdout.trim().split("\n").at(-1);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(key1), "first run delivered a usable key");
  // Piped stdout is not a TTY and no --key-file was given: the new key
  // cannot be delivered, so the run must fail before revoking key1.
  const second = run(["--account-key", "--account", "u1"]);
  assert.notEqual(second.status, 0);
  assert.match(second.stdout + second.stderr, /key withheld/i);
  assert.match(second.stdout + second.stderr, /strand/i);
  const store = new RoomStore(db);
  t.after(() => store.close());
  assert.ok(store.authenticateAccountAccessKey(key1), "key1 still authenticates — nothing was revoked");
});

test("M-27: an unwritable --key-file refuses to revoke the old account key", async t => {
  const dir = mkdtempSync(join(tmpdir(), "project-room-provision-m27-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "room.sqlite");
  const script = fileURLToPath(new URL("../scripts/provision.mjs", import.meta.url));
  const run = args => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ROOM_DB: db }, encoding: "utf8",
  });
  const first = run(["--account-key", "--account", "u1", "--print-key"]);
  assert.equal(first.status, 0, first.stderr);
  const key1 = first.stdout.trim().split("\n").at(-1);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(key1), "first run delivered a usable key");
  const bad = run(["--account-key", "--account", "u1", "--key-file", join(dir, "no-such-dir", "k.txt")]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /ENOENT|no such file/i, "the write failure surfaces instead of a silent strand");
  const store = new RoomStore(db);
  t.after(() => store.close());
  assert.ok(store.authenticateAccountAccessKey(key1), "key1 still authenticates — nothing was revoked");
});
