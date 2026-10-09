// FIX-2 (WAVE-300 ranked-fixes): work-claim heartbeat discoverability.
//
// The real liveness path for a work-claim is
//   POST /api/rooms/{roomId}/work-claims/{claimId}/renew
// with an empty body (a heartbeat): it records a `renewed` history entry and
// extends the lease with the current terms. There is NO
//   POST /api/rooms/{roomId}/work-claims/{claimId}/heartbeat
// route (guessing it 404s), and the only documented `/heartbeat` for claims
// is the retired board/v2 one, which returns 410 board_v2_retired.
// These tests pin that contract against the running server, plus the doc
// pins that keep agents from guessing dead shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-fix2-heartbeat-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const key = store.issueAccessKey("commons", "owner");
  const call = async (path, data, token = key) => {
    const r = await fetch(`${origin}/api/rooms/commons/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, body: await r.json() };
  };
  return { call };
}

test("renew with an empty body is the heartbeat: 200, lease extended, heartbeat recorded", async t => {
  const { call } = await boot(t);
  const made = await call("work-claims", { id: "hb-1" });
  assert.equal(made.status, 201);
  const claimed = await call("work-claims/hb-1/claim", { leaseHours: 1 });
  assert.equal(claimed.status, 200);
  const before = Date.parse(claimed.body.leaseExpiresAt);

  const heartbeat = await call("work-claims/hb-1/renew", {});
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body).slice(0, 300));
  assert.ok(Date.parse(heartbeat.body.leaseExpiresAt) > before, "heartbeat extends the lease");
  const actions = heartbeat.body.history.map(h => h.action);
  assert.ok(actions.includes("renewed"), `heartbeat must record a "renewed" history entry, got ${JSON.stringify(actions)}`);

  // A heartbeat with a note also works and does not change lease terms.
  const noted = await call("work-claims/hb-1/renew", { note: "still crunching" });
  assert.equal(noted.status, 200);
  assert.ok(noted.body.history.some(h => h.action === "renewed" && h.note === "still crunching"));

  // .../update {"state"} is a state move, not a heartbeat: it changes state.
  const moved = await call("work-claims/hb-1/update", { state: "in_progress" });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.state, "in_progress");
});

test("there is no work-claims heartbeat sub-route; the guessed shape 404s", async t => {
  const { call } = await boot(t);
  const made = await call("work-claims", { id: "hb-2" });
  assert.equal(made.status, 201);
  await call("work-claims/hb-2/claim", { leaseHours: 1 });
  const guessed = await call("work-claims/hb-2/heartbeat", {});
  assert.equal(guessed.status, 404, `guessed heartbeat shape must not be documented as live; got ${guessed.status}`);
});

test("board/v2 heartbeat returns 410 retired with a pointer at work-claims", async t => {
  const { call } = await boot(t);
  const dead = await call("board/v2/claims/x/heartbeat", {});
  assert.equal(dead.status, 410);
  assert.equal(dead.body?.error?.code, "board_v2_retired");
  assert.ok(dead.body.next?.[0]?.href?.includes("work-claims"), "retired route must point at work-claims");
});

test("openapi: renew is pinned as the claim heartbeat and board/v2 heartbeat is marked retired", async t => {
  const spec = YAML.parse(readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
  const renew = spec.paths["/api/rooms/{roomId}/work-claims/{claimId}/renew"]?.post;
  assert.ok(renew, "renew path must stay documented");
  assert.match(renew.description, /heartbeat/i, "renew docs must name it as the heartbeat path");

  const deadBeat = spec.paths["/api/rooms/{roomId}/board/v2/claims/{taskId}/heartbeat"]?.post;
  assert.ok(deadBeat, "board/v2 heartbeat doc entry exists");
  assert.match(deadBeat.description, /retired|410/i, "board/v2 heartbeat docs must warn the route is retired");
  assert.match(deadBeat.description, /work-claims/i, "board/v2 heartbeat docs must point at the work-claims heartbeat");
});
