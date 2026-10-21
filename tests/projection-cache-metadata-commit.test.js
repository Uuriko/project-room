import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createWork } from "../server/work-claims.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-metadata-cache-"));
  const file = join(directory, "room.sqlite");
  // These tests count cold reads; verification mode deliberately adds them.
  const store = new RoomStore(file, { verifyProjectionCache: false });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  let reads = 0;
  const readProjection = store._readProjection.bind(store);
  store._readProjection = (...args) => { reads += 1; return readProjection(...args); };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, file, owner, reads: () => reads };
}

const heartbeat = store => store.agentHeartbeats.heartbeat({
  agentId: "ai_testagent", hostId: "cache-host", mode: "pull-only"
});

for (const operation of ["heartbeat", "cursor", "claim metadata"]) {
  test(`${operation} commit keeps a warm projection warm and equal to cold storage`, t => {
    const f = fixture(t), warm = f.store.room("commons"), before = f.reads();
    if (operation === "heartbeat") f.store.transaction(() => heartbeat(f.store));
    if (operation === "cursor") f.store.markCaughtUp(f.owner, "commons", warm.sequence);
    if (operation === "claim metadata") f.store.transaction(() => f.store.workClaims.set("commons",
      createWork({ id: "cache-side-table", title: "Metadata only" }, { agentId: "owner", now: new Date() })));
    const next = f.store.room("commons");
    assert.equal(f.reads() - before, 0, "metadata commit must not decode the projection");
    assert.equal(next, warm);
    const cold = new RoomStore(f.file, { readOnly: true });
    try { assert.deepEqual(next, cold.room("commons")); }
    finally { cold.close(); }
  });
}

test("an isolated metadata commit preserves the outer transaction's warm projection", t => {
  const f = fixture(t), warm = f.store.room("commons"), before = f.reads();
  f.store.transaction(() => {
    f.store.transaction(() => heartbeat(f.store), { isolated: true });
    assert.equal(f.store.room("commons"), warm);
  });
  assert.equal(f.store.room("commons"), warm);
  assert.equal(f.reads(), before);
});

test("metadata rollback still drops the cache and rolls back its cursor", t => {
  const f = fixture(t), warm = f.store.room("commons"), before = f.reads();
  assert.throws(() => f.store.transaction(() => {
    f.store.markCaughtUp(f.owner, "commons", warm.sequence);
    throw new Error("abort metadata");
  }), /abort metadata/);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM cursors WHERE room_id=?").get("commons").n, 0);
  assert.deepEqual(f.store.room("commons"), warm);
  assert.equal(f.reads(), before + 1, "rollback must retain cold-read invalidation");
});

test("a same-sequence rooms write after metadata still invalidates the warm projection", t => {
  const f = fixture(t), warm = f.store.room("commons");
  f.store.transaction(() => {
    heartbeat(f.store);
    f.store.transaction(() => f.store.db.prepare("UPDATE rooms SET projection=json_set(projection, '$.room.title', ?) WHERE id=?")
      .run("New title", "commons"), { isolated: true });
  });
  const next = f.store.room("commons");
  assert.equal(next.sequence, warm.sequence);
  assert.equal(next.state.room.title, "New title");
  assert.notEqual(next, warm);
});

for (const table of ['"rooms"', "`rooms`", "[rooms]", "'rooms'", "main.rooms", '"main"."rooms"']) {
  test(`same-sequence SQL write to ${table} invalidates before commit`, t => {
    const f = fixture(t), warm = f.store.room("commons");
    f.store.transaction(() => f.store.db.prepare(`UPDATE ${table} SET projection=json_set(projection, '$.room.title', ?) WHERE id=?`)
      .run("Quoted rewrite", "commons"));
    const next = f.store.room("commons");
    assert.equal(next.sequence, warm.sequence);
    assert.equal(next.state.room.title, "Quoted rewrite");
    assert.notEqual(next, warm);
  });
}

test("a rooms write with an OR conflict clause invalidates the warm projection", t => {
  const f = fixture(t), warm = f.store.room("commons");
  f.store.transaction(() => f.store.db.prepare("UPDATE OR ABORT rooms SET projection=json_set(projection, '$.room.title', ?) WHERE id=?")
    .run("Conflict-clause rewrite", "commons"));
  assert.equal(f.store.room("commons").sequence, warm.sequence);
  assert.equal(f.store.room("commons").state.room.title, "Conflict-clause rewrite");
});
