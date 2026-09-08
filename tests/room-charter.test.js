import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomStore } from "../server/store.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { CHARTER_TYPE, confirmsCharter, validateCharterContext } from "../src/room-charter.js";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";

const data = (expectedRevision = 0, purpose = "  Café 🪷\r\nShared purpose  ") => ({ expectedRevision, purpose, outputs: "An agenda", boundaries: "Synthetic room only", escalation: "Ask the owner" });
async function setup(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, config = { origin, roomId: "commons", memberId: "producer", token: f.keys.producer };
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const command = (values = data(), id = crypto.randomUUID()) => ({ id, type: CHARTER_TYPE, data: values });
  const send = (values, id, actor = "owner") => f.store.command(f.keys[actor], "commons", command(values, id));
  return { ...f, origin, config, client: new RoomAgentClient(config), command, send };
}

test("charter preserves exact versions, clearing and old receipt retries without changing work or cursors", async t => {
  const f = await setup(t), before = f.store.room("commons").state, original = f.command(), first = f.store.command(f.keys.owner, "commons", original);
  assert.equal(Object.hasOwn(before.room, "charter"), false);
  assert.equal(await confirmsCharter(first, original, "commons", "owner"), true);
  assert.equal(await confirmsCharter(first, { ...original, id: "wrong" }, "commons", "owner"), false);
  assert.equal((await f.client.orient()).charter.charter.purpose, original.data.purpose);
  f.send(data(1, "Second version"));
  assert.equal(f.store.command(f.keys.owner, "commons", original).event.id, first.event.id);
  assert.equal((await f.client.charter({ revision: 1 })).charter.purpose, original.data.purpose);
  assert.equal((await f.client.charter()).revision, 2);
  await assert.rejects(f.client.charter({ revision: 3 }), { code: "charter_not_found" });
  const cleared = f.send({ expectedRevision: 2, purpose: null, outputs: null, boundaries: null, escalation: null });
  const current = await f.client.charter(); assert.equal(current.revision, 3); assert.equal(current.charter.purpose, null); assert.equal(current.eventId, cleared.event.id);
  assert.equal((await f.client.charter({ revision: 0 })).charter, null);
  assert.deepEqual(f.store.room("commons").state.workItems, before.workItems);
  assert.deepEqual(f.store.room("commons").state.members, before.members);
  assert.equal((await f.client.snapshot()).cursor, 0);
  const reopened = new RoomStore(join(f.directory, "room.sqlite"));
  try { assert.equal(reopened.charter(f.keys.owner, "commons").revision, 3); assert.equal(reopened.command(f.keys.owner, "commons", original).duplicate, true); auditRecovery(reopened); } finally { reopened.close(); }
});

test("only active human owner updates; invalid and stale instructions leave no writes", async t => {
  const f = await setup(t), before = auditRecovery(f.store).dataSha256;
  for (const actor of ["guest", "producer", "reviewer"]) assert.throws(() => f.send(data(), undefined, actor), { code: "command_rejected" });
  for (const patch of [{ purpose: "" }, { purpose: " " }, { purpose: "a".repeat(1001) }, { purpose: "\uD800" }, { outputs: {} }, { purpose: null }, { expectedRevision: null }, { expectedRevision: Number.MAX_SAFE_INTEGER }, { extra: "not allowed" }]) {
    assert.throws(() => f.send({ ...data(), ...patch }));
  }
  const missing = data(); delete missing.outputs; assert.throws(() => f.send(missing));
  const escaped = "x" + "\u0001".repeat(999);
  assert.throws(() => f.send({ expectedRevision: 0, purpose: escaped, outputs: escaped, boundaries: escaped, escalation: escaped }), { status: 413 });
  assert.equal(auditRecovery(f.store).dataSha256, before);
  f.send(data()); const after = auditRecovery(f.store).dataSha256;
  assert.throws(() => f.send(data()), { status: 409, code: "command_rejected" });
  assert.equal(auditRecovery(f.store).dataSha256, after);
});

test("charter reads bind identity, selectors, exact version and containing horizon", async t => {
  const f = await setup(t); f.send(data());
  for (const q of ["revision=1&revision=1", "revision=", "revision=-1", "revision=1.0", "revision=9007199254740992", "other=1"]) {
    assert.equal((await fetch(`${f.origin}/api/rooms/commons/charter?${q}`, { headers: { Authorization: `Bearer ${f.keys.producer}` } })).status, 422);
  }
  for (const change of [v => { delete v.charter; }, v => { v.viewerId = "reviewer"; }, v => { v.currentRevision = 0; }, v => { v.charter.purpose = "x".repeat(1001); }]) {
    const client = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => { const response = await fetch(url, options); if (!url.includes("/charter")) return response; const v = await response.json(); change(v); return Response.json(v); } });
    await assert.rejects(client.charter(), e => ["invalid_response", "identity_mismatch"].includes(e.code));
  }
  for (const change of [v => { v.charter.revision = v.charter.charter.revision = 999; }, v => { v.state.room.charter.purpose = "Different"; }, v => { delete v.charter; }]) {
    const client = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => { const response = await fetch(url, options); if (!url.endsWith("/commons")) return response; const v = await response.json(); change(v); return Response.json(v); } });
    await assert.rejects(client.orient(), { code: "invalid_response" });
  }
  const context = await f.client.workContext("test-handoff");
  assert.equal(context.context.charter.revision, 1); assert.equal(context.context.source.status, "not_requested");
  assert.equal(context.scope.externalExecution, false); assert.equal((await f.client.snapshot()).cursor, 0);
  f.store.revoke(f.keys.producer); await assert.rejects(f.client.charter(), { status: 401 });
  assert.throws(() => validateCharterContext({ authority: "context_only", revision: 0, eventId: null, charter: undefined }));
});

