// Follow-up to #2089/#2095: the pre-migration fail-close must absorb only
// "no such table". A busy, locked or I/O error used to read as "agent
// unregistered" / "not wakeable" and hide a real database fault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentHeartbeats, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;

function lockedDb(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  db.prepare(`INSERT INTO agent_hosts
    (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run("ai_real", "h", "wakeable", null, T0, T0, T0);
  t.after(() => db.close());
  const locked = { prepare() { throw new Error("database is locked"); }, exec() { throw new Error("database is locked"); } };
  return { hb: new AgentHeartbeats({ db: locked, now: () => T0 }) };
}

test("a locked database surfaces from the wake-status reads instead of reading as not wakeable", t => {
  const { hb } = lockedDb(t);
  assert.throws(() => hb.wakeStatusOf("ai_real"), /database is locked/);
  assert.throws(() => hb.wakeStatusList(), /database is locked/);
});

test("a locked database surfaces from statusOf and notePoll instead of reading as unregistered", t => {
  const { hb } = lockedDb(t);
  assert.throws(() => hb.statusOf("ai_real"), /database is locked/);
  assert.throws(() => hb.notePoll({ agentId: "ai_real" }), /database is locked/);
});

test("a missing table still reads as unregistered and not wakeable", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  assert.equal(hb.statusOf("ai_real").status, "unregistered");
  assert.equal(hb.notePoll({ agentId: "ai_real" }).registered, false);
  assert.equal(hb.wakeStatusOf("ai_real").wakeable, false);
  assert.deepEqual(hb.wakeStatusList().wakeable, []);
});
