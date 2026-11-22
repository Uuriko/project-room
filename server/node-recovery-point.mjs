// The recovery point for automatic projection relief on a Node-served store.
//
// Relief (server/store-relief.mjs) archives nothing without a verified
// recovery point (QA delta 17987, docs/OPERATOR.md "Take a backup first").
// The Worker hands it the newest verified daily backup from ROOM_BACKUPS
// (R2) or ROOM_BACKUPS_KV. A Node process has neither binding and runs no
// room-backup job, so on Node the gate always answered "backup missing":
// the store-growth job paged every hour while a room sat at its projection
// cap and every write to it failed with 409 pilot_limit.
//
// This takes that backup locally: an online SQLite backup of the live
// database into a sibling directory, verified by reopening it read-only
// (quick_check, and every table relief touches must hold at least what the
// live store held when the copy began). A verified copy at most a day old
// is reused, so relief costs one copy per day at most. Anything that goes
// wrong (an in-memory store, too little free disk, a failed copy or check)
// returns null and relief keeps failing closed exactly as before.
//
// Opt out with ROOM_RELIEF_LOCAL_BACKUP=0.

import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RECOVERY_DIRECTORY_NAME = "relief-recovery";
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
const SNAPSHOT = /^room-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.sqlite$/;
const CHECKED_TABLES = Object.freeze(["rooms", "events", "messages"]);

export function localRecoveryEnabled(env = {}) {
  return env?.ROOM_RELIEF_LOCAL_BACKUP !== "0";
}

function databasePath(store) {
  try {
    const location = store?.db?.location?.();
    return typeof location === "string" && location && location !== ":memory:" ? location : null;
  } catch { return null; }
}

function counts(db) {
  const out = {};
  for (const table of CHECKED_TABLES) {
    try { out[table] = Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n); }
    catch { out[table] = null; }
  }
  return out;
}

function verifiedSidecar(directory, name, now, maxAgeMs) {
  try {
    const sidecar = JSON.parse(readFileSync(join(directory, `${name}.verified.json`), "utf8"));
    const at = Date.parse(sidecar?.verifiedAt);
    if (sidecar?.verified !== true || !Number.isFinite(at) || now - at > maxAgeMs || now < at) return null;
    if (statSync(join(directory, name)).size !== sidecar.bytes) return null;
    return { at, sidecar };
  } catch { return null; }
}

function snapshots(directory) {
  try { return readdirSync(directory).filter(name => SNAPSHOT.test(name)).sort().reverse(); }
  catch { return []; }
}

function prune(directory, keepName) {
  for (const name of readdirSync(directory)) {
    if (name === keepName || name === `${keepName}.verified.json`) continue;
    if (name.startsWith("room-") && (SNAPSHOT.test(name) || /\.verified\.json$/.test(name) || /\.partial(-wal|-shm|-journal)?$/.test(name) || /\.sqlite-(wal|shm)$/.test(name))) {
      try { rmSync(join(directory, name), { force: true }); } catch { /* best effort */ }
    }
  }
}

function freeBytes(directory) {
  try { const fs = statfsSync(directory); return Number(fs.bavail) * Number(fs.bsize); }
  catch { return null; }
}

// Returns { key, target: "local", ageDays } or null. Counts only, no paths
// or room ids, because the summary can reach the public health surface.
export async function localRecoveryPoint(store, { env = {}, now = () => Date.now(), maxAgeMs = RECOVERY_MAX_AGE_MS, directory = null, copy = backup } = {}) {
  if (!localRecoveryEnabled(env) || store?.readOnly) return null;
  const source = databasePath(store);
  if (!source) return null;
  const dir = directory ?? join(dirname(source), RECOVERY_DIRECTORY_NAME);
  try {
    const at = now();
    for (const name of snapshots(dir)) {
      const fresh = verifiedSidecar(dir, name, at, maxAgeMs);
      if (fresh) return { key: name, target: "local", ageDays: Math.floor((at - fresh.at) / 86_400_000) };
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const need = statSync(source).size * 2 + FREE_SPACE_MARGIN_BYTES;
    const free = freeBytes(dir);
    if (free === null || free < need) {
      console.warn("[store-growth] local recovery point skipped: not enough free disk");
      return null;
    }
    const before = counts(store.db);
    const name = `room-${new Date(at).toISOString().replace(/[:.]/g, "-")}.sqlite`;
    const partial = join(dir, `${name}.partial`);
    rmSync(partial, { force: true });
    let complete = false, verified = null;
    try {
      await copy(store.db, partial);
      chmodSync(partial, 0o600);
      // Reopen the copy on its own: a rollback journal keeps it one file
      // (no -wal/-shm beside it), then check it and count what relief needs.
      const check = new DatabaseSync(partial);
      try {
        check.exec("PRAGMA journal_mode=DELETE");
        const ok = check.prepare("PRAGMA quick_check").get()?.quick_check === "ok";
        const after = counts(check);
        complete = ok && CHECKED_TABLES.every(table => before[table] === null || (after[table] !== null && after[table] >= before[table]));
        if (complete) verified = after;
      } finally { check.close(); }
    } catch { complete = false; }
    if (!complete) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${partial}${suffix}`, { force: true });
      console.warn("[store-growth] local recovery point failed verification");
      return null;
    }
    renameSync(partial, join(dir, name));
    const bytes = statSync(join(dir, name)).size;
    writeFileSync(join(dir, `${name}.verified.json`), `${JSON.stringify({ verified: true, verifiedAt: new Date(at).toISOString(), bytes, counts: verified })}\n`, { mode: 0o600 });
    prune(dir, name);
    return { key: name, target: "local", ageDays: 0 };
  } catch (error) {
    console.warn(`[store-growth] local recovery point failed (${typeof error?.code === "string" ? error.code : "error"})`);
    return null;
  }
}
