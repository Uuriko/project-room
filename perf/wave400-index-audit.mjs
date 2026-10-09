// WAVE-400 perf worker: index audit over hot queries (wave400/perf-index-audit-r2).
// Drives a REAL RoomStore (new RoomStore + initialize), populates a realistic
// database (10k events, 500 work claims, 2000 mention rows, 1000 webhook
// deliveries), then runs EXPLAIN QUERY PLAN + timed runs over the hot queries:
//   - eventsAfter page query (store.mjs eventsAfter, runs per SSE pump)
//   - budgeted message replay counter (messages-store.mjs fillRoom)
//   - flipExpiredMentions guard (runs inside eventsAfter, per SSE pump)
//   - work_claims board page (selectRoom) + single-claim fetch (selectOne)
//   - webhook delivery due-row SELECT (drainWebhookDeliveries)
//   - workItemHistory type/workItem scan (events read on work-item views)
//
// Usage: TMPDIR=<worktree>/.tmp node perf/wave400-index-audit.mjs before|after
// In "after" mode the candidate index under test is created before timing.
// No network, no sends, no credentials.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const PHASE = process.argv[2] === "after" ? "after" : "before";
const WORKDIR = process.env.TMPDIR ?? join(process.cwd(), ".tmp");
const DIR = mkdtempSync(join(WORKDIR, "index-audit-"));
const ROOM = "perfroom";
const OTHER = "otherroom";

const store = new RoomStore(join(DIR, "room.sqlite"));
store.initialize(initialRoom(ROOM, "owner"));
const db = store.db;

const TYPES = ["message.posted", "message.posted", "message.posted", "message.posted",
  "work.claim_updated", "member.added", "room.renamed", "message.posted"];
{
  const insert = db.prepare("INSERT INTO events(room_id,sequence,id,body) VALUES(?,?,?,?)");
  const iso = i => new Date(1700000000000 + i * 1000).toISOString();
  const maxSeq = db.prepare("SELECT COALESCE(MAX(sequence),0) AS m FROM events WHERE room_id=?").get(ROOM).m;
  db.prepare("INSERT INTO rooms(id,sequence,projection,archived_at) VALUES(?,?,?,NULL)")
    .run(OTHER, 0, JSON.stringify({ room: { id: OTHER } }));
  db.exec("BEGIN");
  let seq = maxSeq + 1;
  for (let i = 0; i < 10000; i++, seq++) {
    const type = TYPES[i % TYPES.length];
    const body = JSON.stringify({
      id: `evt-${i}`, type, actorId: `member-${i % 50}`, at: iso(i),
      data: { workItemId: i % 20 === 0 ? `work-${i % 25}` : undefined },
    });
    insert.run(ROOM, seq, `evt-${i}`, body);
  }
  let oseq = 1;
  for (let i = 0; i < 500; i++, oseq++) {
    insert.run(OTHER, oseq, `oevt-${i}`,
      JSON.stringify({ id: `oevt-${i}`, type: "message.posted", actorId: "member-1", at: iso(i), data: {} }));
  }
  db.exec("COMMIT");
}

{
  // mention_states: 2000 rows; 1900 terminal (responded), 100 live (delivered/acknowledged).
  const insert = db.prepare(`INSERT INTO mention_states(room_id,message_event_id,mentioned_member_id,state,created_at,timeout_at,decided_at)
    VALUES(?,?,?,?,?,?,?)`);
  db.exec("BEGIN");
  for (let i = 0; i < 2000; i++) {
    const live = i < 100;
    insert.run(ROOM, `evt-${i}`, `member-${i % 50}`,
      live ? (i % 2 === 0 ? "delivered" : "acknowledged") : "responded",
      1700000000000, live ? Date.now() + 3600e3 : 1700000000000 + i, live ? null : 1700000001000);
  }
  db.exec("COMMIT");
}

{
  // work_claims: 500 rows across two rooms (plain JSON items; decode parity is not under test).
  const insert = db.prepare("INSERT INTO work_claims(room_id,claim_id,item_json,updated_at) VALUES(?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 500; i++) {
    const roomId = i % 2 === 0 ? ROOM : OTHER;
    insert.run(roomId, `claim-${i}`,
      JSON.stringify({ id: `claim-${i}`, title: `Claim ${i}`, state: "claimed", owner: "member-1", leaseExpiresAt: new Date(Date.now() + 3600e3).toISOString() }),
      Date.now());
  }
  db.exec("COMMIT");
}