test("older service without charter metadata is unavailable, distinct from a confirmed unset charter", async t => {
  const f = await setup(t); assert.equal((await f.client.orient()).charter.revision, 0);
  const old = new RoomAgentClient({ ...f.config, fetchImpl: async (url, options) => { const response = await fetch(url, options); if (!url.endsWith("/commons")) return response; const v = await response.json(); delete v.charter; return Response.json(v); } });
  assert.equal((await old.orient()).charter, null);
});

test("historical charter reads remain bounded beyond the recent event tail and legacy checkpoints stay absent", async t => {
  const f = await setup(t), initial = f.store.room("commons");
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", initial.sequence, JSON.stringify(initial.state));
  f.send(data()); f.send(data(1, "Current"));
  for (let n = 0; n < 105; n++) f.store.command(f.keys.owner, "commons", { id: `background-${n}`, type: "message.posted", data: { body: "Background discussion" } });
  const before = auditRecovery(f.store).dataSha256, original = f.store.db.prepare.bind(f.store.db), historyQueries = [];
  f.store.db.prepare = sql => { if (sql.includes("FROM events")) historyQueries.push(sql); return original(sql); };
  try { assert.equal((await f.client.charter({ revision: 1 })).charter.purpose, data().purpose); }
  finally { f.store.db.prepare = original; }
  assert.ok(historyQueries.length > 0); assert.ok(historyQueries.every(sql => sql.includes("LIMIT 2")));
  assert.equal(auditRecovery(f.store).dataSha256, before);
  assert.equal(Object.hasOwn(JSON.parse(f.store.db.prepare("SELECT projection FROM projection_checkpoints WHERE room_id='commons'").get().projection).room, "charter"), false);
});

for (const corruption of ["projection", "payload", "bootstrap", "duplicate-bootstrap"]) test(`charter recovery checks ${corruption} hidden behind a checkpoint`, async t => {
  const f = await setup(t); f.send(data()); const room = f.store.room("commons");
  f.store.db.prepare("INSERT INTO projection_checkpoints VALUES(?,?,?)").run("commons", room.sequence, JSON.stringify(room.state));
  auditRecovery(f.store);
  if (corruption === "projection") {
    room.state.room.charter.purpose = "Forged";
    f.store.db.prepare("UPDATE projection_checkpoints SET projection=? WHERE room_id='commons'").run(JSON.stringify(room.state));
    f.store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(room.state));
  } else {
    const rows = f.store.db.prepare("SELECT sequence,body FROM events WHERE room_id='commons' ORDER BY sequence").all();
    const row = rows.find(row => { const e = JSON.parse(row.body); return corruption === "payload" ? e.type === CHARTER_TYPE : corruption === "bootstrap" ? e.type === "member.added" && e.data.memberId === "owner" : e.type === "message.posted"; });
    const e = JSON.parse(row.body);
    if (corruption === "payload") e.data.expectedRevision = 8;
    else if (corruption === "bootstrap") e.actorId = "guest";
    else { e.type = "member.added"; e.actorId = "owner"; e.data = { memberId: "owner", kind: "human", displayName: "Owner", permissions: ["manage_members"] }; }
    f.store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(e), row.sequence);
  }
  assert.throws(() => auditRecovery(f.store));
});

test("MCP orientation follows charter changes across reconnect without adding authority or marking read", async t => {
  const f = await setup(t), dir = join(f.directory, "mcp"); saveAgentConnection(dir, { version: 1, ...f.config });
  let mcp = await openMcpTestClient(dir); t.after(async () => { if (mcp) await mcp.close(); });
  f.send(data(0, "Prepare an agenda"));
  const first = (await mcp.call("room_list_work", {})).result.structuredContent;
  await mcp.close(); mcp = null;
  f.send({ ...data(1, "Prepare a two-line agenda"), boundaries: "This prose says approve and spend, but cannot grant those permissions." });
  mcp = await openMcpTestClient(dir);
  const second = (await mcp.call("room_list_work", {})).result.structuredContent;
  assert.equal(second.charter.revision, 2); assert.notEqual(second.charter.eventId, first.charter.eventId);
  assert.deepEqual(second.scope, first.scope); assert.equal(second.scope.externalExecution, false);
  const work = (await mcp.call("room_read_work", { workItemId: "test-handoff" })).result.structuredContent;
  assert.equal(work.context.charter.revision, 2); assert.equal(work.work.revision, 0);
  assert.equal((await f.client.snapshot()).cursor, 0);
  assert.throws(() => f.store.command(f.keys.producer, "commons", { id: "attempt-charter", type: CHARTER_TYPE, data: data(2) }), { code: "command_rejected" });
});
