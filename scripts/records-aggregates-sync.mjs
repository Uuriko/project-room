// records-aggregates-sync: #3618 (R-10/R-12) stored-records tool.
//
// Usage:
//   node scripts/records-aggregates-sync.mjs --db <path-to-room.sqlite> [--room <roomId>] [--as-of <iso>] [--sync]
//
// Without --sync this is strictly read-only (PRAGMA query_only=ON) and
// reports the stored incident records, incident links, and performance
// aggregate records (#3618) if their tables are present.
// With --sync it performs the EXPLICIT RECOMPUTE for R-12: it folds the
// room's bounty_events and work_claim.updated events through the existing
// reputation projector folds (server/records-performance.mjs) and upserts
// the stored aggregate records. Re-running is idempotent — records are
// keyed by deterministic id and replaced, never accumulated.
//
// One honest limitation: incident counts inside the aggregates need the
// linked records themselves (subject/room per record), which this tool
// does not hold — a --sync from here therefore writes incidentCount from
// linkage only when the caller-side refresh (refreshPerformanceAggregates
// with recordsById) has supplied it; API-side refreshes remain the
// authoritative source for incident counts. Rates and counts are always
// recomputed exactly from the event streams.
//
// This script is the reachability entry point for
// server/records-incidents.mjs and server/records-performance.mjs (same
// standing as scripts/claim-reputation-sync.mjs). It runs on demand, not
// from any request path; live cadence wiring stays analytics-lane owned.
//
// Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1
// when the database cannot answer, with the reason on stderr.
import { DatabaseSync } from "node:sqlite";
import { listIncidents, listIncidentLinks } from "../server/records-incidents.mjs";
import { listAggregates, refreshPerformanceAggregates } from "../server/records-performance.mjs";

function parseArgs(argv) {
  let db = null;
  let room = null;
  let asOf = null;
  let sync = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") { db = argv[i + 1] ?? null; i += 1; }
    else if (arg === "--room") { room = argv[i + 1] ?? null; i += 1; }
    else if (arg === "--as-of") { asOf = argv[i + 1] ?? null; i += 1; }
    else if (arg === "--sync") { sync = true; }
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!db) throw new Error("missing required --db <path>");
  if (asOf !== null && !Number.isFinite(Date.parse(asOf))) throw new Error("--as-of must be an ISO timestamp");
  return { db, room, asOfMs: asOf === null ? Date.now() : Date.parse(asOf), sync };
}

const tablePresent = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function loadBountyEventsByRoom(db, room) {
  const byRoom = new Map();
  if (!tablePresent(db, "bounty_events")) return byRoom;
  const rows = db.prepare(
    `SELECT room_id AS roomId, seq, at, type, data FROM bounty_events
     ${room ? "WHERE room_id=?" : ""} ORDER BY room_id, seq`
  ).all(...(room ? [room] : []));
  for (const row of rows) {
    let data = {};
    try { data = JSON.parse(row.data); } catch { continue; }
    if (!byRoom.has(row.roomId)) byRoom.set(row.roomId, []);
    byRoom.get(row.roomId).push({ seq: row.seq, at: row.at, type: row.type, data });
  }
  return byRoom;
}

function loadClaimRows(db, room) {
  if (!tablePresent(db, "events")) return [];
  const rows = db.prepare(
    `SELECT room_id AS roomId, sequence AS seq, body FROM events
     WHERE json_extract(body,'$.type')='work_claim.updated'
     ${room ? "AND room_id=?" : ""} ORDER BY sequence`
  ).all(...(room ? [room] : []));
  const out = [];
  for (const row of rows) {
    try {
      const body = JSON.parse(row.body);
      const atMs = Date.parse(body?.at);
      if (!body?.data || typeof body.data !== "object" || !Number.isFinite(atMs)) continue;
      out.push({ roomId: row.roomId, seq: row.seq, atMs, data: body.data });
    } catch { /* malformed rows carry no fold signal */ }
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`records-aggregates-sync: ${error.message}`);
    process.exit(2);
  }
  let db;
  try {
    db = new DatabaseSync(args.db, { readOnly: !args.sync });
  } catch (error) {
    console.error(`records-aggregates-sync: cannot open db: ${error.message}`);
    process.exit(1);
  }
  try {
    if (!args.sync) db.exec("PRAGMA query_only=ON");
    let syncResult = null;
    if (args.sync) {
      syncResult = refreshPerformanceAggregates(db, {
        bountyEventsByRoom: loadBountyEventsByRoom(db, args.room),
        claimRows: loadClaimRows(db, args.room),
        asOfMs: args.asOfMs,
      });
    }
    const incidentsPresent = tablePresent(db, "incident_records");
    const aggregatesPresent = tablePresent(db, "performance_aggregate_records");
    const incidents = incidentsPresent ? listIncidents(db) : null;
    const links = incidentsPresent ? listIncidentLinks(db, null) : null;
    const aggregates = aggregatesPresent
      ? listAggregates(db).filter(record => !args.room || record.subjectId === args.room || record.subjectKind === "agent")
      : null;
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      db: args.db,
      room: args.room,
      synced: args.sync,
      sync: syncResult ? {
        observations: syncResult.observations,
        incidentsLinked: syncResult.incidentsLinked,
        aggregatesWritten: syncResult.aggregatesWritten,
        asOfMs: syncResult.asOfMs,
      } : null,
      incidentsTablePresent: incidentsPresent,
      aggregatesTablePresent: aggregatesPresent,
      incidents: incidents?.map(incident => ({
        incidentId: incident.incidentId, title: incident.title, status: incident.status,
        severity: incident.severity, selectors: incident.selectors,
      })) ?? null,
      incidentLinkCount: links?.length ?? null,
      aggregates: aggregates?.map(record => ({
        id: record.id, window: record.window, asOfMs: record.asOfMs,
        counts: record.counts, rates: record.rates, incidentCount: record.incidentCount,
      })) ?? null,
      interpretation: "R-12 stored aggregates as refreshed by the explicit recompute; "
        + "rates are acceptanceRate=accepted/(accepted+rejected), reversalRate=reversed/accepted, "
        + "disputeRate=disputed/outcomeTotal, null when a denominator is 0.",
    }, null, 2));
  } catch (error) {
    console.error(`records-aggregates-sync: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
