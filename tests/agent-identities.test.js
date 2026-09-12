import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { RoomAgentClient, createAgentIdentity } from "../client/room-agent.mjs";

const execFileAsync = promisify(execFile);
// The room server runs on this process's event loop, so the CLI must be
// spawned async (never sync): a blocked loop starves the server and every
// child request times out.
async function cli(origin, args, env = {}) {
  const scrubbed = { ...process.env };
  for (const name of Object.keys(scrubbed)) if (name.startsWith("ROOM_AGENT_")) delete scrubbed[name];
  // A saved connection and credential variables are mutually exclusive.
  const base = env.ROOM_AGENT_CONFIG === undefined ? { ROOM_AGENT_ORIGIN: origin } : {};
  try {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/agent-inbox.mjs", ...args], {
      env: { ...scrubbed, ...base, ...env }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    return { status: 0, json: JSON.parse(stdout) };
  } catch (error) { return { status: error.code ?? 1, stderr: String(error.stderr ?? error.message) }; }
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-identities-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.initialize(initialRoom("lab"));
  const ownerCommons = store.issueAccessKey("commons", "owner");
  const ownerLab = store.issueAccessKey("lab", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerCommons, ownerLab };
}

test("multi-room agent identity: one secret works across linked rooms (round-2 #101)", async t => {
  const { store, origin, ownerCommons, ownerLab } = await serve(t);

  // Create one identity via the HTTP route (no auth needed).
  const created = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Relay Bot" })
  });
  assert.equal(created.status, 201);
  const { identityId, secret } = await created.json();
  assert.match(identityId, /^ai_/);
  assert.match(secret, /^pri_/);
  // Secret is stored hashed, never in cleartext.
  const row = store.db.prepare("SELECT secret_hash FROM agent_identities WHERE identity_id=?").get(identityId);
  assert.ok(row && !row.secret_hash.includes(secret.slice(4, 12)));

  // Link the same identity into two rooms with one call each.
  const link = async (roomId, ownerKey) => {
    const res = await fetch(`${origin}/api/rooms/${roomId}/identity-links`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerKey}` },
      body: JSON.stringify({ identityId, permissions: ["accept_work", "complete_work"] })
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const inCommons = await link("commons", ownerCommons);
  const inLab = await link("lab", ownerLab);
  // Same member id in both rooms: one identity, no re-provisioning.
  assert.equal(inCommons.memberId, inLab.memberId);
  assert.equal(inCommons.memberId, identityId);

  // The agent uses its single secret in both rooms: snapshot + post a message.
  for (const roomId of ["commons", "lab"]) {
    const client = new RoomAgentClient({ origin, roomId, token: secret, memberId: identityId });
    const check = await client.checkConnection();
    assert.equal(check.status, "credential_accepted");
    assert.equal(check.memberId, identityId);
    await client.command({ id: randomUUID(), type: "message.posted", data: { messageId: randomUUID(), body: `hello from ${roomId}` } });
    const snapshot = await client.snapshot();
    assert.ok(snapshot.state.messages.some(m => m.authorId === identityId && m.body === `hello from ${roomId}`));
    assert.equal(snapshot.state.members[identityId].identityId, identityId);
  }

  // Unlinking from one room revokes access there only.
  const unlink = await fetch(`${origin}/api/rooms/lab/identity-links`, {
    method: "DELETE", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerLab}` },
    body: JSON.stringify({ identityId })
  });
  assert.equal(unlink.status, 200);
  const labClient = new RoomAgentClient({ origin, roomId: "lab", token: secret, memberId: identityId });
  await assert.rejects(labClient.snapshot(), error => error.status === 401);
  // Still works in commons.
  const commonsClient = new RoomAgentClient({ origin, roomId: "commons", token: secret, memberId: identityId });
  assert.ok((await commonsClient.snapshot()).state.members[identityId]);

  // Re-linking the same identity reactivates the member instead of failing.
  const relink = await link("lab", ownerLab);
  assert.equal(relink.relinked, true);
  const labAgain = new RoomAgentClient({ origin, roomId: "lab", token: secret, memberId: identityId });
  assert.equal((await labAgain.checkConnection()).status, "credential_accepted");
  assert.equal((await labAgain.snapshot()).state.members[identityId].active, true);

  // An identity never linked to a room gets 401 there.
  const other = await (await fetch(`${origin}/api/agent-identities`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ displayName: "Stranger" }) })).json();
  const stranger = new RoomAgentClient({ origin, roomId: "commons", token: other.secret, memberId: other.identityId });
  await assert.rejects(stranger.snapshot(), error => error.status === 401);
});

