// The wants-work PUT carries the route layer's archived-room freeze for
// this surface: refuseArchived in server/routes/wants-work.mjs. The guard
// must fail closed. A room whose state read throws (a corrupt or
// unresolvable projection) is unknown, not unarchived: on the pre-fix code
// the guard swallowed the throw, treated the room as live, and the write
// landed. These tests drive the real route handler with a stub ctx and a
// real in-memory agent_wants_work table.
//
// Regression: the state-read-throws case returns 200 and writes the row;
// the archived control stops rejecting; or the live control stops writing.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { putOwnWantsWork } from "../server/routes/wants-work.mjs";
import { WANTS_WORK_SCHEMA, readWantsWork } from "../server/work-wants.mjs";

function makeCtx(roomImpl) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY);");
  db.exec(WANTS_WORK_SCHEMA);
  db.prepare("INSERT INTO rooms (id) VALUES ('room1')").run();
  const ctx = {
    params: { roomId: "room1" },
    req: {},
    res: {},
    url: new URL("https://room.test/api/rooms/room1/members/me/wants-work"),
    roomCredentials: () => ({ mode: "session", bearer: false }),
    expectedBinding: () => ({}),
    accountBinding: () => ({}),
    roomAuth: () => ({ kind: "session", credentialHash: "h", member: { id: "mem_agent", kind: "agent" } }),
    reject(status, code, message) {
      const error = new Error(message);
      error.status = status;
      error.code = code;
      throw error;
    },
    rate: () => {},
    protectWrite: () => {},
    body: async () => ({ labels: ["docs"] }),
    json: (_res, status, value) => ({ status, value }),
    store: { room: roomImpl, db, now: () => Date.parse("2026-10-31T00:00:00Z") },
  };
  return { ctx, db };
}

const written = db => readWantsWork(db, "room1", "mem_agent").wantsWork !== null;

test("a room whose state read throws is refused, and nothing is written", async () => {
  const { ctx, db } = makeCtx(() => { throw new Error("corrupt room projection"); });
  await assert.rejects(putOwnWantsWork(ctx), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "room_state_unavailable");
    return true;
  });
  assert.equal(written(db), false);
});

test("an archived room is refused with 409, and nothing is written", async () => {
  const { ctx, db } = makeCtx(() => ({ state: { room: { archivedAt: "2026-10-01T00:00:00Z" } } }));
  await assert.rejects(putOwnWantsWork(ctx), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "room_archived");
    return true;
  });
  assert.equal(written(db), false);
});

test("a live room still accepts the write", async () => {
  const { ctx, db } = makeCtx(() => ({ state: { room: {} } }));
  const out = await putOwnWantsWork(ctx);
  assert.equal(out.status, 200);
  assert.equal(written(db), true);
});
