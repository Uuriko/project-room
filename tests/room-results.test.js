import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { currentResult, completedResults } from "../src/work-selectors.js";
import { createResultsFixture } from "../scripts/results-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { auditRecovery } from "../server/recovery.mjs";

function fixture(t) {
  const f = createResultsFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}
test("results distinguish current completed work, approval and pending gates without mutating records", t => {
  const f = fixture(t), state = f.state(), before = JSON.stringify(state);
  assert.deepEqual(completedResults(state).map(i => i.id).sort(), ["approved-result", "native-result"]);
  assert.equal(currentResult(state.workItems["native-result"]).status, "completed");
  assert.equal(currentResult(state.workItems["approved-result"]).status, "approved");
  assert.equal(currentResult(state.workItems["pending-result"]), null);
  assert.equal(currentResult(state.workItems["test-handoff"]), null);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(completedResults({ workItems: {} }), []);
});
test("historical or mismatched approvals, superseded work and missing evidence cannot appear as current results", t => {
  const f = fixture(t), original = f.state().workItems["approved-result"];
  for (const patch of [
    { state: "accepted" }, { state: "blocked" }, { state: "superseded" }, { supersededBy: "replacement" },
    { receipt: null }, { receipt: { ...original.receipt, eventId: "" } },
    { receipt: { ...original.receipt, evidenceVersion: "replacement" } },
    { verification: { ...original.verification, independenceConfirmed: false } },
    { decision: { ...original.decision, completionEventId: "older" } }
  ]) assert.equal(currentResult({ ...original, ...patch }), null, JSON.stringify(patch));
  f.reopen("approved-result");
  assert.equal(currentResult(f.state().workItems["approved-result"]), null);
});
test("result ordering has stable ID ties and keeps only current room projections", t => {
  const f = fixture(t), a = f.state().workItems["native-result"];
  const state = { workItems: { z: { ...a, id: "z", updatedAt: "2026-01-01" }, a: { ...a, id: "a", updatedAt: "2026-01-01" } },
    inbox: [{ title: "private" }], history: [{ ...a, id: "history-only" }] };
  assert.deepEqual(completedResults(state).map(i => i.id), ["a", "z"]);
});
test("real API and MCP clients share Results, read pinned text, recheck reopening and make no room writes", { timeout: 20000 }, async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { origin: `http://127.0.0.1:${server.address().port}`, roomId: "commons", memberId: "producer", token: f.keys.producer };
  const client = new RoomAgentClient(config), directory = join(f.directory, "connection");
  saveAgentConnection(directory, { version: 1, ...config });
  const mcp = await openMcpTestClient(directory);
  t.after(async () => { await mcp.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const before = auditRecovery(f.store).dataSha256;
  const direct = await client.orient({ focus: "results" });
  const result = (await mcp.call("room_list_work", { focus: "results" })).result.structuredContent;
  assert.deepEqual(result.work, direct.work);
  assert.deepEqual(result.work.map(i => i.id), completedResults(f.state()).map(i => i.id));
  const pointer = result.work.find(i => i.id === "native-result").nextResultRead;
  const exact = (await mcp.call(pointer.tool, pointer.arguments)).result.structuredContent;
  assert.equal(exact.result.text.body, f.body);
  assert.equal(result.work.find(i => i.id === "approved-result").nextResultRead, null);
  assert.equal((await client.orient({ focus: "results", query: "Awaiting" })).work.length, 0);
  assert.equal((await client.orient({ focus: "results", query: "Café" })).work[0].id, "native-result");
  assert.equal(auditRecovery(f.store).dataSha256, before);
  f.reopen("native-result");
  assert.equal((await client.orient({ focus: "results" })).work.some(i => i.id === "native-result"), false);
  f.store.revoke(f.keys.producer);
  await assert.rejects(client.orient({ focus: "results" }), { status: 401 });
});
