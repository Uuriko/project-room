// F001: automated backup schedule + restore verification.
// Automates the manual drills in scripts/backup-drill.mjs and
// scripts/restore-rehearsal.mjs: a cron/interval schedule config, a one-cycle
// runner (cron invokes this; it skips when the schedule is not due), and a
// restore-verification pass that exercises server/backup.mjs directly.
//
// Usage:
//   node scripts/backup-verify.mjs --db room.sqlite --to /private/backups \
//       --schedule hourly [--state state.json] [--force] [--dry-run]
//   node scripts/backup-verify.mjs --print-cron --db room.sqlite --to /private/backups
//
// Env fallbacks: ROOM_DB, BACKUP_DIR, BACKUP_SCHEDULE.
import { parseArgs } from "node:util";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { backupRoom, reconcileRestoredAuthority } from "../server/backup.mjs";

process.umask(0o077);

const NAMED_INTERVALS = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
const DURATION_UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// Schedule spec: "hourly" | "daily" | "weekly" | "15m" | "6h" | "2d" | "1w"
// | 5-field cron "m h dom mon dow" (dom/mon/dow must be "*"; m/h accept
// "*", "*/n" and literals). Returns { spec, kind: "interval"|"cron", ... }.
export function parseSchedule(spec) {
  if (typeof spec !== "string" || !spec.trim()) throw new Error("schedule required");
  const s = spec.trim();
  const named = NAMED_INTERVALS[s.toLowerCase()];
  if (named) return { spec: s, kind: "interval", intervalMs: named };
  const duration = /^(\d+)([mhdw])$/i.exec(s);
  if (duration) {
    const n = Number(duration[1]);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid schedule: ${spec}`);
    return { spec: s, kind: "interval", intervalMs: n * DURATION_UNITS[duration[2].toLowerCase()] };
  }
  const fields = s.split(/\s+/);
  if (fields.length === 5) {
    const [minute, hour, dom, mon, dow] = fields;
    for (const [field, name] of [[dom, "day-of-month"], [mon, "month"], [dow, "day-of-week"]]) {
      if (field !== "*") throw new Error(`invalid schedule: ${spec} (${name} must be "*")`);
    }
    return { spec: s, kind: "cron", cron: {
      minute: parseCronField(minute, 0, 59, "minute", spec),
      hour: parseCronField(hour, 0, 23, "hour", spec),
    } };
  }
  throw new Error(`invalid schedule: ${spec} (want hourly|daily|weekly, 15m|6h|2d|1w, or 5-field cron)`);
}

function parseCronField(field, min, max, name, spec) {
  if (field === "*") return { type: "any" };
  const every = /^\*\/(\d+)$/.exec(field);
  if (every) {
    const n = Number(every[1]);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`invalid schedule ${name} field: ${spec}`);
    return { type: "every", n };
  }
  if (/^\d+$/.test(field)) {
    const v = Number(field);
    if (v < min || v > max) throw new Error(`invalid schedule ${name} field: ${spec}`);
    return { type: "at", value: v };
  }
  throw new Error(`invalid schedule ${name} field: ${spec}`);
}

function matchCronField(field, value) {
  if (field.type === "any") return true;
  if (field.type === "every") return value % field.n === 0;
  return value === field.value;
}

// Next run strictly after fromMs (UTC).
export function nextRunAfter(fromMs, schedule) {
  if (schedule.kind === "interval") return fromMs + schedule.intervalMs;
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const limit = t + 366 * 24 * 60 * 60_000;
  while (t <= limit) {
    const d = new Date(t);
    if (matchCronField(schedule.cron.minute, d.getUTCMinutes()) &&
        matchCronField(schedule.cron.hour, d.getUTCHours())) return t;
    t += 60_000;
  }
  throw new Error("no cron run within a year - refusing");
}

// state: { lastRun, lastResult: { ok } } read from the state file. A failed
// last run is always due (retry), never silently skipped.
export function scheduleIsDue(state, nowMs, schedule) {
  if (!state || typeof state.lastRun !== "number") return true;
  if (state.lastResult && state.lastResult.ok === false) return true;
  return nowMs >= nextRunAfter(state.lastRun, schedule);
}

// Restore verification: the backup snapshot plus its watermark must prove,
// read-only, that the backup is intact and matches what the watermark pins.
// When liveDbPath is given, reconcile against the live store and name every
// entry the restore would resurrect as current-looking.
export async function verifyRestoredBackup({ backupFilename, watermarkPath, liveDbPath = null, nowMs = Date.now() }) {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
  const done = (stale = [], watermark = null) => ({ ok: checks.every(c => c.ok), checks, stale, watermark });
  let watermark = null;
  try {
    watermark = JSON.parse(readFileSync(watermarkPath, "utf8"));
    check("watermark-readable", true);
  } catch (err) {
    check("watermark-readable", false, err?.message || String(err));
    return done();
  }
  check("watermark-version", watermark.version === 1, `version=${watermark.version}`);
  check("watermark-timestamp",
    typeof watermark.backedUpAt === "number" && watermark.backedUpAt > 0 && watermark.backedUpAt <= nowMs + 60_000,
    `backedUpAt=${watermark.backedUpAt}`);
  check("watermark-events", Number.isSafeInteger(watermark.events) && watermark.events >= 0,
    `events=${watermark.events}`);
  let restored = null;
  try {
    restored = new RoomStore(backupFilename, { readOnly: true });
    const integrityRows = restored.db.prepare("PRAGMA integrity_check").all();
    const bad = integrityRows.filter(row => Object.values(row)[0] !== "ok");
    check("sqlite-integrity", integrityRows.length > 0 && bad.length === 0,
      bad.length ? `corrupt: ${JSON.stringify(bad[0])}` : `${integrityRows.length} page(s) ok`);
    const events = restored.db.prepare("SELECT count(*) AS n FROM events").get().n;
    check("events-match-watermark", events === watermark.events, `backup=${events} watermark=${watermark.events}`);
    const rooms = restored.db.prepare("SELECT id, sequence FROM rooms ORDER BY id").all();
    check("rooms-match-watermark", JSON.stringify(rooms) === JSON.stringify(watermark.rooms ?? null),
      `backup=${JSON.stringify(rooms)}`);
    let stale = [];
    if (liveDbPath) {
      const live = new RoomStore(liveDbPath, { readOnly: true });
      try {
        const report = reconcileRestoredAuthority(restored, live);
        stale = report.stale;
        check("reconcile-clean", stale.length === 0,
          stale.length ? `${stale.length} stale entries resurrected` : "no resurrected authority");
      } finally { live.close(); }
    }
    return done(stale, watermark);
  } catch (err) {
    check("backup-openable", false, err?.message || String(err));
    return done([], watermark);
  } finally { restored?.close(); }
}

function readState(statePath) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* missing or corrupt state: treat as never-run */ }
  return {};
}

function writeState(statePath, state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  chmodSync(statePath, 0o600);
}

// One automation cycle: run backupRoom, verify the restore, record state.
// Returns { ok, ran, ... }. ok=false only when the cycle ran and failed.
export async function runBackupCycle({ db, to, statePath, schedule, force = false, nowMs = Date.now(), reconcile = true }) {
  if (!db || !to) throw new Error("db and to are required");
  const state = readState(statePath);
  if (!force && !scheduleIsDue(state, nowMs, schedule)) {
    return { ok: true, ran: false, reason: "not-due", nextRun: nextRunAfter(state.lastRun, schedule), schedule: schedule.spec };
  }
  mkdirSync(to, { recursive: true });
  const result = await backupRoom(db, to);
  const verification = await verifyRestoredBackup({
    backupFilename: result.filename,
    watermarkPath: result.watermark,
    liveDbPath: reconcile ? db : null,
    nowMs,
  });
  const ok = result.verified === true && verification.ok;
  writeState(statePath, {
    lastRun: nowMs,
    schedule: schedule.spec,
    lastResult: {
      ok,
      backup: result.filename,
      watermark: result.watermark,
      backedUpAt: verification.watermark?.backedUpAt ?? null,
      events: verification.watermark?.events ?? null,
      verifiedAt: nowMs,
    },
  });
  return {
    ok,
    ran: true,
    result: { filename: result.filename, watermark: result.watermark, verified: result.verified },
    verification: { ok: verification.ok, checks: verification.checks, stale: verification.stale },
    nextRun: nextRunAfter(nowMs, schedule),
    schedule: schedule.spec,
  };
}

function printUsage() {
  process.stdout.write(`backup-verify: automated backup schedule + restore verification (F001)

Usage:
  node scripts/backup-verify.mjs --db <room.sqlite> --to <backup-dir> [--schedule <spec>]
      [--state <state.json>] [--force] [--dry-run] [--no-reconcile]
  node scripts/backup-verify.mjs --print-cron --db <room.sqlite> --to <backup-dir>
      [--schedule <spec>]

Schedule spec: hourly | daily | weekly | 15m | 6h | 2d | 1w | 5-field cron.
Env fallbacks: ROOM_DB, BACKUP_DIR, BACKUP_SCHEDULE (default schedule: daily).
Exit codes: 0 ok (or not-due skip), 1 cycle failed, 2 usage error.
`);
}

async function main() {
  const { values } = parseArgs({ options: {
    db: { type: "string" },
    to: { type: "string" },
    schedule: { type: "string" },
    state: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "print-cron": { type: "boolean", default: false },
    "no-reconcile": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) { printUsage(); return; }
  let schedule;
  try {
    schedule = parseSchedule(values.schedule || process.env.BACKUP_SCHEDULE || "daily");
  } catch (err) {
    process.stderr.write(`backup-verify: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const db = values.db || process.env.ROOM_DB;
  const to = values.to || process.env.BACKUP_DIR;
  if (!db || !to) {
    process.stderr.write("backup-verify: --db and --to (or ROOM_DB and BACKUP_DIR) are required\n");
    process.exitCode = 2;
    return;
  }
  const statePath = values.state || join(resolve(to), "backup-verify-state.json");
  if (values["print-cron"]) {
    const root = fileURLToPath(new URL("..", import.meta.url));
    process.stdout.write(
      `# project-room F001: automated backup + restore verification\n` +
      `# Runs every minute; the script itself skips until the schedule ("${schedule.spec}") is due.\n` +
      `* * * * * cd ${root} && node scripts/backup-verify.mjs --db "${db}" --to "${to}" --schedule "${schedule.spec}" >> "${resolve(to)}/backup-verify.log" 2>&1\n`);
    return;
  }
  const nowMs = Date.now();
  if (values["dry-run"]) {
    const state = readState(statePath);
    const due = values.force || scheduleIsDue(state, nowMs, schedule);
    process.stdout.write(`${JSON.stringify({ dryRun: true, wouldRun: due, schedule: schedule.spec, nextRun: due ? nowMs : nextRunAfter(state.lastRun, schedule) })}\n`);
    return;
  }
  try {
    const outcome = await runBackupCycle({ db, to, statePath, schedule, force: values.force, nowMs, reconcile: !values["no-reconcile"] });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (!outcome.ok) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`backup-verify: cycle failed: ${err?.message || err}\n`);
    process.exitCode = 1;
  }
}

// Only run the CLI when executed directly (tests import the functions above).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
