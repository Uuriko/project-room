// Diagnostic projection only. Ownership and replay remain in request_runs.
// No prompts, credentials or results belong in this table.
import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
const stages = ["requested", "noticed", "accepted", "started", "finished", "delivered", "delivery_blocked"];
export function initializeRequestTimeline(db) {
  db.exec("CREATE TABLE IF NOT EXISTS request_run_timeline (id TEXT NOT NULL, stage TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(id,stage))");
}

export function recordRequestStage(db, id, stage, at = Date.now()) {
  if (typeof id !== "string" || !id || !stages.includes(stage) || !Number.isSafeInteger(at) || at < 0) return false;
  // Observability failure must never turn a saved execution result into a lost
  // result or prevent delivery. Missing observations stay explicitly missing.
  try {
    db.prepare("INSERT OR IGNORE INTO request_run_timeline(id,stage,at) VALUES (?,?,?)").run(id, stage, at);
    return true;
  } catch { return false; }
}

export function readRequestTimeline(db, id) {
  const run = db.prepare("SELECT response,delivered FROM request_runs WHERE id=?").get(id);
  let rows;
  try { rows = db.prepare("SELECT stage,at FROM request_run_timeline WHERE id=?").all(id); }
  catch { rows = []; }
  const milestones = Object.fromEntries(stages.map(stage => [stage, rows.find(row => row.stage === stage)?.at ?? null]));
  const elapsed = (from, to) => milestones[from] !== null && milestones[to] !== null && milestones[to] >= milestones[from]
    ? milestones[to] - milestones[from] : null;
  return {
    state: run?.delivered ? "delivered" : milestones.delivery_blocked !== null ? "needs_reconciliation"
      : run?.response ? "pending_delivery" : run ? "needs_reconciliation" : "not_started",
    milestones,
    durationsMs: { preparation: elapsed("noticed", "accepted"), admission: elapsed("accepted", "started"),
      execution: elapsed("started", "finished"), delivery: elapsed("finished", "delivered") },
    // Requested is a server timestamp; remaining stages use this host's clock.
    // Do not report a cross-machine queue duration as a measured local latency.
    clockScope: "requested_server_other_stages_local", liveExecutionVerified: false,
  };
}

// Local diagnostic command: opens an existing journal read-only; never connects
// to Room or runs a host. Use the host requestId returned by runRequestOnce.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [journal, id] = process.argv.slice(2);
  if (process.argv.length !== 4 || !isAbsolute(journal ?? "") || !/^host-[a-f0-9]{64}$/.test(id ?? "")) {
    console.error("Usage: node client/request-timeline.mjs /absolute/private-journal.sqlite HOST_REQUEST_ID");
    process.exitCode = 1;
  } else {
    let db;
    try {
      db = new DatabaseSync(journal, { readOnly: true });
      console.log(JSON.stringify(readRequestTimeline(db, id)));
    } catch { console.error("Could not read the local request timeline"); process.exitCode = 1; }
    finally { db?.close(); }
  }
}
