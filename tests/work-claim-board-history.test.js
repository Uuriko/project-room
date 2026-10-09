// FIX-16 (WAVE-300 ranked-fixes burn-down): the board list truncates claim
// history to the newest 3 entries. The truncation must be LOUD — list items
// carry historyOmitted with the count of cut entries — and the successor
// runbook (docs/WORK-CLAIMS.md) says to reconstruct history from the
// per-claim GET, never the board list. This test pins both halves at the
// HTTP boundary: a claim with 11 history entries lists as 3 + historyOmitted
// 8, while GET /work-claims/{id} returns all 11.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = token => new RoomAgentClient({ origin, roomId: "commons", token });
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { store, ownerKey, owner: client(ownerKey), call };
}

test("FIX-16: board list marks truncated history loudly; per-claim GET returns it all", async t => {
  const { call, ownerKey } = await fixture(t);
  // 1 (created) + 1 (claimed) + 1 (retention_ack stamped by the claim route)
  // + 8 note updates = 11 history entries.
  assert.equal((await call(ownerKey, "/work-claims", { id: "ten-stamps", title: "Ten stamps" })).status, 201);
  assert.equal((await call(ownerKey, "/work-claims/ten-stamps/claim", { leaseHours: 6 })).status, 200);
  for (let i = 0; i < 8; i++) {
    const updated = await call(ownerKey, "/work-claims/ten-stamps/update", { note: `progress ${i}` });
    assert.equal(updated.status, 200, `update ${i} should land`);
  }

  // Half 1 — the truncation is loud on the board list.
  const board = await call(ownerKey, "/work-claims");
  assert.equal(board.status, 200);
  assert.equal(board.value.historyLimit, 3, "page metadata names the history cap");
  const listed = board.value.claims.find(claim => claim.id === "ten-stamps");
  assert.ok(listed, "claim appears on the board");
  assert.equal(listed.history.length, 3, "board list shows only the newest 3 entries");
  assert.equal(listed.historyOmitted, 8, "historyOmitted counts the 8 cut entries");
  assert.equal(listed.history[2].note, "progress 7", "the kept entries are the newest");
  assert.equal(listed.history[0].note, "progress 5");

  // Half 2 — the per-claim GET is the full-history path the runbook prescribes.
  const read = await call(ownerKey, "/work-claims/ten-stamps");
  assert.equal(read.status, 200);
  assert.equal(read.value.history.length, 11, "per-claim GET returns all 11 entries");
  assert.ok(!("historyOmitted" in read.value), "nothing omitted, no marker needed");
  assert.equal(read.value.history[0].action, "created");
  assert.equal(read.value.history[10].note, "progress 7");

  // The queued and state-filtered lists truncate identically.
  const byState = await call(ownerKey, "/work-claims?state=claimed");
  assert.equal(byState.status, 200);
  const filtered = byState.value.claims.find(claim => claim.id === "ten-stamps");
  assert.equal(filtered.history.length, 3);
  assert.equal(filtered.historyOmitted, 8);
});
