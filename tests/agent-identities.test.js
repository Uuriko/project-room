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
import { AgentIdentities, IDENTITY_LIMIT } from "../server/agent-identities.mjs";

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

test("re-linking applies the permissions the owner supplies now, not the unlinked record's", async t => {
  const { origin, ownerCommons } = await serve(t);
  const { identityId } = await createAgentIdentity(origin, "Scoped Bot");
  const link = async (permissions) => fetch(`${origin}/api/rooms/commons/identity-links`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerCommons}` },
    body: JSON.stringify({ identityId, permissions })
  });
  const members = async () => (await (await fetch(`${origin}/api/rooms/commons`, { headers: { Authorization: `Bearer ${ownerCommons}` } })).json()).state.members;
  assert.equal((await link(["accept_work", "complete_work", "verify"])).status, 201);
  assert.deepEqual([...(await members())[identityId].permissions].sort(), ["accept_work", "complete_work", "verify"]);
  const unlink = await fetch(`${origin}/api/rooms/commons/identity-links`, {
    method: "DELETE", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerCommons}` },
    body: JSON.stringify({ identityId })
  });
  assert.equal(unlink.status, 200);
  const relink = await link(["accept_work"]);
  assert.equal(relink.status, 201);
  assert.equal((await relink.json()).relinked, true);
  const member = (await members())[identityId];
  assert.equal(member.active, true);
  assert.deepEqual(member.permissions, ["accept_work"]);
  // A non-text display name is a validation error, not a service failure.
  const badName = await fetch(`${origin}/api/rooms/commons/identity-links`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerCommons}` },
    body: JSON.stringify({ identityId: (await createAgentIdentity(origin, "Other")).identityId, permissions: ["accept_work"], displayName: 42 })
  });
  assert.equal(badName.status, 422);
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
  assert.equal(checked.json.type, "agent_connection_ladder");
  assert.equal(checked.json.status, "verified");
  assert.equal(checked.json.memberId, identityId);
  assert.deepEqual(checked.json.rungs.map(rung => rung.name), ["access", "read", "write"]);
  assert.ok(checked.json.rungs.every(rung => rung.ok));
  assert.match(checked.json.rungs[0].detail, /accept_work,complete_work/);
  assert.equal(checked.json.summary, "3/3 — you're live in #commons");
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

test("identity creation is capped: the 5000-row pilot limit is enforced inside the insert transaction", async t => {
  const { store, origin } = await serve(t);
  const existing = store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n;
  const insert = store.db.prepare("INSERT INTO agent_identities(identity_id,secret_hash,display_name,created_at) VALUES(?,?,?,?)");
  store.transaction(() => {
    for (let i = existing; i < 5000; i++) insert.run(`ai_cap${i}`, `cap-hash-${i}`, "Cap", 1);
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n, 5000);
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "One Too Many" })
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "pilot_limit");
  assert.match(body.error.message, /no data was changed/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n, 5000);
  // Invite redemption mints an identity too, so it is bounded by the same cap.
  const ownerKey = store.issueAccessKey("commons", "owner");
  const minted = store.invites.create(ownerKey, "commons", { permissions: ["accept_work"] });
  assert.throws(() => store.invites.redeem(minted.code, { displayName: "Late Bot" }), error => error.status === 409 && error.code === "pilot_limit");
  // Freeing a slot lets creation resume.
  store.db.prepare("DELETE FROM agent_identities WHERE identity_id='ai_cap4999'").run();
  const again = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Fits Now" })
  });
  assert.equal(again.status, 201);
});

test("identity cap is enforced by the store, not only the rate limit: under the cap creates exactly one row, at the cap nothing is written", async t => {
  const { store, origin } = await serve(t);
  assert.equal(IDENTITY_LIMIT, 5000);
  // A low limit exercises the same code path the 5000-row default guards.
  const capped = new AgentIdentities(store, { identityLimit: 2 });
  const count = () => store.db.prepare("SELECT COUNT(*) AS n FROM agent_identities").get().n;
  assert.equal(count(), 0, "fresh store");
  const first = capped.create("Under Cap");
  assert.equal(count(), 1);
  assert.equal(capped.get(first.identityId)?.displayName, "Under Cap");
  capped.create("Fills Cap");
  assert.equal(count(), 2);
  assert.throws(() => capped.create("Over Cap"), error => error.status === 409 && error.code === "pilot_limit" && /no data was changed/.test(error.message));
  assert.equal(count(), 2, "a refused create writes no row");
  // The default instance still accepts creations (its cap is 5000), and the
  // HTTP error contract is the documented JSON error body.
  const res = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Default Cap" })
  });
  assert.equal(res.status, 201);
  assert.equal(count(), 3);
  const bad = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "" })
  });
  assert.equal(bad.status, 422);
  assert.match(bad.headers.get("content-type"), /application\/json/);
  assert.equal((await bad.json()).error.code, "invalid_identity");
  assert.equal(count(), 3, "a refused create writes no row");
});

test("identity-link listing is membership administration: agents and plain members get 403", async t => {
  const { store, origin, ownerCommons } = await serve(t);
  const { identityId, secret } = await createAgentIdentity(origin, "Listing Bot");
  const link = await fetch(`${origin}/api/rooms/commons/identity-links`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerCommons}` },
    body: JSON.stringify({ identityId, permissions: ["accept_work"] })
  });
  assert.equal(link.status, 201);
  const list = token => fetch(`${origin}/api/rooms/commons/identity-links`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  // The linked agent can use the room but cannot enumerate who else is plugged in.
  const denied = await list(secret);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "access_denied");
  // A human member without manage_members is denied too.
  store.command(ownerCommons, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "reader", displayName: "Reader", kind: "human", permissions: ["steer"] } });
  const readerKey = store.issueAccessKey("commons", "reader");
  assert.equal((await list(readerKey)).status, 403);
  // The owner still sees the audit list.
  const allowed = await list(ownerCommons);
  assert.equal(allowed.status, 200);
  assert.ok((await allowed.json()).links.some(row => row.identityId === identityId));
});

