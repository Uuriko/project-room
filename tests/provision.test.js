import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
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
