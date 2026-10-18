// PERF-BUILDS P0-3 — stop clearing the projection cache on commits that
// never wrote rooms. store.transaction() used to clear _projectionCache
// at every outermost commit, so a heartbeat, a cursor advance, or a
// claim-row write evicted every warm room and the next read re-parsed a
// multi-megabyte projection. Now the clear fires only when a rooms
// write happened inside the transaction (rollback still drops the
// cache unconditionally).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

function fixture() {
  // Advancing clock keeps the chat flood guard out of the fixture.
  let clock = 1_760_000_000_000;
  const store = new RoomStore(":memory:", { now: () => (clock += 5_000) });
  let projectionReads = 0;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (/^SELECT\s+projection\b[\s\S]*\bFROM\s+rooms\b/i.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => { projectionReads += 1; return get(...args); };
    }
    return statement;
  };
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < 25; i++) {
    store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: `m${i}`, body: `message ${i}` }));
  }
  return { store, owner, projectionReads: () => projectionReads };
}

// One representative of each non-rooms write family named in the charter:
// heartbeat, cursor, claim writes.
const NON_ROOM_WRITES = [
  ["heartbeat write", store => store.db.prepare(
    "INSERT INTO agent_wake_polls (agent_id, last_polled_at) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_polled_at=excluded.last_polled_at"
  ).run("agent-1", 123)],
  ["cursor write", store => store.db.prepare(
    "INSERT INTO integrity_job_cursor (singleton, step) VALUES (1, 1) ON CONFLICT(singleton) DO UPDATE SET step=step+1"
  ).run()],
  ["claim write", store => store.db.prepare(
    "INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(room_id, claim_id) DO UPDATE SET updated_at=excluded.updated_at"
  ).run("commons", "warm-claim", JSON.stringify({ v: 1, kind: "work-claim", data: { id: "warm-claim", state: "unclaimed" } }), 456)],
  ["claim config write", store => store.db.prepare(
    "INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET updated_at=excluded.updated_at"
  ).run("commons", "{}", 789)]
];

test("non-rooms commits leave a warm room warm, byte-identical to a cold read", async t => {
  for (const [label, write] of NON_ROOM_WRITES) {
    await t.test(label, () => {
      const { store, projectionReads } = fixture();
      try {
        const warm = store.room("commons");
        const readsAfterWarm = projectionReads();
        store.transaction(() => write(store));
        const after = store.room("commons");
        assert.equal(after, warm, `${label}: the cached object itself must survive the commit`);
        assert.equal(projectionReads(), readsAfterWarm, `${label}: no projection re-read may happen`);
        // Cached state equals a cold read, byte for byte: force the
        // cold path and compare the full serialized values.
        store._dropProjectionCache();
        const cold = store.room("commons");
        assert.notEqual(cold, after);
        assert.equal(JSON.stringify(after), JSON.stringify(cold),
          `${label}: cached value must be byte-identical to a cold read`);
        assert.deepEqual(after, cold);
      } finally { store.close(); }
    });
  }
});

test("a rooms-writing commit still evicts (the cache never serves a stale parse)", () => {
  const { store, owner, projectionReads } = fixture();
  try {
    const warm = store.room("commons");
    const readsAfterWarm = projectionReads();
    store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "fresh", body: "fresh after commit" }));
    const after = store.room("commons");
    assert.notEqual(after, warm);
    assert.ok(projectionReads() >= readsAfterWarm, "a rooms write path stays free to re-read");
    assert.equal(after.state.messages.at(-1).body, "fresh after commit");
  } finally { store.close(); }
});

test("a rolled-back transaction still drops the cache (rollback path unchanged)", () => {
  const { store, projectionReads } = fixture();
  try {
    const warm = store.room("commons");
    const readsAfterWarm = projectionReads();
    assert.throws(() => store.transaction(() => {
      store.db.prepare("INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES (?, ?, ?)").run("commons", "{}", 1);
      throw new Error("boom");
    }), /boom/);
    const after = store.room("commons");
    assert.notEqual(after, warm, "rollback must not keep serving the pre-transaction cache entry");
    assert.ok(projectionReads() > readsAfterWarm, "the post-rollback read must re-read the projection");
    assert.deepEqual(JSON.parse(JSON.stringify(after.state)), JSON.parse(JSON.stringify(warm.state)),
      "values are unchanged by the rolled-back write — only the cache entry was dropped");
  } finally { store.close(); }
});