{
  // agent_webhook_deliveries: 1000 rows; 900 delivered, 100 live but not due.
  const insert = db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id,idempotency_key,subscription_id,agent_id,room_id,event_type,payload_json,signature,state,attempts,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const sub = db.prepare(`INSERT INTO agent_webhook_subs(subscription_id,agent_id,url,events_json,secret,enabled,created_at)
    VALUES(?,?,?,?,?,?,?)`);
  db.exec("BEGIN");
  sub.run("sub-1", "agent-1", "https://example.com/hook", "[]", "secret", 1, Date.now());
  for (let i = 0; i < 1000; i++) {
    const live = i < 100;
    insert.run(`dlv-${i}`, `idem-${i}`, "sub-1", "agent-1", ROOM, "message.posted", '{"data":{}}', "sig",
      live ? (i % 2 === 0 ? "pending" : "failed") : "delivered", live ? 1 : 3,
      live ? Date.now() + 3600e3 : Date.now() - 1000, Date.now() - 1000, Date.now());
  }
  db.exec("COMMIT");
}

const QUERIES = {
  "Q1 eventsAfter page": {
    sql: `SELECT sequence,body FROM events WHERE room_id=? AND sequence>?
          AND (? IS NULL OR json_extract(body,'$.actorId')=?)
          AND (? IS NULL OR json_extract(body,'$.at')>=?)
          AND (? IS NULL OR json_extract(body,'$.at')<=?)
          ORDER BY sequence LIMIT ?`,
    args: [ROOM, 9000, null, null, null, null, null, null, 100],
  },
  "Q2 budget replay page": {
    sql: `SELECT sequence, id, body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
    args: [ROOM, 5000, 1000],
  },
  "Q3 flipExpiredMentions guard": {
    sql: `SELECT 1 FROM mention_states WHERE room_id=? AND state IN ('delivered','acknowledged') AND timeout_at<=? LIMIT 1`,
    args: [ROOM, Date.now()],
  },
  "Q4 claims board page": {
    sql: `SELECT item_json FROM work_claims WHERE room_id=? ORDER BY rowid ASC`,
    args: [ROOM],
  },
  "Q5 single claim fetch": {
    sql: `SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?`,
    args: [ROOM, "claim-250"],
  },
  "Q6 lease sweep room list": {
    sql: `SELECT item_json FROM work_claims WHERE room_id=? ORDER BY rowid ASC`,
    args: [ROOM],
  },
  "Q7 webhook due-row drain": {
    sql: `SELECT * FROM agent_webhook_deliveries WHERE state IN ('pending','failed') AND next_attempt_at <= ?
          ORDER BY next_attempt_at ASC LIMIT 25`,
    args: [Date.now()],
  },
  "Q8 workItemHistory scan": {
    sql: `SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence`,
    args: [ROOM, "work-5"],
  },
  "Q9 mention lookup by event": {
    sql: `SELECT 1 FROM mention_states WHERE room_id=? AND message_event_id=?`,
    args: [ROOM, "evt-42"],
  },
};

if (PHASE === "after") {
  // CANDIDATE INDEX UNDER TEST: expression index so workItemHistory stops
  // scanning every event row of the room to find one work item's revisions.
  db.exec(`CREATE INDEX IF NOT EXISTS events_workitem_id
    ON events(room_id, json_extract(body, '$.data.workItemId'), sequence)`);
}

const plans = {};
for (const [name, { sql }] of Object.entries(QUERIES)) {
  plans[name] = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => r.detail).join(" | ");
}

const timings = {};
for (const [name, { sql, args }] of Object.entries(QUERIES)) {
  const stmt = db.prepare(sql);
  stmt.all(...args); // warm
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    stmt.all(...args);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  timings[name] = { medianMs: samples[100], p95Ms: samples[190] };
}

console.log(JSON.stringify({ phase: PHASE, plans, timings }, null, 2));
store.close();
rmSync(DIR, { recursive: true, force: true });
