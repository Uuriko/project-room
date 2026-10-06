// plan-squads: squad object {id,name,goal,members,channel}; the channel is a
// room thread (thread-root message id); @squad/<name> fans out to members via
// the mention lifecycle; work offers target a squad through claim.squadId.
// REST + MCP + UI read parity.
//
// Authoring-gate answers: each test below guards an observable contract of
// the new surface (no existing coverage — nothing named squad exists).
// Credible regressions: route 404/500, fanout silently not notifying,
// roster corruption, squadId silently dropped from claims. No test-only
// production seams: tests drive the public HTTP, MCP, and store boundaries.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { parseSquadMentions, validateSquadName, createSquad } from "../server/squads.mjs";
import { SQUAD_ROUTES } from "../server/routes/squads.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// --- route table -----------------------------------------------------------------

test("SQUAD_ROUTES registers the five squad rows in the route table", () => {
  const rows = new Map(SQUAD_ROUTES.map(row => [`${row.method} ${row.path}`, row]));
  for (const key of [
    "GET /api/rooms/{roomId}/squads",
    "POST /api/rooms/{roomId}/squads",
    "GET /api/rooms/{roomId}/squads/{squadId}",
    "POST /api/rooms/{roomId}/squads/{squadId}/members",
    "POST /api/rooms/{roomId}/squads/{squadId}/disband",
  ]) {
    const row = rows.get(key);
    assert.ok(row, `${key} is a route-table row`);
    assert.equal(row.auth, "room");
    assert.equal(row.scope, "room");
    assert.equal(typeof row.handler, "function");
  }
});

// --- pure unit ---------------------------------------------------------------

test("parseSquadMentions extracts @squad/<name> handles only", () => {
  assert.deepEqual(parseSquadMentions("hey @squad/crew ship it"), ["crew"]);
  assert.deepEqual(parseSquadMentions("@squad/crew and @squad/crew twice"), ["crew"]);
  assert.deepEqual(parseSquadMentions("two: @squad/alpha @squad/beta-2"), ["alpha", "beta-2"]);
  assert.deepEqual(parseSquadMentions("@SQUAD/Crew"), ["crew"], "handle matching is case-insensitive");
  assert.deepEqual(parseSquadMentions("mail jill@x.com, not @_squad/crew, not @squad/"), []);
  assert.deepEqual(parseSquadMentions("@crew is a member, not a squad"), []);
  assert.deepEqual(parseSquadMentions(""), []);
  assert.deepEqual(parseSquadMentions(null), []);
});

test("validateSquadName rejects blanks, bad chars, and overlong names", () => {
  assert.equal(validateSquadName("crew"), "crew");
  assert.throws(() => validateSquadName(""), /squad name/);
  assert.throws(() => validateSquadName("  "), /squad name/);
  assert.throws(() => validateSquadName("has space"), /squad name/);
  assert.throws(() => validateSquadName("squad/crew"), /squad name/);
  assert.throws(() => validateSquadName("x".repeat(65)), /squad name/);
  assert.throws(() => validateSquadName(42), /squad name/);
});

