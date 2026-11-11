// T2-L10b-C1: the web-research daily quota was check-then-journal across
// awaits — checkRateLimits counted journal rows at the start of
// research(), and the journal row was written only at the end, after the
// awaited fetch/provider legs. Concurrent calls all passed the check
// against the same count: seeded at 49/50 executed rows, 5 concurrent
// research() calls all fulfilled and the journal ended at 54 > 50.
// The fix mirrors the sibling WebFetch quota reservation (#2963):
// check + journal the reservation in ONE store transaction before the
// first await, then settle the reservation's evidence_count at the end.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  WebResearch,
  webResearchSchema,
  WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY,
} from "../server/web-research.mjs";

// Fake store in the repo's web-research test-fixture pattern (real SQLite
// DB + stub webFetch with latency + controllable clock), plus the
// transaction runner the real RoomStore provides (SAVEPOINT discipline,
// same shape as the escrow test harness).
function makeService({ latencyMs = 60 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(webResearchSchema);
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY)`);
  db.prepare("INSERT OR IGNORE INTO rooms(id) VALUES('room1')").run();
  let now = 1_000_000;
  const transaction = fn => {
    db.exec("SAVEPOINT research_test");
    try { const out = fn(); db.exec("RELEASE research_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO research_test"); db.exec("RELEASE research_test"); throw error; }
  };
  const webFetch = {
    fetch: async () => {
      await new Promise(resolve => setTimeout(resolve, latencyMs));
      return {
        url: "https://example.com/ok",
        markdown: { requested: true, data: "lease body about quotas" },
        highlights: { requested: true, data: ["[T] body about quotas"] },
        metadata: { title: "T" },
        cache_metadata: { status: "miss", age_ms: 0 },
        request_id: "req-1",
      };
    },
  };
  const store = { db, now: () => now, webFetch, transaction, readTransaction: transaction };
  const service = new WebResearch(store, {});
  return { db, service, now: () => now };
}

const seedExecuted = (db, roomId, memberId, count, at) => {
  const insert = db.prepare(`INSERT INTO web_research_log(request_id, room_id, member_id, credential_hash, question_hash, sources_json, evidence_count, plan_only, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < count; i++) insert.run(`${roomId}-${memberId}-seed-${i}`, roomId, memberId, null, "q", "[]", 0, 0, at);
};
const executedRows = (db, roomId, memberId) => db.prepare(
  "SELECT COUNT(*) AS n FROM web_research_log WHERE room_id=? AND member_id=? AND plan_only=0").get(roomId, memberId).n;
const executedRowsRoom = (db, roomId) => db.prepare(
  "SELECT COUNT(*) AS n FROM web_research_log WHERE room_id=? AND plan_only=0").get(roomId).n;

const call = service => service.research("room1", "m1",
  { question: "quotas", sources: ["fetch"], urls: ["https://example.com/ok"] });

test("T2-L10b-C1: concurrent calls at 49/50 cannot overshoot the member quota", async () => {
  const { db, service, now } = makeService();
  seedExecuted(db, "room1", "m1", WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY - 1, now() - 1000);
  const settled = await Promise.allSettled([call(service), call(service), call(service), call(service), call(service)]);
  const fulfilled = settled.filter(s => s.status === "fulfilled");
  const rejected = settled.filter(s => s.status === "rejected");
  assert.equal(fulfilled.length, 1, `expected exactly 1 fulfilled, got ${fulfilled.length} (${settled.map(s => s.status).join(",")})`);
  assert.equal(rejected.length, 4);
  for (const r of rejected) assert.equal(r.reason.code, "rate_limited", `expected rate_limited, got ${r.reason.code}: ${r.reason.message}`);
  assert.equal(executedRows(db, "room1", "m1"), WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY);
});

test("T2-L10b-C1: concurrent calls at 499/500 cannot overshoot the room quota", async () => {
  const { db, service, now } = makeService();
  seedExecuted(db, "room1", "someone-else", 499, now() - 1000);
  const settled = await Promise.allSettled([call(service), call(service), call(service), call(service), call(service)]);
  const fulfilled = settled.filter(s => s.status === "fulfilled");
  assert.equal(fulfilled.length, 1, `expected exactly 1 fulfilled, got ${fulfilled.length}`);
  assert.equal(executedRowsRoom(db, "room1"), 500);
  assert.equal(executedRows(db, "room1", "m1"), 1);
});

test("T2-L10b-C1: a rate-limited refusal leaves no journal row (reservation rolls back)", async () => {
  const { db, service, now } = makeService();
  seedExecuted(db, "room1", "m1", WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY, now() - 1000);
  await assert.rejects(() => call(service), error => error.code === "rate_limited" && error.status === 429);
  assert.equal(executedRows(db, "room1", "m1"), WEB_RESEARCH_RATE_PER_MEMBER_PER_DAY);
});

test("T2-L10b-C1: the reservation settles to the real evidence count (no double journal)", async () => {
  const { db, service } = makeService();
  const res = await call(service);
  assert.equal(res.evidence.length, 1);
  assert.equal(executedRows(db, "room1", "m1"), 1);
  const row = db.prepare("SELECT evidence_count FROM web_research_log WHERE request_id=?").get(res.request_id);
  assert.equal(row.evidence_count, 1);
});
