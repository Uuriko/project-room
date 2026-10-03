// Operator status. One read of version, readiness, the largest tables, and
// the latest operator actions. The server does not call GitHub. Job heartbeats
// live on the Worker, which this process does not reach without the Durable
// Object entrypoint, so jobs points at that route.

import { SOURCE_REVISION, BUILD_ID } from "./version.mjs";
import { ServiceError } from "./store.mjs";
import { listOperatorActions } from "./operator-actions.mjs";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function operatorReady(store) {
  try {
    if (store.storageStatus?.().unavailable) return false;
    if (!store.db.prepare("SELECT 1 FROM rooms LIMIT 1").get()) return false;
    return true;
  } catch {
    return false;
  }
}

// A timestamp only when something stored one. The cold-start log is a
// duration, not a clock time, and this module does not add storage for it.
export function lastColdStart(store) {
  const stored = store.lastColdStart ?? null;
  if (typeof stored === "number" || typeof stored === "string") return stored;
  if (stored && typeof stored === "object" && (typeof stored.at === "number" || typeof stored.at === "string")) return stored.at;
  return null;
}

export function collectLargestTables(db, { deadlineMs = 1500, now = () => performance.now(), limit = 25 } = {}) {
  const started = now();
  // Cloudflare's own `_cf_*` tables in a Durable Object refuse reads from
  // application code, so they are left out, and any table that still refuses
  // a count is skipped and reported instead of failing the whole status.
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all()
    .map(row => row.name)
    .filter(name => IDENT.test(name));
  const counts = [];
  const skipped = [];
  let visited = 0;
  for (const table of names) {
    if (now() - started >= deadlineMs) break;
    visited++;
    try {
      counts.push({ table, rows: db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n });
    } catch {
      skipped.push(table);
    }
  }
  const partial = visited < names.length;
  counts.sort((a, b) => b.rows - a.rows || (a.table < b.table ? -1 : 1));
  return { tables: counts.slice(0, limit), partial, ...(skipped.length ? { skipped } : {}) };
}

export function operatorStatus(store, options = {}) {
  const tables = collectLargestTables(store.db, options);
  return {
    version: { sourceRevision: SOURCE_REVISION, buildId: BUILD_ID },
    ready: operatorReady(store),
    jobs: "see /api/health/jobs",
    lastColdStart: lastColdStart(store),
    tables: tables.tables,
    partial: tables.partial,
    ...(tables.skipped ? { skippedTables: tables.skipped } : {}),
    retention: null,
    operatorActions: listOperatorActions(store, 10)
  };
}

export function operatorDrift(main) {
  if (typeof main !== "string" || (!/^[0-9a-f]{7,64}$/i.test(main) && main !== "unstamped")) {
    throw new ServiceError(422, "invalid_revision", "Pass main as a commit SHA");
  }
  return revisionDrift(SOURCE_REVISION, main);
}

// A short SHA (7+ hex) matches when it is a prefix of the other side, so
// `git rev-parse --short` output works as well as a full commit.
export function revisionDrift(deployedRevision, main) {
  const hex = value => typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value);
  const requested = hex(main) ? main.toLowerCase() : main;
  const deployed = hex(deployedRevision) ? deployedRevision.toLowerCase() : deployedRevision;
  let match = deployed === requested;
  if (!match && hex(requested) && hex(deployed)) {
    const [short, long] = requested.length <= deployed.length ? [requested, deployed] : [deployed, requested];
    match = long.startsWith(short);
  }
  return { deployed: deployedRevision, main: requested, match };
}
