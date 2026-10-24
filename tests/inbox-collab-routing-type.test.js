// API-CD-1 regression: POST /collab/routing/mentions must refuse a
// non-string mentionedAgentId instead of coercing it. RegExp.test stringifies
// its argument, so before the typeof guard a numeric, boolean, null or
// one-element-array value passed the agent-name pattern and created a routing
// record for the coerced name ("12345", "true", "null"). This file is kept
// separate from tests/inbox-collab-http.test.js so it can land independently
// of changes to that suite; the harness mirrors it (real store, real server).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-routing-type-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const humanKey = store.issueAccessKey("commons", "owner");
  const state = { store, humanKey, server: null, origin: null };
  t.after(async () => {
    if (state.server) {
      state.server.closeStreams();
      state.server.closeAllConnections();
      await new Promise(resolve => state.server.close(resolve));
    }
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return state;
}

async function serve(state) {
  state.server = createRoomServer({ store: state.store });
  await new Promise(resolve => state.server.listen(0, "127.0.0.1", resolve));
  state.origin = "http://127.0.0.1:" + state.server.address().port;
}

const post = (f, body) => fetch(`${f.origin}/api/rooms/commons/collab/routing/mentions`,
  { method: "POST", headers: { Authorization: "Bearer " + f.humanKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const listRouting = async f => (await (await fetch(`${f.origin}/api/rooms/commons/collab/routing`,
  { headers: { Authorization: "Bearer " + f.humanKey } })).json()).records;

test("routing-mentions: non-string mentionedAgentId is refused, not coerced", async t => {
  const f = setup(t);
  await serve(f);

  // The pre-existing contract is unchanged for strings: a well-formed name
  // routes (201), a malformed name is refused (422 invalid_input).
  const ok = await post(f, { mentionedAgentId: "agent-1" });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).records[0].agent, "agent-1");
  const badString = await post(f, { mentionedAgentId: "not a name!" });
  assert.equal(badString.status, 422);
  assert.equal((await badString.json()).error.code, "invalid_input");

  // Every non-string type whose coerced form matches the name pattern used
  // to be accepted and stored; each must now get the same 422.
  for (const value of [12345, true, null, ["agent-1"], { name: "agent-1" }]) {
    const res = await post(f, { mentionedAgentId: value });
    assert.equal(res.status, 422, `mentionedAgentId ${JSON.stringify(value)} must be refused`);
    assert.equal((await res.json()).error.code, "invalid_input");
  }

  // Only the one legitimate string mention created a routing record.
  const records = await listRouting(f);
  assert.equal(records.length, 1);
  assert.equal(records[0].agent, "agent-1");
});
