// Measures the RoomStore constructor's cold-start work (schema verification,
// projection provenance repair, invitation audit and work-help history audit)
// against a database holding N audit events, using the real server modules.
// It does not change store behaviour; it only reports milliseconds.
//
// Usage: node scripts/measure-cold-start.mjs [events=10000] [runs=5] [--help-history]
//   events         total rows in the events table (the pilot cap is 10000)
//   runs           how many cold constructions to time after the build
//   --help-history also opens one help invitation so auditWorkHelp replays
//                  every event instead of taking its no-help fast path
//
// Node's node:sqlite file database is the closest local stand-in for the
// Durable Object SQLite adapter; workerd CPU accounting will differ, so treat
// these numbers as a lower bound for the hosted cold start, not a certificate.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const [eventsArg, runsArg] = args.filter(a => !a.startsWith("--"));
const TARGET = Math.min(Number(eventsArg ?? 10000), 10000);
const RUNS = Number(runsArg ?? 5);
const HELP_HISTORY = flags.has("--help-history");
if (!Number.isInteger(TARGET) || TARGET < 2 || !Number.isInteger(RUNS) || RUNS < 1) {
  console.error("Usage: node scripts/measure-cold-start.mjs [events<=10000] [runs>=1] [--help-history]");
  process.exit(2);
}

const directory = mkdtempSync(join(tmpdir(), "room-cold-start-"));
const file = join(directory, "room.sqlite");
const ms = value => Math.round(value * 100) / 100;
try {
  const buildStart = performance.now();
  const store = new RoomStore(file);
  store.initialize(initialRoom()); // room.created + member.added
  const ownerKey = store.issueAccessKey("commons", "owner");
  if (HELP_HISTORY) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
      workItemId: "cold-start-work", title: "Cold-start measurement", definitionOfDone: "Never completed; exists so the help audit replays history",
      accountableMemberId: "owner", mode: "read" } });
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_ACCEPTED, data: { workItemId: "cold-start-work", expectedRevision: 0 } });
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_HELP_UPDATED, data: {
      workItemId: "cold-start-work", expectedRevision: 1, expectedHelpRevision: 0, status: "open",
      scope: "Synthetic help invitation for measurement only", expiresAt: new Date(Date.now() + 3600000).toISOString() } });
  }
  let sequence = store.room("commons").sequence;
  // One transaction for the whole fill: this measures startup, not insert speed.
  store.transaction(() => {
    for (; sequence < TARGET; sequence++) {
      store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
        data: { messageId: randomUUID(), body: `Synthetic audit event ${sequence + 1} for the cold-start measurement` } });
    }
  });
  const events = store.db.prepare("SELECT count(*) n FROM events").get().n;
  store.close();
  const buildMs = performance.now() - buildStart;

  const samples = [];
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    const cold = new RoomStore(file); // constructor = the Durable Object cold-start path
    samples.push(performance.now() - start);
    cold.close();
  }
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(JSON.stringify({
    node: process.version, events, helpHistory: HELP_HISTORY, runs: RUNS, buildMs: ms(buildMs),
    constructorMs: { min: ms(sorted[0]), median: ms(sorted[Math.floor(sorted.length / 2)]), max: ms(sorted[sorted.length - 1]), samples: samples.map(ms) },
    note: "Node node:sqlite file database; workerd CPU accounting differs. Wall-clock, not CPU-time."
  }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true }); }
