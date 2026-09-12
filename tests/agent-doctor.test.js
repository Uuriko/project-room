import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient, createAgentIdentity } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";

const execFileAsync = promisify(execFile);
// The room server runs on this process's event loop, so the CLI must be
// spawned async (never sync): a blocked loop starves the server.
async function doctor(args = [], env = {}) {
  const scrubbed = { ...process.env };
  for (const name of Object.keys(scrubbed)) if (name.startsWith("ROOM_AGENT_")) delete scrubbed[name];
  const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/agent-inbox.mjs", "doctor", ...args], {
      env: { ...scrubbed, ...env }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    return { status: 0, json: parse(stdout), text: stdout };
  } catch (error) {
    return { status: error.code ?? 1, json: parse(error.stdout), text: error.stdout,
      stderr: String(error.stderr ?? error.message) };
  }
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-doctor-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerCommons = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerCommons };
}

function check(result, name) {
  const found = result.json.checks.find(entry => entry.name === name);
  assert.ok(found, `expected a ${name} check`);
  return found;
}

test("doctor --help explains the self-test", async () => {
  const result = await doctor(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.text, /Read-only self-test/);
});

test("doctor rejects extra arguments", async () => {
  const result = await doctor(["extra"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage_error/);
});

test("doctor with no configuration names the missing origin", async () => {
  const result = await doctor();
  assert.equal(result.status, 1);
  assert.equal(result.json.healthy, false);
  assert.equal(check(result, "origin").ok, false);
  assert.match(result.json.repair, /ROOM_AGENT_ORIGIN/);
});

test("doctor flags an invalid origin", async () => {
  const result = await doctor([], { ROOM_AGENT_ORIGIN: "notaurl" });
  assert.equal(result.status, 1);
  assert.equal(check(result, "origin").detail, "invalid");
  assert.match(result.json.repair, /HTTPS origin/);
});

test("doctor flags an unreachable origin", async () => {
  const result = await doctor([], { ROOM_AGENT_ORIGIN: "http://127.0.0.1:1" });
  assert.equal(result.status, 1);
  assert.equal(check(result, "origin").detail, "unreachable");
});

test("doctor with only an origin points at identity-create", async t => {
  const { origin } = await serve(t);
  const result = await doctor([], { ROOM_AGENT_ORIGIN: origin });
  assert.equal(result.status, 1);
  assert.equal(check(result, "origin").ok, true);
  assert.equal(check(result, "credential").detail, "missing");
  assert.match(result.json.repair, /identity-create/);
});

test("doctor reports healthy for a fully plugged-in saved connection", async t => {
  const { origin, ownerCommons } = await serve(t);
  const { identityId, secret } = await createAgentIdentity(origin, "Doctor Bot");
  const owner = new RoomAgentClient({ origin, roomId: "commons", token: ownerCommons, memberId: "owner" });
  await owner.linkIdentity({ identityId, permissions: ["accept_work", "complete_work"] });
  const base = mkdtempSync(join(tmpdir(), "doctor-healthy-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "agent"); // saveAgentConnection creates it; must not exist yet
  saveAgentConnection(dir, { version: 1, origin, roomId: "commons", memberId: identityId, token: secret });

  // Only ROOM_AGENT_CONFIG: the documented post-connect state. The origin
  // comes from the saved connection itself.
  const result = await doctor([], { ROOM_AGENT_CONFIG: dir });
  assert.equal(result.status, 0, JSON.stringify(result.json ?? result.stderr));
  assert.equal(result.json.healthy, true);
  assert.ok(result.json.checks.every(entry => entry.ok));
  const access = check(result, "access");
  assert.match(access.detail, new RegExp(`agent identity ${identityId}`));
  assert.match(access.detail, /accept_work,complete_work/);
  assert.ok(!JSON.stringify(result.json).includes(secret), "doctor must never print the secret");
  assert.equal(result.json.repair, undefined);
});

test("doctor tells an unlinked identity exactly what the owner must run", async t => {
  const { origin } = await serve(t);
  const { identityId, secret } = await createAgentIdentity(origin, "Unlinked Bot");
  const result = await doctor([], {
    ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: identityId, ROOM_AGENT_TOKEN: secret,
  });
  assert.equal(result.status, 1);
  assert.equal(check(result, "origin").ok, true);
  assert.equal(check(result, "credential").ok, true);
  assert.equal(check(result, "access").detail, "identity_not_linked");
  assert.match(result.json.repair, /identity-link/);
  assert.ok(result.json.repair.includes(identityId));
  assert.ok(!JSON.stringify(result.json).includes(secret), "doctor must never print the secret");
});

test("doctor flags mixed credential sources without a misleading origin error", async t => {
  const { origin } = await serve(t);
  const dir = mkdtempSync(join(tmpdir(), "doctor-ambiguous-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await doctor([], { ROOM_AGENT_ORIGIN: origin, ROOM_AGENT_CONFIG: dir, ROOM_AGENT_TOKEN: "x".repeat(43) });
  assert.equal(result.status, 1);
  assert.equal(check(result, "credential").detail, "ambiguous");
  assert.match(result.json.repair, /not both/);
});
