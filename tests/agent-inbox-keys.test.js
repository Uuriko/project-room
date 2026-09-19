// Token-management CLI tests (RC-2026-09-18-050): the `agent-keys`
// create|list|rotate|revoke verbs in scripts/agent-inbox.mjs, driven against
// a real room server. Covers mint (scopes + expiry + label), one-time secret
// display, hash-only storage, scope enforcement (403), expiry rejection
// (401), revocation, and CLI usage errors. No network calls, no real
// credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";

const execFileAsync = promisify(execFile);
const sha256 = text => createHash("sha256").update(text).digest("hex");

// The room server runs on this process's event loop, so the CLI must be
// spawned async (never sync): a blocked loop starves the server and every
// child request times out.
async function cli(args, env = {}) {
  const scrubbed = { ...process.env };
  for (const name of Object.keys(scrubbed)) if (name.startsWith("ROOM_AGENT_")) delete scrubbed[name];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/agent-inbox.mjs", ...args], {
      env: { ...scrubbed, ...env }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    return { status: 0, json: JSON.parse(stdout), stderr: String(stderr) };
  } catch (error) {
    return { status: error.code ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message) };
  }
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-agent-keys-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The key-management surface is owner-only: act as an agent identity
  // holding its pri_ secret.
  const created = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Key Owner" }),
  });
  assert.equal(created.status, 201);
  const { identityId, secret } = await created.json();
  // saveAgentConnection creates the directory itself: it must not exist yet.
  const configDir = join(tmpdir(), `project-room-agent-keys-config-${randomUUID()}`);
  saveAgentConnection(configDir, { version: 1, origin, roomId: "commons", token: secret, memberId: identityId });
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });
  return { store, origin, identityId, secret, env: { ROOM_AGENT_CONFIG: configDir } };
}

const webhooksGet = (origin, credential) => fetch(`${origin}/api/agent-webhooks`, {
  headers: { Origin: origin, Authorization: `Bearer ${credential}` },
});

test("create mints a scoped expiring key; the secret is shown once and stored hashed", async t => {
  const { store, env } = await serve(t);
  const before = Date.now();
  const res = await cli(["agent-keys", "create", "webhooks:manage,directory:publish", "--label", "cli key", "--expires-in", "24h"], env);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.json.keyId, /^rak_[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(res.json.scopes, ["webhooks:manage", "directory:publish"]);
  assert.equal(res.json.label, "cli key");
  assert.ok(res.json.expiresAt > before && res.json.expiresAt <= before + 24 * 3600000 + 60000,
    `expiresAt lands ~24h out, saw ${res.json.expiresAt}`);
  assert.ok(typeof res.json.secret === "string" && res.json.secret.length >= 16, "secret carries real entropy");
  assert.equal(res.json.credential, `rak_${res.json.secret}`, "credential is the exact Authorization-header value");
  assert.match(res.stderr, /ONE-TIME SECRET/, "the one-time warning goes to stderr, not stdout");
  // Hash-only storage: the raw secret appears nowhere server-side.
  const row = store.db.prepare("SELECT key_hash FROM agent_api_keys WHERE key_id=?").get(res.json.keyId);
  assert.ok(row, "key row exists");
  assert.equal(row.key_hash, sha256(res.json.secret));
  // The list surface never shows secrets.
  const listed = await cli(["agent-keys", "list"], env);
  assert.equal(listed.status, 0, listed.stderr);
  const entry = listed.json.keys.find(key => key.keyId === res.json.keyId);
  assert.ok(entry, "the new key is listed");
  for (const field of ["secret", "credential", "keyHash", "key_hash"]) assert.ok(!(field in entry), `list leaks no ${field}`);
  assert.equal(entry.revoked, false);
  assert.deepEqual(entry.scopes, ["webhooks:manage", "directory:publish"]);
});

test("scope enforcement: a key without the scope is 403 on the guarded route", async t => {
  const { origin, env } = await serve(t);
  const narrow = await cli(["agent-keys", "create", "directory:publish"], env);
  assert.equal(narrow.status, 0, narrow.stderr);
  const res = await webhooksGet(origin, narrow.json.credential);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error?.code, "insufficient_scope");
  // The same key authenticates fine (401 would mean unknown/expired, not scoped-out).
  const wide = await cli(["agent-keys", "create", "webhooks:manage"], env);
  assert.equal(wide.status, 0, wide.stderr);
  assert.equal((await webhooksGet(origin, wide.json.credential)).status, 200);
});

test("expired keys are rejected at the door", async t => {
  const { origin, secret, env } = await serve(t);
  // The CLI refuses a past --expires-at (usage error), so mint the expired
  // key over HTTP and prove the credential no longer authenticates.
  const minted = await fetch(`${origin}/api/agent-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ scopes: ["webhooks:manage"], expiresAt: Date.now() - 1000 }),
  });
  assert.equal(minted.status, 201);
  const key = await minted.json();
  assert.equal((await webhooksGet(origin, key.credential)).status, 401);
  // And the CLI itself refuses to mint into the past.
  const past = await cli(["agent-keys", "create", "webhooks:manage", "--expires-at", String(Date.now() - 1000)], env);
  assert.notEqual(past.status, 0, "past --expires-at must be a usage error");
});

test("rotate replaces the secret (old credential dies) and revoke ends the key", async t => {
  const { store, origin, env } = await serve(t);
  const created = await cli(["agent-keys", "create", "webhooks:manage"], env);
  assert.equal(created.status, 0, created.stderr);
  const rotated = await cli(["agent-keys", "rotate", created.json.keyId], env);
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.notEqual(rotated.json.secret, created.json.secret, "rotation mints fresh entropy");
  assert.equal(rotated.json.credential, `rak_${rotated.json.secret}`);
  assert.match(rotated.stderr, /ONE-TIME SECRET/);
  assert.equal(rowHash(store, created.json.keyId), sha256(rotated.json.secret), "the stored hash follows the rotation");
  assert.equal((await webhooksGet(origin, created.json.credential)).status, 401, "the old credential stops working");
  assert.equal((await webhooksGet(origin, rotated.json.credential)).status, 200, "the new credential works");
  const revoked = await cli(["agent-keys", "revoke", created.json.keyId], env);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.equal(revoked.json.revoked, true);
  assert.equal((await webhooksGet(origin, rotated.json.credential)).status, 401, "a revoked key authenticates nothing");
  const listed = await cli(["agent-keys", "list"], env);
  assert.equal(listed.json.keys.find(key => key.keyId === created.json.keyId).revoked, true);
});

function rowHash(store, keyId) {
  return store.db.prepare("SELECT key_hash FROM agent_api_keys WHERE key_id=?").get(keyId)?.key_hash;
}

test("usage errors exit non-zero without touching the server", async t => {
  const { env } = await serve(t);
  const cases = [
    ["agent-keys"],
    ["agent-keys", "frobnicate"],
    ["agent-keys", "create"],
    ["agent-keys", "create", "not a scope!"],
    ["agent-keys", "create", "webhooks:manage", "--expires-in", "yesterday"],
    ["agent-keys", "create", "webhooks:manage", "--label"],
    ["agent-keys", "list", "extra"],
    ["agent-keys", "rotate"],
    ["agent-keys", "rotate", "rak_notakey!!"],
    ["agent-keys", "revoke", "rak_"],
  ];
  for (const args of cases) {
    const res = await cli(args, env);
    assert.notEqual(res.status, 0, `${args.join(" ")} should be a usage error`);
  }
});
