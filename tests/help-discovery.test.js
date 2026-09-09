import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { createRuntimePackage } from "../scripts/runtime-package.mjs";
import { frozenAcceptanceFixture } from "../scripts/frozen-runtime-fixture.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";

async function fixture(t, createFixture = createAcceptanceFixture, createServer = createRoomServer) {
  const f = createFixture();
  let now = Date.now();
  f.store.now = () => now;
  const send = (actor, type, data) => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send("owner", "member.added", { memberId: "helper", displayName: "Synthetic helper", kind: "agent",
    permissions: [], accountableHumanId: "owner" });
  f.keys.helper = f.store.issueAccessKey("commons", "helper");
  const work = (type, data = {}, workItemId = "test-handoff") => send("producer", type, { workItemId,
    expectedRevision: f.store.room("commons").state.workItems[workItemId].revision, ...data });
  work("work.accepted");
  const invite = (workItemId = "test-handoff") => work("work.help_updated", {
    expectedHelpRevision: f.store.room("commons").state.workItems[workItemId].helpWanted?.revision ?? 0,
    status: "open", scope: "Suggest two agenda items; do not change files.",
    expiresAt: new Date(now + 60000).toISOString() }, workItemId);
  const withdraw = () => work("work.help_updated", { expectedHelpRevision:
    f.store.room("commons").state.workItems["test-handoff"].helpWanted.revision, status: "withdrawn" });
  const server = createServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = (actor = "helper") => ({ origin, roomId: "commons", token: f.keys[actor],
    ...(["helper", "producer", "reviewer"].includes(actor) ? { memberId: actor } : {}) });
  const client = actor => new RoomAgentClient(config(actor));
  const list = actor => client(actor).orient({ focus: "help_wanted" });
  return { ...f, server, origin, send, work, invite, withdraw, config, client, list, now: () => now, advance: ms => { now += ms; } };
}

test("help discovery is opt-in, scoped and read-only for helpers, humans and independent reviewers", async t => {
  const f = await fixture(t);
  assert.equal((await f.list()).work.length, 0, "accepted work is not itself a help invitation");
  f.invite();
  const before = auditRecovery(f.store).dataSha256;
  for (const actor of ["helper", "guest", "owner", "producer", "reviewer"]) {
    const result = await f.list(actor), selected = await f.client(actor).workContext("test-handoff");
    const eligible = !["producer", "reviewer"].includes(actor);
    assert.equal(result.work.length, Number(eligible));
    assert.equal(result.clockSource, "service"); assert.equal(result.evaluatedAt, new Date(f.now()).toISOString());
    assert.equal(result.scope.externalExecution, false);
    assert.equal(selected.help.canOffer, eligible); assert.equal(selected.help.authority, "invitation_only");
    assert.equal(selected.help.canPublish, actor === "producer");
    assert.equal(selected.help.canWithdraw, ["producer", "owner"].includes(actor));
    if (eligible) {
      assert.deepEqual(result.work[0].help, selected.help);
      assert.equal(result.work[0].help.help.scope, "Suggest two agenda items; do not change files.");
      assert.equal(result.work[0].nextRead.arguments.workItemId, "test-handoff");
      assert.deepEqual(result.work[0].availableRoomActions, []);
    }
  }
  assert.equal(auditRecovery(f.store).dataSha256, before, "all-table audit and human read markers remain unchanged");
  assert.equal((await f.client().orient()).focus, undefined, "default orientation remains unchanged");
});

test("service-clock expiry, withdrawal and completed-work consent govern discovery", async t => {
  const f = await fixture(t); f.invite();
  t.mock.method(Date, "now", () => f.now() + 86400000);
  assert.equal((await f.list()).work.length, 1, "client clock skew cannot expire a service invitation");
  f.advance(60000);
  assert.equal((await f.list()).work.length, 0);
  assert.equal((await f.client().workContext("test-handoff")).help.status, "expired");
  f.invite(); assert.equal((await f.list()).work.length, 1);
  f.withdraw(); assert.equal((await f.list()).work.length, 0);
  assert.equal((await f.client().workContext("test-handoff")).help.status, "withdrawn");
  f.invite(); f.work("work.started");
  assert.equal((await f.list()).work.length, 1, "ordinary progress preserves the invitation");
  f.work("work.completed", { summary: "Synthetic agenda", nextAction: "Review", producerId: "producer",
    evidenceUrl: "https://example.invalid/not-fetched", evidenceVersion: "v1" });
  assert.equal((await f.list()).work.length, 0);
  f.work("work.blocked", { reason: "Revise", nextAction: "Discuss" });
  assert.equal((await f.client().workContext("test-handoff")).help.status, "consent_changed");
  assert.equal((await f.list()).work.length, 0, "rework cannot resurrect consent from before completion");
  f.invite(); assert.equal((await f.list()).work.length, 1);
});