test("identity link/unlink/list honour the session-binding fence", async t => {
  const { store, ownerCommons } = await serve(t);
  const { identityId } = store.identities.create("Fenced Bot");
  const staleFence = "f".repeat(64);
  const fenced = error => error.status === 409 && error.code === "session_binding_changed";
  // A room access key has no session binding, so any expected fence is a mismatch.
  assert.throws(() => store.identities.list(ownerCommons, "commons", staleFence), fenced);
  assert.throws(() => store.identities.link(ownerCommons, "commons", { identityId, permissions: ["accept_work"] }, staleFence), fenced);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE identity_id=?").get(identityId).n, 0);
  store.identities.link(ownerCommons, "commons", { identityId, permissions: ["accept_work"] });
  assert.throws(() => store.identities.unlink(ownerCommons, "commons", identityId, staleFence), fenced);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE identity_id=?").get(identityId).n, 1);
  // The default (no fence) keeps working.
  assert.ok(store.identities.list(ownerCommons, "commons").some(row => row.identityId === identityId));
  assert.equal(store.identities.unlink(ownerCommons, "commons", identityId).unlinked, true);
});

test("createAgentIdentity sends no credential and validates the origin", async () => {
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, auth: options.headers.Authorization };
    return Response.json({ identityId: "ai_x", displayName: "B", createdAt: 1, secret: "pri_s" });
  };
  const value = await createAgentIdentity("https://room.example", "B", { fetchImpl });
  assert.equal(seen.url, "https://room.example/api/agent-identities");
  const edge = await createAgentIdentity("https://www.getdasha.com", "B", { fetchImpl });
  assert.equal(seen.url, "https://www.getdasha.com/room/api/agent-identities");
  assert.equal(edge.secret, "pri_s");
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

