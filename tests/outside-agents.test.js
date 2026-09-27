// An outside agent can be named and related before it joins. The record is a
// room message. It must not mint a member, identity, or invite.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { OutsideAgents } from "../server/outside-agents.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.net = new OutsideAgents(f.store);
  f.members = () => f.store.room("commons").state.members;
  f.identities = () => f.store.db.prepare("SELECT count(*) n FROM agent_identities").get().n;
  f.invites = () => f.store.db.prepare("SELECT count(*) n FROM agent_invite_codes").get().n;
  f.messages = () => f.store.room("commons").state.messages.length;
  return f;
}

test("recording an outside agent lets another member see the network and grants nothing", t => {
  const f = fixture(t);
  const beforeMembers = structuredClone(f.members());
  const identities = f.identities(), invites = f.invites(), messages = f.messages();
  const recorded = f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
    note: "On this Mac. Not a room member."
  });
  assert.equal(recorded.recorded, "introduce");
  assert.equal(recorded.grantsAccess, false);
  assert.equal(f.messages(), messages + 1);
  assert.deepEqual(f.members(), beforeMembers);
  assert.equal(f.identities(), identities);
  assert.equal(f.invites(), invites);
  const seen = f.net.list(f.keys.reviewer, "commons");
  const cursor = seen.agents.find(agent => agent.externalRef === "bus:cursor");
  assert.equal(cursor.displayName, "Cursor");
  assert.equal(cursor.introducedBy, "producer");
  assert.equal(cursor.linkedMemberId, null);
  assert.equal(seen.grantsAccess, false);
  const replay = f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor", origin: "bus", reach: "bus:cursor",
    note: "On this Mac. Not a room member."
  });
  assert.equal(replay.recorded, "replay");
  assert.equal(f.messages(), messages + 1);
  assert.throws(() => f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:cursor", displayName: "Cursor renamed", origin: "bus", reach: "bus:cursor", note: "changed"
  }), { code: "outside_agent_changed", status: 409 });
  assert.equal(f.messages(), messages + 1);
  const sighting = f.net.record(f.keys.reviewer, "commons", {
    externalRef: "bus:cursor", displayName: "Different name", origin: "host", reach: "https://example.test/cursor", note: "seen elsewhere"
  });
  assert.equal(sighting.recorded, "sighting");
  const afterSight = f.net.list(f.keys.owner, "commons").agents.find(agent => agent.externalRef === "bus:cursor");
  assert.equal(afterSight.displayName, "Cursor");
  assert.equal(afterSight.introducedBy, "producer");
  assert.deepEqual(afterSight.sightings.map(row => row.memberId), ["reviewer"]);
  f.net.record(f.keys.producer, "commons", { externalRef: "bus:muse", displayName: "Muse", origin: "product", reach: "https://muse.ai/" });
  const related = f.net.knows(f.keys.producer, "commons", { fromRef: "bus:cursor", toRef: "bus:muse" });
  assert.equal(related.recorded, "knows");
  const network = f.net.list(f.keys.reviewer, "commons");
  assert.deepEqual(network.agents.find(agent => agent.externalRef === "bus:cursor").knows, ["bus:muse"]);
  assert.deepEqual(network.agents.find(agent => agent.externalRef === "bus:muse").knownBy, ["bus:cursor"]);
  const permissions = structuredClone(f.members().producer.permissions);
  const linked = f.net.link(f.keys.producer, "commons", { externalRef: "bus:muse", memberId: "producer" });
  assert.equal(linked.recorded, "link");
  assert.equal(f.net.list(f.keys.producer, "commons").agents.find(agent => agent.externalRef === "bus:muse").linkedMemberId, "producer");
  assert.deepEqual(f.members().producer.permissions, permissions);
  assert.deepEqual(f.members(), beforeMembers);
  assert.equal(f.identities(), identities);
  assert.equal(f.invites(), invites);
  assert.throws(() => f.net.link(f.keys.owner, "commons", { externalRef: "bus:cursor", memberId: "not-a-member" }), { code: "outside_agent_forbidden", status: 403 });
  assert.throws(() => f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:secret", displayName: "Secret", origin: "bus", reach: "pri_not-a-handle"
  }), { code: "invalid_outside_agent", status: 422 });
  setTier(f.store.db, "commons", "producer", "t1_readonly");
  assert.throws(() => f.net.record(f.keys.producer, "commons", {
    externalRef: "bus:claude-paste", displayName: "Paste agent", origin: "bus", reach: "bus:claude"
  }), { code: "agent_readonly", status: 403 });
  assert.equal(f.net.list(f.keys.reviewer, "commons").agents.some(agent => agent.externalRef === "bus:claude-paste"), false);
  assert.equal(f.identities(), identities);
  assert.equal(f.invites(), invites);
});