test("help snapshot metadata is explicitly negotiated without changing old envelopes", async t => {
  const f = await fixture(t);
  const headers = { Authorization: `Bearer ${f.keys.helper}` };
  const get = (path, version) => fetch(f.origin + "/api/rooms/commons" + path,
    { headers: { ...headers, ...(version === undefined ? {} : { "X-Project-Room-Help-Context": version }) } });
  const old = await (await get("?view=work")).json();
  assert.equal(Object.hasOwn(old, "helpContextVersion"), false);
  assert.equal(Object.hasOwn(old, "evaluatedAt"), false);
  const response = await get("?view=work", "1"), current = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(current.helpContextVersion, 1);
  delete current.helpContextVersion; delete current.evaluatedAt;
  assert.deepEqual(current, old);
  for (const [path, version] of [["?view=work", "2"], ["?view=work", "1, 1"], ["", "1"]]) {
    const response = await get(path, version); assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "invalid_help_context");
  }
});

test("access changes invalidate consent; restoring a member requires a fresh invitation", async t => {
  const f = await fixture(t); f.invite();
  const access = active => {
    const member = f.store.room("commons").state.members.producer;
    f.send("owner", "member.access_changed", { memberId: "producer", expectedMemberRevision: member.revision,
      active, permissions: member.permissions });
  };
  access(false);
  assert.equal((await f.list()).work.length, 0);
  assert.equal((await f.client().workContext("test-handoff")).help.status, "accountable_unavailable");
  access(true); f.keys.producer = f.store.issueAccessKey("commons", "producer");
  assert.equal((await f.client().workContext("test-handoff")).help.status, "consent_changed");
  assert.equal((await f.list()).work.length, 0);
  f.invite(); assert.equal((await f.list()).work.length, 1);
  f.store.revoke(f.keys.helper);
  await assert.rejects(f.list(), { status: 401 });
});

test("help filtering precedes search limits and unqueried discovery includes every bounded match", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) {
    const id = `agenda-${i}`;
    f.send("owner", "work.proposed", { workItemId: id, title: `Agenda ${i}`, definitionOfDone: "Two useful topics",
      accountableMemberId: "producer", mode: "read" });
    f.work("work.accepted", {}, id);
    if (i >= 30) f.invite(id);
  }
  const before = auditRecovery(f.store).dataSha256, full = await f.list();
  assert.equal(full.work.length, 30); assert.equal(full.selection.helpWanted, 30);
  assert.equal(full.work.every(item => Number(item.id.split("-")[1]) >= 30), true);
  const search = await f.client().orient({ focus: "help_wanted", query: "agenda" });
  assert.equal(search.selection.eligibleWork, 30); assert.equal(search.selection.matches, 30);
  assert.equal(search.selection.shown, 25); assert.equal(search.selection.hasMore, true);
  assert.equal(search.work.every(item => Number(item.id.split("-")[1]) >= 30), true);
  assert.equal(auditRecovery(f.store).dataSha256, before);
});

test("malformed optional invitation metadata is refused once without weaker fallback reads", async t => {
  const f = await fixture(t); f.invite();
  const selected = await f.client().workContext("test-handoff");
  const snapshot = f.store.snapshot(f.keys.helper, "commons", null, "work", true);
  const checks = [
    [selected, value => { value.help.canOffer = false; }, client => client.workContext("test-handoff")],
    [selected, value => { delete value.help; }, client => client.workContext("test-handoff")],
    [selected, value => { delete value.helpContextVersion; }, client => client.workContext("test-handoff")],
    [selected, value => { value.help.help.scope = "Forged"; }, client => client.workContext("test-handoff")],
    [selected, value => { value.context.participants.find(p => p.id === "producer").revision++; }, client => client.workContext("test-handoff")],
    [snapshot, value => { delete value.evaluatedAt; }, client => client.orient({ focus: "help_wanted" })],
    [snapshot, value => { value.helpContextVersion = 2; }, client => client.orient({ focus: "help_wanted" })],
    [snapshot, value => { value.evaluatedAt = "2026-09-08"; }, client => client.orient({ focus: "help_wanted" })],
    [snapshot, value => { value.state.workItems["test-handoff"].helpWanted = null; }, client => client.orient({ focus: "help_wanted" })]
  ];
  const before = auditRecovery(f.store).dataSha256;
  for (const [original, mutate, run] of checks) {
    const value = structuredClone(original); mutate(value);
    const requests = [];
    const client = new RoomAgentClient({ ...f.config(), fetchImpl: (url, options) => {
      requests.push(url);
      return new URL(url).pathname === "/api/session" ? fetch(url, options) : Promise.resolve(Response.json(value));
    } });
    await assert.rejects(run(client), { code: "invalid_response" });
    assert.equal(requests.length, 2, "identity preflight plus one original read");
  }
  assert.equal(auditRecovery(f.store).dataSha256, before);
});

