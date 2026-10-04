import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createResultsFixture } from "../scripts/results-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { saveAgentConnection } from "../client/agent-connection.mjs";
import { openMcpTestClient } from "../scripts/mcp-test-client.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function setup(t) {
  const f = createResultsFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  // Producer's completed work: database-flavored history.
  f.create("hist-db-1", "Postgres index tuning guide");
  f.create("hist-db-2", "Postgres vacuum scheduling");
  // Open candidates: a near-repeat, an adjacent stretch, and pure noise.
  const propose = (id, title, definitionOfDone) => f.send("owner", T.WORK_PROPOSED, {
    workItemId: id, title, definitionOfDone,
    accountableMemberId: "producer", verifierMemberId: null,
    independentVerificationRequired: false, ownerDecisionRequired: false,
    humanDecisionMakerId: null, mode: "read" });
  propose("open-routine", "Postgres index tuning checklist", "Check the Postgres index tuning steps once more.");
  propose("open-stretch", "Postgres connection pool sizing", "Size the Postgres connection pool for the new service.");
  propose("open-noise", "Sourdough starter hydration", "Hydration ratios for a sourdough starter.");
  return f;
}

async function mcpAs(t, f, memberId) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = join(f.directory, `connection-${memberId}`);
  saveAgentConnection(directory, { version: 1, origin, roomId: "commons", memberId, token: f.keys[memberId] });
  const mcp = await openMcpTestClient(directory);
  t.after(async () => { await mcp.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return mcp;
}

function checkShape(result) {
  assert.equal(result.sort, "curiosity");
  assert.ok(Array.isArray(result.work) && result.work.length > 0);
  for (const entry of result.work) {
    assert.equal(typeof entry.curiosity, "object");
    assert.ok(entry.curiosity.score >= 0 && entry.curiosity.score <= 1, "score in [0,1]");
    assert.ok(entry.curiosity.familiarity >= 0 && entry.curiosity.familiarity <= 1, "familiarity in [0,1]");
    assert.equal(typeof entry.curiosity.label, "string");
  }
  const scores = result.work.map(e => e.curiosity.score);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores, "scores strictly non-increasing");
}

test("room_list_work sort=curiosity ranks the adjacent stretch first with per-item curiosity", { timeout: 20000 }, async t => {
  const f = setup(t), mcp = await mcpAs(t, f, "producer");
  const result = (await mcp.call("room_list_work", { focus: "all", sort: "curiosity" })).result.structuredContent;
  checkShape(result);
  const byId = Object.fromEntries(result.work.map(e => [e.id, e.curiosity]));
  assert.equal(result.work[0].id, "open-stretch");
  assert.ok(byId["open-stretch"].score > byId["open-routine"].score, "stretch beats near-repeat");
  assert.ok(byId["open-stretch"].score > byId["open-noise"].score, "stretch beats noise");
  assert.ok(byId["open-routine"].familiarity > byId["open-noise"].familiarity, "repeat is more familiar than noise");
  const again = (await mcp.call("room_list_work", { focus: "all", sort: "curiosity" })).result.structuredContent;
  assert.deepEqual(again.work.map(e => e.id), result.work.map(e => e.id), "ranking is deterministic");
});

test("sort=curiosity with no completed work labels every item unranked", { timeout: 20000 }, async t => {
  const f = setup(t), mcp = await mcpAs(t, f, "reviewer");
  const result = (await mcp.call("room_list_work", { focus: "all", sort: "curiosity" })).result.structuredContent;
  checkShape(result);
  for (const entry of result.work) assert.equal(entry.curiosity.label, "unranked — no completed work yet");
});

test("room_list_work rejects unknown sort values and is unchanged without sort", { timeout: 20000 }, async t => {
  const f = setup(t), mcp = await mcpAs(t, f, "producer");
  for (const sort of ["bogus", "", "newest", null]) {
    assert.equal((await mcp.call("room_list_work", { sort })).error.code, -32602, JSON.stringify(sort));
  }
  const plain = (await mcp.call("room_list_work", { focus: "all" })).result.structuredContent;
  assert.equal(plain.sort, undefined);
  assert.ok(plain.work.every(e => e.curiosity === undefined), "no curiosity fields without sort");
});