test("CLI plug-in loop: a new AI goes from no credential to connected member", async t => {
  const { origin, ownerCommons } = await serve(t);
  const ownerEnv = { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: ownerCommons };

  // 1. Minting needs only the service origin: no credential exists yet.
  const created = await cli(origin, ["identity-create", "Plug Bot"]);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.json.identityId, /^ai_/);
  assert.match(created.json.secret, /^pri_/);
  const { identityId, secret } = created.json;

  // 2. The owner links the identity (human owner + manage_members credential).
  const linked = await cli(origin, ["identity-link", identityId, "accept_work,complete_work"], ownerEnv);
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(linked.json.memberId, identityId);
  assert.equal(linked.json.roomId, "commons");

  // 3. The owner can list linked identities.
  const listed = await cli(origin, ["identity-links"], ownerEnv);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(Array.isArray(listed.json.links) && listed.json.links.some(row => row.identityId === identityId));

  // 4. The agent connects with its single secret and proves check/read/write.
  const agentDir = mkdtempSync(join(tmpdir(), "plug-loop-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const connected = await cli(origin, ["connect", join(agentDir, "agent")], {
    ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: identityId, ROOM_AGENT_TOKEN: secret,
  });
  assert.equal(connected.status, 0, connected.stderr);
  assert.equal(connected.json.configurationSaved, true);
  const agentEnv = { ROOM_AGENT_CONFIG: join(agentDir, "agent") };
  const checked = await cli(origin, ["check"], agentEnv);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.json.status, "credential_accepted");
  assert.equal(checked.json.memberId, identityId);
  assert.deepEqual(checked.json.permissions, ["accept_work", "complete_work"]);
  const said = await cli(origin, ["status", "plugged in"], agentEnv);
  assert.equal(said.status, 0, said.stderr);
  const oriented = await cli(origin, ["orient"], agentEnv);
  assert.equal(oriented.status, 0, oriented.stderr);
  const advertised = await cli(origin, ["advertise", "plug-loop"], agentEnv);
  assert.equal(advertised.status, 0, advertised.stderr);

  // 5. Owner unlink revokes the agent's access without deleting history.
  const unlinked = await cli(origin, ["identity-unlink", identityId], ownerEnv);
  assert.equal(unlinked.status, 0, unlinked.stderr);
  const recheck = await cli(origin, ["check"], agentEnv);
  assert.notEqual(recheck.status, 0);
});

test("createAgentIdentity sends no credential and validates the origin", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, auth: options.headers.Authorization };
    return Response.json({ identityId: "ai_x", displayName: "B", createdAt: 1, secret: "pri_s" });
  };
  const value = await createAgentIdentity("https://room.example", "B", { fetchImpl });
  assert.equal(seen.url, "https://room.example/api/agent-identities");
  assert.equal(seen.auth, undefined);
  assert.equal(value.secret, "pri_s");
  await assert.rejects(
    createAgentIdentity("notaurl", "B", { fetchImpl: () => assert.fail("no network") }),
    error => error.code === "invalid_config");
  await assert.rejects(
    createAgentIdentity("https://room.example", "B", { fetchImpl: async () => Response.json({}) }),
    error => error.code === "invalid_response");
  await assert.rejects(
    createAgentIdentity("https://room.example", "B", { fetchImpl: async () => new Response("no", { status: 500 }) }),
    error => error.status === 500);
});

test("identity-link rejects bad arglists at the CLI boundary", async t => {
  const { origin } = await serve(t);
  for (const args of [["identity-link"], ["identity-link", "ai_x"], ["identity-link", "ai_x", "a", "b", "c", "d"]]) {
    const r = await cli(origin, args, { ROOM_AGENT_ROOM: "commons", ROOM_AGENT_MEMBER: "owner", ROOM_AGENT_TOKEN: "x".repeat(43) });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage_error/);
  }
});