test("actual MCP discovery and reconnection keep current invitation boundaries without writes", async t => {
  const f = await fixture(t); f.invite();
  const directory = join(f.directory, "mcp"); saveAgentConnection(directory, { version: 1, ...f.config() });
  let mcp = await openMcpTestClient(directory);
  t.after(() => mcp?.close());
  const before = auditRecovery(f.store).dataSha256;
  const tools = (await mcp.request("tools/list")).result.tools;
  assert.equal(tools.length, 29);
  const tool = tools.find(tool => tool.name === "room_list_work");
  assert.ok(tool.inputSchema.properties.focus.enum.includes("help_wanted"));
  assert.equal(tool.annotations.readOnlyHint, true);
  let result = (await mcp.call("room_list_work", { focus: "help_wanted" })).result;
  assert.equal(result.structuredContent.work.length, 1);
  assert.match(result.structuredContent.selection.guidance, /not assignments/);
  const selected = (await mcp.call("room_read_work", result.structuredContent.work[0].nextRead.arguments)).result;
  assert.equal(selected.structuredContent.help.canOffer, true);
  assert.equal(auditRecovery(f.store).dataSha256, before);
  assert.equal((await mcp.close()).diagnostics, "");
  f.withdraw();
  const after = auditRecovery(f.store).dataSha256;
  mcp = await openMcpTestClient(directory);
  result = (await mcp.call("room_list_work", { focus: "help_wanted" })).result;
  assert.equal(result.structuredContent.work.length, 0);
  assert.equal(auditRecovery(f.store).dataSha256, after);
  assert.equal(JSON.stringify([result, selected]).includes(f.keys.helper), false);
});

test("real older schema13 service preserves data but explicitly lacks help discovery", async t => {
  const f = await fixture(t); f.invite();
  const runtime = join(f.directory, "older-runtime");
  createRuntimePackage({ repository: resolve("."), commit: "87a54234db084eb7a2fe31de092c6301b5158bd2", destination: runtime });
  const { createRoomServer: olderServer } = await import(pathToFileURL(join(runtime, "server/http.mjs")));
  const { auditRecovery: olderAudit } = await import(pathToFileURL(join(runtime, "server/recovery.mjs")));
  const { RoomAgentClient: OlderClient } = await import(pathToFileURL(join(runtime, "client/room-agent.mjs")));
  const olderClient = new OlderClient(f.config());
  assert.equal((await olderClient.orient({ query: "agenda" })).work.length, 1, "old client still reads the new service");
  assert.equal((await olderClient.orient({ focus: "needs_me" })).work.length, 0);
  assert.equal((await olderClient.workContext("test-handoff")).work.id, "test-handoff");
  const createOldFixture = await frozenAcceptanceFixture(resolve("."), runtime, "87a54234db084eb7a2fe31de092c6301b5158bd2");
  const old = await fixture(t, createOldFixture, olderServer); old.invite();
  const client = new RoomAgentClient(old.config()), before = olderAudit(old.store).dataSha256;
  assert.equal((await client.workContext("test-handoff")).help, undefined);
  assert.equal((await client.orient({ query: "agenda" })).work.length, 1);
  await assert.rejects(client.orient({ focus: "help_wanted" }), { code: "help_context_unavailable" });
  const directory = join(old.directory, "old-mcp"); saveAgentConnection(directory, { version: 1, ...old.config() });
  const mcp = await openMcpTestClient(directory);
  try {
    const result = (await mcp.call("room_list_work", { focus: "help_wanted" })).result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.code, "help_context_unavailable");
  } finally { await mcp.close(); }
  assert.equal(olderAudit(old.store).dataSha256, before);
  assert.equal(old.store.room("commons").state.workItems["test-handoff"].helpWanted.status, "open");
});
