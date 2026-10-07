// Quarterly restore drill (task 168): prove the documented disaster-recovery
// path (docs/BACKUPS.md: NDJSON export -> scripts/replay-room-export.mjs)
// restores a lost room, and MEASURE the RTO.
//
// Usage: node scripts/restore-drill.mjs [--messages N] [--json]
// Exits 0 with a drill report on stdout; exits 1 if any phase fails.
// Everything runs against disposable temp directories - never production.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";

const { values } = parseArgs({ options: {
  messages: { type: "string", default: "200" },
  json: { type: "boolean", default: false },
} });
const N = Math.max(1, parseInt(values.messages, 10) || 200);

const scratch = mkdtempSync(join(tmpdir(), "restore-drill-"));
const phases = {};
const mark = (name, ms) => { phases[name] = ms; };
const t0 = Date.now();
const elapsed = () => Date.now() - t0;

let report;
try {
  // Phase 1: seed a disposable room with history, members, and a work claim.
  let p = Date.now();
  const liveFile = join(scratch, "live.sqlite");
  const store = new RoomStore(liveFile);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const send = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  // Spread posts across members: the flood guard allows a 30-burst per
  // (room, member), so a single member cannot seed a large room.
  const WRITERS = 8;
  const writerKeys = [];
  for (let w = 0; w < WRITERS; w++) {
    const memberId = `drill-agent-${w}`;
    send(T.MEMBER_ADDED, { memberId, displayName: `Drill agent ${w}`, kind: "agent", permissions: ["accept_work", "complete_work"] });
    writerKeys.push(store.issueAccessKey("commons", memberId));
  }
  const postAs = (key, body) => store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body } });
  for (let i = 0; i < N; i++) {
    postAs(writerKeys[i % WRITERS], `drill message ${i}`);
  }
  const seqBefore = store.room("commons").sequence;
  const eventsBefore = store.db.prepare("SELECT count(*) AS n FROM events").get().n;
  mark("seed_ms", Date.now() - p);

  // Phase 2: take the export (stands in for the daily R2 object).
  p = Date.now();
  const ndjson = exportNdjsonText(store.db);
  const exportFile = join(scratch, "room-export.ndjson");
  writeFileSync(exportFile, ndjson, { mode: 0o600 });
  mark("export_ms", Date.now() - p);
  store.close();

  // Phase 3: DISASTER. The live database is gone.
  p = Date.now();
  rmSync(liveFile);
  const disasterAt = elapsed();
  mark("disaster_declared_at_ms", disasterAt);

  // Phase 4: restore from the export into a fresh file.
  const restoredFile = join(scratch, "restored.sqlite");
  const result = replayNdjson(readFileSync(exportFile, "utf8"), restoredFile);
  mark("replay_ms", Date.now() - p);

  // Phase 5: verify the restored room serves reads and writes.
  p = Date.now();
  const restored = new RoomStore(restoredFile);
  try {
    const seqAfter = restored.room("commons").sequence;
    if (seqAfter !== seqBefore) throw new Error(`sequence mismatch: ${seqAfter} != ${seqBefore}`);
    const eventsAfter = restored.db.prepare("SELECT count(*) AS n FROM events").get().n;
    if (eventsAfter !== eventsBefore) throw new Error(`event count mismatch: ${eventsAfter} != ${eventsBefore}`);
    const bodies = restored.room("commons").state.messages.map(m => m.body).join("\n");
    if (!bodies.includes("drill message 0") || !bodies.includes(`drill message ${N - 1}`)) {
      throw new Error("restored history is missing drill messages");
    }
    // The restored room accepts writes: it is serving again.
    const key2 = restored.issueAccessKey("commons", "owner");
    restored.command(key2, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body: "first message after restore" } });
    if (restored.room("commons").sequence !== seqBefore + 1) throw new Error("post-restore write did not commit");
  } finally {
    restored.close();
  }
  mark("verify_ms", Date.now() - p);

  const rtoMs = elapsed() - disasterAt;
  report = {
    ok: true,
    drill: "quarterly-restore",
    date: new Date().toISOString(),
    messages: N,
    sequence: seqBefore,
    events: eventsBefore,
    replay: { verified: result.verified, events: result.events },
    rto_ms: rtoMs,
    rto_human: `${(rtoMs / 1000).toFixed(1)}s`,
    phases,
  };
} catch (err) {
  report = { ok: false, drill: "quarterly-restore", date: new Date().toISOString(), error: err?.message ?? String(err), phases };
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`restore drill: ${report.ok ? "OK" : "FAILED"}`);
  console.log(`  messages: ${report.messages}, sequence: ${report.sequence}, events: ${report.events}`);
  if (report.ok) {
    console.log(`  RTO (disaster declared -> serving again): ${report.rto_human}`);
    for (const [k, v] of Object.entries(report.phases)) console.log(`  ${k}: ${v}ms`);
  } else console.log(`  error: ${report.error}`);
}
process.exitCode = report.ok ? 0 : 1;