// --- fixtures ----------------------------------------------------------------

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-squads-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (token, type, data) => store.command(token, "commons", { id: randomUUID(), type, data });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "guest", displayName: "Guest", kind: "human", permissions: [] });
  cmd(ownerKey, T.MEMBER_ADDED, { memberId: "helper", displayName: "Helper", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
  const guestKey = store.issueAccessKey("commons", "guest"), helperKey = store.issueAccessKey("commons", "helper");
  const post = (token, body) => cmd(token, T.MESSAGE_POSTED, { messageId: randomUUID(), body }).event.data.messageId;
  return { directory, store, ownerKey, guestKey, helperKey, cmd, post };
}

async function serve(t) {
  const f = storeFixture(t);
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, token, body, path) => {
    const res = await fetch(`${origin}${path}`, {
      method, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const squads = (method, token, body, suffix = "") => call(method, token, body, `/api/rooms/commons/squads${suffix}`);
  return { ...f, origin, squads };
}

// --- REST: create / list / get -------------------------------------------------

test("routes: POST /squads creates a squad; GET lists and reads it", async t => {
  const f = await serve(t);
  const m1 = f.post(f.ownerKey, "thread root: launch plan");
  assert.equal((await f.squads("GET", null)).status, 401, "no credential, no list");

  const created = await f.squads("POST", f.ownerKey, { name: "crew", goal: "ship the launch", channelMessageId: m1, memberIds: ["guest"] });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const squad = created.json.squad;
  assert.match(squad.id, /^sq_/);
  assert.equal(squad.name, "crew");
  assert.equal(squad.goal, "ship the launch");
  assert.equal(squad.channel, m1, "channel is the thread-root message id");
  assert.deepEqual([...squad.members].sort(), ["guest", "owner"], "creator is owner and member");
  assert.equal(squad.owner, "owner");
  assert.equal(squad.state, "active");

  const listed = await f.squads("GET", f.guestKey);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.squads.length, 1);
  assert.equal(listed.json.squads[0].id, squad.id);

  const one = await f.squads("GET", f.guestKey, undefined, `/${squad.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.squad.id, squad.id);
  assert.equal((await f.squads("GET", f.guestKey, undefined, "/sq_missing")).status, 404);
});

test("routes: POST /squads validates name, channel, and members", async t => {
  const f = await serve(t);
  const m1 = f.post(f.ownerKey, "thread root");
  const bad = [
    [{}, "invalid_squad"],
    [{ name: "" }, "invalid_squad"],
    [{ name: "has space" }, "invalid_squad"],
    [{ name: "crew", channelMessageId: "nope" }, "squad_channel_unknown"],
    [{ name: "crew", memberIds: ["stranger"] }, "squad_member_unknown"],
    [{ name: "crew", memberIds: "guest" }, "invalid_squad"],
    [{ name: "crew", goal: 42 }, "invalid_squad"],
    [{ name: "crew", extra: 1 }, "invalid_squad"],
  ];
  for (const [body, code] of bad) {
    const res = await f.squads("POST", f.ownerKey, body);
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.equal(res.json.error.code, code, JSON.stringify(body));
  }
  const first = await f.squads("POST", f.ownerKey, { name: "Crew", channelMessageId: m1 });
  assert.equal(first.status, 201);
  const dup = await f.squads("POST", f.ownerKey, { name: "crew", channelMessageId: m1 });
  assert.equal(dup.status, 409, "squad names are unique per room, case-insensitively");
  assert.equal(dup.json.error.code, "squad_exists");
});

// --- REST: membership + disband -----------------------------------------------

test("routes: squad roster is owner-managed; members can leave; owner can disband", async t => {
  const f = await serve(t);
  const created = await f.squads("POST", f.ownerKey, { name: "crew", memberIds: ["guest"] });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.squad.id;
  const members = (token, body) => f.squads("POST", token, body, `/${id}/members`);

  assert.equal((await members(f.guestKey, { add: ["helper"] })).status, 403, "non-owner cannot add");
  const added = await members(f.ownerKey, { add: ["helper"] });
  assert.equal(added.status, 200);
  assert.deepEqual([...added.json.squad.members].sort(), ["guest", "helper", "owner"]);

  const left = await members(f.guestKey, { remove: ["guest"] });
  assert.equal(left.status, 200, "a member can remove themselves");
  assert.ok(!left.json.squad.members.includes("guest"));

  assert.equal((await members(f.guestKey, { remove: ["helper"] })).status, 403, "non-owner cannot remove others");
  assert.equal((await members(f.ownerKey, { remove: ["owner"] })).status, 422, "owner cannot remove themselves while active");

  assert.equal((await f.squads("POST", f.guestKey, {}, `/${id}/disband`)).status, 403, "only the owner disbands");
  const disbanded = await f.squads("POST", f.ownerKey, {}, `/${id}/disband`);
  assert.equal(disbanded.status, 200);
  assert.equal(disbanded.json.squad.state, "disbanded");
  const listed = await f.squads("GET", f.ownerKey);
  assert.ok(listed.json.squads.find(s => s.id === id && s.state === "disbanded"), "disbanded squads stay listed with state");
});

// --- REST: roster cap ---------------------------------------------------------------

test("routes: squad roster caps at 12 members", async t => {
  const f = await serve(t);
  for (let i = 0; i < 13; i++) {
    f.cmd(f.ownerKey, T.MEMBER_ADDED, { memberId: `m${i}`, displayName: `M${i}`, kind: "agent", permissions: [], accountableHumanId: "owner" });
  }
  const ids = Array.from({ length: 13 }, (_, i) => `m${i}`);
  const over = await f.squads("POST", f.ownerKey, { name: "big", memberIds: ids });
  assert.equal(over.status, 422, "owner + 13 would exceed the cap");
  assert.equal(over.json.error.code, "squad_roster_full");
  const ok = await f.squads("POST", f.ownerKey, { name: "ok", memberIds: ids.slice(0, 11) });
  assert.equal(ok.status, 201, "owner + 11 = 12 members fits the cap");
  const id = ok.json.squad.id;
  const add = await f.squads("POST", f.ownerKey, { add: ["m11", "m12"] }, `/${id}/members`);
  assert.equal(add.status, 422, "growing past the cap is refused");
  assert.equal(add.json.error.code, "squad_roster_full");
});

// --- @squad fanout ---------------------------------------------------------------

test("@squad/<name> fans out to one mention row per active member, never the sender", async t => {
  const f = await serve(t);
  const created = await f.squads("POST", f.ownerKey, { name: "crew", memberIds: ["guest", "helper"] });
  assert.equal(created.status, 201);

  const eventId = f.cmd(f.guestKey, T.MESSAGE_POSTED, { messageId: randomUUID(), body: "hey @squad/crew, review this" }).event.id;
  const rows = f.store.db.prepare(
    "SELECT mentioned_member_id AS id FROM mention_states WHERE room_id='commons' AND message_event_id=? ORDER BY 1").all(eventId).map(r => r.id);
  assert.deepEqual(rows, ["helper", "owner"], "every active member except the sender gets a mention row");

  // Unknown squads and disbanded squads fan out to nobody.
  const e2 = f.cmd(f.guestKey, T.MESSAGE_POSTED, { messageId: randomUUID(), body: "hey @squad/nonexistent" }).event.id;
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM mention_states WHERE message_event_id=?").get(e2).n, 0);
  await f.squads("POST", f.ownerKey, {}, `/${created.json.squad.id}/disband`);
  const e3 = f.cmd(f.ownerKey, T.MESSAGE_POSTED, { messageId: randomUUID(), body: "ping @squad/crew" }).event.id;
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM mention_states WHERE message_event_id=?").get(e3).n, 0,
    "disbanded squads do not fan out");
});

// --- work offers target a squad ----------------------------------------------------

test("work offers target a squad through claim.squadId", async t => {
  const f = await serve(t);
  const created = await f.squads("POST", f.ownerKey, { name: "crew" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const squadId = created.json.squad.id;
  const post = async (body) => {
    const res = await fetch(`${f.origin}/api/rooms/commons/work-claims`, {
      method: "POST", headers: { Origin: f.origin, Authorization: `Bearer ${f.ownerKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  const bad = await post({ id: "offer-bad", title: "bad target", squadId: "sq_missing" });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "squad_unknown");

  const offer = await post({ id: "offer-1", title: "squad offer", squadId });
  assert.equal(offer.status, 201, JSON.stringify(offer.json));
  assert.equal(offer.json.squadId, squadId, "the created claim carries its squad target");

  const list = await fetch(`${f.origin}/api/rooms/commons/work-claims`, { headers: { Origin: f.origin, Authorization: `Bearer ${f.ownerKey}` } })
    .then(r => r.json());
  const found = (list.claims ?? list.items ?? []).find(c => c.id === "offer-1");
  assert.equal(found?.squadId, squadId, "squadId survives the sqlite row round-trip on the board list");
});

// --- MCP parity ----------------------------------------------------------------------

test("mcp: squads_list and squads_get read squads", async t => {
  const f = storeFixture(t);
  const owner = f.store.identities.create("Owen");
  const rooms = new AgentRooms(f.store);
  const createdRoom = rooms.create(owner.secret, { title: "Squad room", purpose: "squad mcp", displayName: "Owen" });
  const roomId = createdRoom.roomId;
  const mcp = createHostedRoomMcp(f.store);
  const rpcCall = (name, args, secret) => mcp(
    { jsonrpc: "2.0", id: "c", method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${secret}` });
  const valueOf = response => {
    if (response.error) throw new Error(`mcp error: ${JSON.stringify(response.error)}`);
    return response.result?.structuredContent ?? JSON.parse(response.result.content[0].text);
  };

  const listed = await mcp({ jsonrpc: "2.0", id: "l", method: "tools/list", params: { profile: "full" } }, { authorization: `Bearer ${owner.secret}` });
  const names = listed.result.tools.map(tool => tool.name);
  assert.ok(names.includes("squads_list"), "squads_list is in the hosted catalog");
  assert.ok(names.includes("squads_get"), "squads_get is in the hosted catalog");
  assert.ok(names.includes("squads_create"), "squads_create is in the hosted catalog");
  assert.ok(names.includes("squads_update_members"), "squads_update_members is in the hosted catalog");
  assert.ok(names.includes("squads_disband"), "squads_disband is in the hosted catalog");

  const empty = valueOf(await rpcCall("squads_list", { roomId }, owner.secret));
  assert.deepEqual(empty.squads, []);

  // create through the store-level API (same function the REST route calls):
  const squad = createSquad(f.store, owner.secret, roomId, { name: "crew", goal: "ship it" }).squad;
  const after = valueOf(await rpcCall("squads_list", { roomId }, owner.secret));
  assert.equal(after.squads.length, 1);
  assert.equal(after.squads[0].name, "crew");
  const one = valueOf(await rpcCall("squads_get", { roomId, squadId: squad.id }, owner.secret));
  assert.equal(one.squad.id, squad.id);
  assert.equal(one.squad.goal, "ship it");
});

test("mcp: squads_create, squads_update_members, and squads_disband write squads", async t => {
  const f = storeFixture(t);
  const owner = f.store.identities.create("Owen");
  const rooms = new AgentRooms(f.store);
  const createdRoom = rooms.create(owner.secret, { title: "Squad room", purpose: "squad mcp writes", displayName: "Owen" });
  const roomId = createdRoom.roomId;
  const mcp = createHostedRoomMcp(f.store);
  const rpcCall = (name, args, secret) => mcp(
    { jsonrpc: "2.0", id: "c", method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${secret}` });
  const valueOf = response => {
    if (response.error) throw new Error(`mcp error: ${JSON.stringify(response.error)}`);
    return response.result?.structuredContent ?? JSON.parse(response.result.content[0].text);
  };

  const created = valueOf(await rpcCall("squads_create", { roomId, name: "crew", goal: "ship it" }, owner.secret));
  assert.equal(created.squad.name, "crew");
  assert.equal(created.squad.goal, "ship it");
  const ownerMemberId = created.squad.owner;
  assert.ok(created.squad.members.includes(ownerMemberId), "the caller becomes owner and member");

  const updated = valueOf(await rpcCall("squads_update_members",
    { roomId, squadId: created.squad.id, add: [ownerMemberId] }, owner.secret));
  assert.deepEqual(updated.squad.members, created.squad.members, "adding an existing member is a no-op");

  const disbanded = valueOf(await rpcCall("squads_disband", { roomId, squadId: created.squad.id }, owner.secret));
  assert.equal(disbanded.squad.state, "disbanded");
});