test("identity-create returns machine-readable next steps for a cold agent (RC-2026-09-18-018)", async t => {
  const { origin } = await serve(t);
  const created = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Cold Start Bot" })
  });
  assert.equal(created.status, 201);
  const value = await created.json();
  assert.match(value.secret, /^pri_/);
  // The signup response must guide a brand-new agent to its first actions.
  assert.ok(Array.isArray(value.next) && value.next.length >= 4, "next[] is present and non-empty");
  const actions = value.next.map(step => step.action);
  for (const required of ["create-room", "redeem-invite", "request-access", "read-manifest"]) {
    assert.ok(actions.includes(required), `next[] names ${required}`);
  }
  for (const step of value.next) {
    assert.equal(typeof step.action, "string");
    assert.equal(typeof step.description, "string");
    assert.ok((step.method && step.path) || step.doc, "each step has a method+path or a doc pointer");
  }
});

test("identity secret is shown once: no read path returns it afterwards (RC-2026-09-18-042)", async t => {
  const { store, origin, ownerLab } = await serve(t);
  const created = await fetch(`${origin}/api/agent-identities`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName: "Once Bot" })
  });
  assert.equal(created.status, 201);
  const { identityId, secret } = await created.json();
  assert.match(secret, /^pri_/);
  // The public identity read carries no secret.
  const gotten = store.identities.get(identityId);
  assert.ok(gotten && !("secret" in gotten), "get() must never return the secret");
  assert.ok(!JSON.stringify(gotten).includes(secret), "secret must not appear in the identity record");
  // Owner-side link audit carries no secret either.
  const link = await fetch(`${origin}/api/rooms/lab/identity-links`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerLab}` },
    body: JSON.stringify({ identityId, permissions: ["accept_work"] })
  });
  assert.equal(link.status, 201);
  const list = await (await fetch(`${origin}/api/rooms/lab/identity-links`, {
    headers: { Origin: origin, Authorization: `Bearer ${ownerLab}` }
  })).json();
  assert.ok(!JSON.stringify(list).includes(secret), "secret must not appear in the owner link audit");
  assert.ok(!/"secret"/.test(JSON.stringify(list)), "no secret field anywhere in the audit list");
  // The database holds only the SHA-256 hash: the plaintext secret is unrecoverable server-side.
  const row = store.db.prepare("SELECT secret_hash FROM agent_identities WHERE identity_id=?").get(identityId);
  assert.ok(row && /^[a-f0-9]{64}$/.test(row.secret_hash), "only the hash is stored");
  assert.ok(!row.secret_hash.includes(secret.slice(4, 12)), "no plaintext fragment in the stored hash");
});

test("agent-visible surfaces never return owner tokens or session cookies (RC-2026-09-18-042)", async t => {
  const { origin, ownerLab } = await serve(t);
  const { identityId, secret } = await createAgentIdentity(origin, "Surface Bot");
  // Owner links with the owner credential (never shared with the agent).
  const link = await fetch(`${origin}/api/rooms/lab/identity-links`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${ownerLab}` },
    body: JSON.stringify({ identityId, permissions: ["accept_work"] })
  });
  assert.equal(link.status, 201);
  // As the agent: the room snapshot carries no credential material.
  const snapshot = await (await fetch(`${origin}/api/rooms/lab`, {
    headers: { Origin: origin, Authorization: `Bearer ${secret}` }
  })).json();
  assert.equal(snapshot.viewerId, identityId);
  for (const field of ["viewerAccountId", "viewerAuthEpoch", "viewerSessionBinding", "viewerSessionRevision"]) {
    assert.equal(snapshot[field], null, `${field} must be null for identity auth`);
  }
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(ownerLab), "the owner credential must never reach the agent");
  assert.ok(!serialized.includes(secret), "the agent's own secret is never echoed back");
  assert.ok(!/"csrf"|"credentialHash"|"sessionBinding"|"Set-Cookie"/.test(serialized),
    "no session or cookie material in the snapshot");
  // Presence, also agent-readable, leaks nothing either.
  const presence = await (await fetch(`${origin}/api/rooms/lab/presence`, {
    headers: { Origin: origin, Authorization: `Bearer ${secret}` }
  })).json();
  assert.ok(!JSON.stringify(presence).includes(ownerLab), "presence must not carry the owner credential");
});