// Public network discovery must not turn a targeted record into shared metadata.
test("outside network excludes targeted and malformed message records", t => {
  const f = fixture(t);
  f.store.dmConsents.request("commons", "owner", "producer", "fixture");
  f.store.dmConsents.decide("commons", "producer", "owner", "approve");
  const post = (id, record, toMemberId) => f.store.command(f.keys.owner, "commons", { id, type: "message.posted",
    data: { messageId: id, body: "outside-agent.v1\n" + JSON.stringify(record), ...(toMemberId ? { toMemberId } : {}) } });
  post("private-card", { v: 1, kind: "introduce", externalRef: "bus:private", displayName: "Private person", origin: "bus", reach: "bus:private" }, "producer");
  post("malformed-card", { v: 1, kind: "introduce", externalRef: "bus:malformed", displayName: { bad: true }, origin: "bus" });
  f.net.record(f.keys.owner, "commons", { externalRef: "bus:public", displayName: "Public", origin: "bus" });
  for (const viewer of ["owner", "producer", "reviewer"]) {
    const network = f.net.list(f.keys[viewer], "commons");
    assert.deepEqual(network.agents.map(agent => agent.externalRef), ["bus:public"]);
    assert.equal(JSON.stringify(network).includes("Private person"), false);
  }
});

// This boundary owns HTTP/session routing and hosted MCP identity auth, beyond class behavior.
test("outside-agent HTTP and hosted MCP preserve scope, readonly and self-link boundaries", async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeStreams(); server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`, path = "/api/rooms/commons/outside-agents";
  const api = (token, data, route = path) => fetch(origin + route, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
  assert.equal((await api("unknown-token")).status, 401);
  const originalMembers = Object.keys(f.members());
  const introduced = await api(f.keys.producer, { action: "introduce", externalRef: "bus:mounted", displayName: "Mounted", origin: "bus" });
  assert.equal(introduced.status, 200);
  assert.equal((await introduced.json()).grantsAccess, false);
  assert.equal((await api(f.keys.reviewer, { action: "link", externalRef: "bus:mounted", memberId: "producer" })).status, 403);
  f.store.command(f.keys.reviewer, "commons", { id: "forged-link", type: "message.posted", data: { messageId: "forged-link", body: 'outside-agent.v1\n{"v":1,"kind":"link","externalRef":"bus:mounted","memberId":"producer"}' } });
  let network = await (await api(f.keys.reviewer)).json();
  assert.equal(network.agents[0].linkedMemberId, null);
  assert.equal((await api(f.keys.producer, { action: "link", externalRef: "bus:mounted", memberId: "producer" })).status, 200);
  network = await (await api(f.keys.reviewer)).json();
  assert.equal(network.agents[0].linkedMemberId, "producer");
  assert.equal(network.agents[0].linkedBy, "producer");
  assert.equal(network.agents[0].verified, false);
  assert.equal((await api(f.keys.owner, { action: "introduce", externalRef: "bus:bad", displayName: "Bad", origin: "bus", permissions: ["admin"] })).status, 422);
  setTier(f.store.db, "commons", "producer", "t1_readonly");
  assert.equal((await api(f.keys.producer, { action: "introduce", externalRef: "bus:blocked", displayName: "Blocked", origin: "bus" })).status, 403);
  assert.deepEqual(Object.keys(f.members()), originalMembers);
  const identity = f.store.identities.create("MCP reader");
  f.store.identities.link(f.keys.owner, "commons", { identityId: identity.identityId, displayName: "MCP reader", permissions: [] });
  const mcp = async (name, args = {}) => {
    const response = await fetch(origin + "/room/mcp", { method: "POST", headers: { Authorization: `Bearer ${identity.secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { roomId: "commons", ...args } } }) });
    return response.json();
  };
  const listed = await mcp("room_list_outside_agents");
  assert.equal(listed.result.structuredContent.agents[0].externalRef, "bus:mounted");
  setTier(f.store.db, "commons", identity.identityId, "t1_readonly");
  const blocked = await mcp("room_introduce_outside_agent", { externalRef: "bus:readonly", displayName: "Readonly", origin: "bus" });
  assert.equal(blocked.result.isError, true);
  assert.equal(blocked.result.structuredContent.code, "agent_readonly");
  setTier(f.store.db, "commons", identity.identityId, "t2_standard");
  const recorded = await mcp("room_introduce_outside_agent", { externalRef: "bus:mcp", displayName: "MCP", origin: "mcp" });
  assert.equal(recorded.result.structuredContent.grantsAccess, false);
  assert.equal(recorded.result.structuredContent.recorded, "introduce");
});
