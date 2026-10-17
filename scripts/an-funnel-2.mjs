// AN-FUNNEL-2: the activation loop funnel, read-only.
//
// Usage: node scripts/an-funnel-2.mjs --db <path-to-room.sqlite> [--since <iso-date>]
//
// Opens the database read-only (PRAGMA query_only=ON) and reports the
// activation loop funnel (entered -> directed/claimed -> reviewed ->
// accepted -> receipt held; activation = first-receipt-held) using ONLY
// already-recorded data: room events, member_accounts bindings, accounts,
// the work-claims registry history of public tasks, public_work_receipts
// and public_work_reviews state. No new event types, no schema changes,
// no writes of any kind. Contents of submissions and reviews are never
// read — only ids, actors, actions, verdicts and timestamps.
//
// Exit 0 with a JSON report on stdout. Exit 2 on bad arguments, exit 1 when
// the database cannot answer (missing core tables), with the reason on
// stderr. Missing PUBLIC-WORK tables degrade to coverage notes, not failure:
// a store that never enabled public work still has a board funnel.
import { DatabaseSync } from "node:sqlite";
import { LOOP_FUNNEL_DEFINITIONS, loopFunnel } from "../server/analytics/loop-funnel.mjs";

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

function parseTime(value) {
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function loadRows(db, path) {
  const missing = [];
  for (const name of ["events", "member_accounts", "accounts", "analytics_events"]) {
    if (!tableExists(db, name)) missing.push(name);
  }
  if (missing.length) {
    throw new Error(`cannot build funnel: missing tables: ${missing.join(", ")}`);
  }
  const coverage = { droppedUnparseableAt: 0, publicWork: "absent", publicHistoryOmitted: 0 };

  const memberRows = db.prepare(
    `SELECT room_id AS roomId,
            COALESCE(json_extract(body,'$.data.memberId'), json_extract(body,'$.actorId')) AS memberId,
            json_extract(body,'$.data.kind') AS kind,
            json_extract(body,'$.type') AS type,
            json_extract(body,'$.at') AS atRaw
     FROM events WHERE json_extract(body,'$.type') IN ('member.added','member.joined_via_invitation')`
  ).all();
  const members = [];
  for (const row of memberRows) {
    const at = parseTime(row.atRaw);
    if (at == null || typeof row.memberId !== "string") { coverage.droppedUnparseableAt += 1; continue; }
    members.push({
      roomId: row.roomId,
      memberId: row.memberId,
      kind: row.kind === "agent" || row.kind === "human" ? row.kind : row.type === "member.joined_via_invitation" ? "human" : null,
      at
    });
  }

  const signups = db.prepare(
    `SELECT account_id AS accountId, MIN(at) AS at FROM analytics_events
     WHERE name='signup' AND account_id IS NOT NULL GROUP BY account_id`
  ).all().map(row => ({ accountId: row.accountId, at: row.at }));

  const memberships = db.prepare(
    `SELECT room_id AS roomId, member_id AS memberId, account_id AS accountId FROM member_accounts`
  ).all();

  const claimRows = db.prepare(
    `SELECT room_id AS roomId,
            json_extract(body,'$.data.workClaim') AS claimId,
            json_extract(body,'$.actorId') AS actorId,
            json_extract(body,'$.data.action') AS action,
            json_extract(body,'$.data.claimState') AS claimState,
            json_extract(body,'$.data.verdict') AS verdict,
            json_extract(body,'$.data.ownerId') AS ownerId,
            json_extract(body,'$.at') AS atRaw
     FROM events WHERE json_extract(body,'$.type')='work_claim.updated'`
  ).all();
  const claimEvents = [];
  for (const row of claimRows) {
    const at = parseTime(row.atRaw);
    if (at == null || typeof row.claimId !== "string" || typeof row.action !== "string") { coverage.droppedUnparseableAt += 1; continue; }
    claimEvents.push({
      roomId: row.roomId, claimId: row.claimId, actorId: row.actorId, action: row.action,
      claimState: row.claimState, verdict: row.verdict, ownerId: row.ownerId, at
    });
  }

  // Public work: tasks + registry history + receipts + review state.
  const publicTasks = [];
  if (tableExists(db, "public_work_tasks")) {
    coverage.publicWork = "present";
    const receiptsByTask = new Map();
    if (tableExists(db, "public_work_receipts")) {
      for (const row of db.prepare(`SELECT receipt_id AS receiptId, offer_id AS taskId, identity_id AS identityId, created_at AS at FROM public_work_receipts`).all()) {
        receiptsByTask.set(row.taskId, { receiptId: row.receiptId, identityId: row.identityId, at: row.at });
      }
    }
    const reviewsByReceipt = new Map();
    if (tableExists(db, "public_work_reviews")) {
      for (const row of db.prepare(`SELECT receipt_id AS receiptId, state_json AS stateJson FROM public_work_reviews`).all()) {
        try {
          const state = JSON.parse(row.stateJson);
          reviewsByReceipt.set(row.receiptId, {
            verification: state?.verification
              ? { actorId: state.verification.actorId ?? null, at: parseTime(state.verification.at), verdict: state.verification.verdict ?? null }
              : null,
            decision: state?.decision
              ? { actorId: state.decision.actorId ?? null, at: parseTime(state.decision.at), decision: state.decision.decision ?? null }
              : null
          });
        } catch { /* an unparseable review state contributes no stages */ }
      }
    }
    const taskRows = db.prepare(`SELECT offer_id AS taskId, namespace_key AS namespaceId, room_id AS roomId, created_at AS createdAt FROM public_work_tasks`).all();
    for (const task of taskRows) {
      let history = [];
      if (tableExists(db, "work_claims")) {
        const itemRow = db.prepare(`SELECT item_json AS itemJson FROM work_claims WHERE room_id=? AND claim_id=?`).get(task.namespaceId, task.taskId);
        if (itemRow) {
          try {
            const item = JSON.parse(itemRow.itemJson);
            if (Number.isSafeInteger(item?.historyOmitted) && item.historyOmitted > 0) coverage.publicHistoryOmitted += 1;
            if (Array.isArray(item?.history)) {
              history = item.history
                .map(entry => ({ at: parseTime(entry?.at), actorId: entry?.agentId ?? null, action: entry?.action ?? null }))
                .filter(entry => entry.at != null && typeof entry.action === "string");
            }
          } catch { /* an unparseable registry item contributes no history */ }
        }
      }
      const receipt = receiptsByTask.get(task.taskId) ?? null;
      const review = receipt ? reviewsByReceipt.get(receipt.receiptId) ?? null : null;
      publicTasks.push({
        taskId: task.taskId, namespaceId: task.namespaceId, roomId: task.roomId, createdAt: task.createdAt,
        history, receipt,
        verification: review?.verification ?? null,
        decision: review?.decision ?? null
      });
    }
  }

  const identityLinks = tableExists(db, "identity_links")
    ? db.prepare(`SELECT room_id AS roomId, member_id AS memberId, identity_id AS identityId FROM identity_links`).all()
    : [];

  return { members, signups, memberships, claimEvents, publicTasks, identityLinks, coverage, dbPath: path };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`an-funnel-2: ${error.message}`);
    process.exit(2);
  }
  let db;
  try {
    db = new DatabaseSync(args.db, { readOnly: true });
  } catch (error) {
    console.error(`an-funnel-2: cannot open db: ${error.message}`);
    process.exit(1);
  }
  try {
    db.exec("PRAGMA query_only=ON");
    const rows = loadRows(db, args.db);
    const since = args.sinceMs;
    const members = since == null ? rows.members : rows.members.filter(row => row.at >= since);
    const claimEvents = since == null ? rows.claimEvents : rows.claimEvents.filter(row => row.at >= since);
    const publicTasks = since == null ? rows.publicTasks : rows.publicTasks.filter(task => task.createdAt >= since);
    const { actors, summary } = loopFunnel({
      members,
      signups: rows.signups,
      memberships: rows.memberships,
      claimEvents,
      publicTasks,
      identityLinks: rows.identityLinks
    });
    const report = {
      generatedAt: new Date().toISOString(),
      db: rows.dbPath,
      definitions: LOOP_FUNNEL_DEFINITIONS,
      coverage: {
        ...rows.coverage,
        cohortSince: since == null ? null : new Date(since).toISOString(),
        memberEntries: rows.members.length,
        claimEvents: rows.claimEvents.length,
        publicTasks: rows.publicTasks.length,
        sawBoard: "unmeasured — no surface records a board view; see definitions.sawBoard",
        note: summary.actors === 0
          ? "No actors in scope. The funnel reads recorded room events and public-work tables; a store with no member entries yet has no funnel to report."
          : "Cohort = actors with a recorded entry (member event, signup, or first public-board action)."
      },
      summary,
      actors
    };
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`an-funnel-2: ${error.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
