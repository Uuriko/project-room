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
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => row.name)
    .filter(name => IDENT.test(name));
  const counts = [];
  for (const table of names) {
    if (now() - started >= deadlineMs) break;
    counts.push({ table, rows: db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n });
  }
  const partial = counts.length < names.length;
  counts.sort((a, b) => b.rows - a.rows || (a.table < b.table ? -1 : 1));
  return { tables: counts.slice(0, limit), partial };
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
    retention: null,
    operatorActions: listOperatorActions(store, 10)
  };
}

export function operatorDrift(main) {
  if (typeof main !== "string" || (!/^[0-9a-f]{7,64}$/i.test(main) && main !== "unstamped")) {
    throw new ServiceError(422, "invalid_revision", "Pass main as a commit SHA");
  }
  const requested = /^[0-9a-f]{7,64}$/i.test(main) ? main.toLowerCase() : main;
  const deployed = /^[0-9a-f]{7,64}$/i.test(SOURCE_REVISION) ? SOURCE_REVISION.toLowerCase() : SOURCE_REVISION;
  return { deployed: SOURCE_REVISION, main: requested, match: deployed === requested };
}
