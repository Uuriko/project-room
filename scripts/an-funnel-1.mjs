// AN-FUNNEL-1: signup -> first message -> first reply, read-only.
//
// Usage: node scripts/an-funnel-1.mjs --db <path-to-room.sqlite> [--since <iso-date>]
//
// Opens the database read-only (PRAGMA query_only=ON) and reports the
// activation funnel using ONLY already-recorded data: analytics_events
// signup rows, member_accounts bindings, and message.posted room events.
// No new event types, no schema changes, no writes of any kind.
//
// Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1 when
// the database cannot answer (missing tables), with the reason on stderr.
import { DatabaseSync } from "node:sqlite";
import { ACTIVATION_FUNNEL_DEFINITIONS, activationFunnel } from "../server/analytics/activation-funnel.mjs";

function parseArgs(argv) {
  let db = null;
  let since = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") { db = argv[i + 1] ?? null; i += 1; }
    else if (arg === "--since") { since = argv[i + 1] ?? null; i += 1; }
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!db) throw new Error("missing required --db <path>");
  let sinceMs = null;
  if (since) {
    sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs)) throw new Error(`unparseable --since ${since}`);
  }
  return { db, sinceMs };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function loadRows(db, path) {
  const missing = [];
  for (const name of ["analytics_events", "member_accounts", "events"]) {
    if (!tableExists(db, name)) missing.push(name);
  }
  if (missing.length) {
    throw new Error(`cannot build funnel: missing tables: ${missing.join(", ")}`);
  }
  const signupRows = db.prepare(
    `SELECT account_id AS accountId, MIN(at) AS at FROM analytics_events
     WHERE name='signup' AND account_id IS NOT NULL GROUP BY account_id`
  ).all();
  const memberships = db.prepare(
    `SELECT room_id AS roomId, member_id AS memberId, account_id AS accountId FROM member_accounts`
  ).all();
  const messageRows = db.prepare(
    `SELECT room_id AS roomId, json_extract(body,'$.actorId') AS authorId,
            json_extract(body,'$.at') AS atRaw
     FROM events WHERE json_extract(body,'$.type')='message.posted'`
  ).all();
  const messages = [];
  let droppedUnparseable = 0;
  for (const row of messageRows) {
    const at = Date.parse(row.atRaw);
    if (!Number.isFinite(at)) {
      droppedUnparseable += 1;
      continue;
    }
    messages.push({ roomId: row.roomId, authorId: row.authorId, at });
  }
  const kindRows = db.prepare(
    `SELECT json_extract(body,'$.data.memberId') AS memberId,
            json_extract(body,'$.data.kind') AS kind,
            MIN(sequence) AS seq
     FROM events WHERE json_extract(body,'$.type')='member.added'
     GROUP BY json_extract(body,'$.data.memberId')`
  ).all();
  const memberKinds = {};
  for (const row of kindRows) {
    if (typeof row.memberId === "string" && (row.kind === "agent" || row.kind === "human")) {
      memberKinds[row.memberId] = row.kind;
    }
  }
  return { signupRows, memberships, messages, memberKinds, droppedUnparseable, dbPath: path };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`an-funnel-1: ${error.message}`);
    process.exit(2);
  }
  let db;
  try {
    db = new DatabaseSync(args.db, { readOnly: true });
  } catch (error) {
    console.error(`an-funnel-1: cannot open db: ${error.message}`);
    process.exit(1);
  }
  try {
    db.exec("PRAGMA query_only=ON");
    const rows = loadRows(db, args.db);
    const signups = args.sinceMs == null
      ? rows.signupRows
      : rows.signupRows.filter(row => row.at >= args.sinceMs);
    const { accounts, summary } = activationFunnel({
      signups,
      memberships: rows.memberships,
      messages: rows.messages,
      memberKinds: rows.memberKinds
    });
    const report = {
      generatedAt: new Date().toISOString(),
      db: rows.dbPath,
      definitions: ACTIVATION_FUNNEL_DEFINITIONS,
      coverage: {
        signupRows: rows.signupRows.length,
        cohortSince: args.sinceMs == null ? null : new Date(args.sinceMs).toISOString(),
        cohortAccounts: signups.length,
        memberBindings: rows.memberships.length,
        messageRows: rows.messages.length,
        droppedUnparseableMessageAt: rows.droppedUnparseable,
        note: signups.length === 0
          ? "No signup rows in analytics_events. The analytics tail derives these from the accounts table; run the tail (or backfill) before measuring the funnel."
          : "Cohort = accounts with at least one analytics_events signup row."
      },
      summary,
      accounts
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`an-funnel-1: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
