// F001: automated backup schedule + restore verification.
// Tests for scripts/backup-verify.mjs: schedule parsing/due math plus a
// full backup-cycle against a real RoomStore fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { parseSchedule, nextRunAfter, scheduleIsDue, runBackupCycle, verifyRestoredBackup } from "../scripts/backup-verify.mjs";

const execFileAsync = promisify(execFile);
const checkout = fileURLToPath(new URL("..", import.meta.url));
const script = join(checkout, "scripts", "backup-verify.mjs");

// A small live room with history, closed before the cycle runs so the
// runner opens it the same way production cron would.
function liveDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "bv-room-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "room.sqlite");
  const store = new RoomStore(filename);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < 3; i++) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body: `verify message ${i}` } });
  }
  store.close();
  return filename;
}

function backupDest(t) {
  const dir = mkdtempSync(join(tmpdir(), "bv-dest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseSchedule: named intervals", () => {
  assert.equal(parseSchedule("hourly").intervalMs, 3_600_000);
  assert.equal(parseSchedule("daily").intervalMs, 86_400_000);
  assert.equal(parseSchedule("weekly").intervalMs, 604_800_000);
  assert.equal(parseSchedule("DAILY").kind, "interval");
});

test("parseSchedule: duration forms", () => {
  assert.equal(parseSchedule("15m").intervalMs, 900_000);
  assert.equal(parseSchedule("6h").intervalMs, 21_600_000);
  assert.equal(parseSchedule("2d").intervalMs, 172_800_000);
  assert.equal(parseSchedule("1w").intervalMs, 604_800_000);
});

test("parseSchedule: cron form", () => {
  const s = parseSchedule("0 * * * *");
  assert.equal(s.kind, "cron");
  assert.throws(() => parseSchedule("0 0 1 * *"), /day-of-month/);
});

test("parseSchedule: rejects junk", () => {
  for (const bad of ["", "nope", "*/0 * * * *", "61 * * * *", "0 25 * * *", "0m", "* * * *"]) {
    assert.throws(() => parseSchedule(bad), /schedule required|invalid schedule/);
  }
});

test("nextRunAfter: interval adds the interval", () => {
  assert.equal(nextRunAfter(1_000_000, parseSchedule("hourly")), 1_000_000 + 3_600_000);
});

test("nextRunAfter: cron finds the next matching minute (UTC)", () => {
  const s = parseSchedule("30 2 * * *");
  assert.equal(nextRunAfter(Date.UTC(2026, 0, 5, 1, 0, 0), s), Date.UTC(2026, 0, 5, 2, 30, 0));
  // strictly after: exactly on the mark still advances to the next day
  assert.equal(nextRunAfter(Date.UTC(2026, 0, 5, 2, 30, 0), s), Date.UTC(2026, 0, 6, 2, 30, 0));
});

test("nextRunAfter: cron every-5-minutes steps", () => {
  const s = parseSchedule("*/5 * * * *");
  assert.equal(nextRunAfter(Date.UTC(2026, 0, 5, 2, 3, 0), s), Date.UTC(2026, 0, 5, 2, 5, 0));
});

test("scheduleIsDue: never-run is due, fresh run is not, failed run retries", () => {
  const hourly = parseSchedule("hourly");
  const now = Date.now();
  assert.equal(scheduleIsDue(null, now, hourly), true);
  assert.equal(scheduleIsDue({}, now, hourly), true);
  assert.equal(scheduleIsDue({ lastRun: now - 3_700_000, lastResult: { ok: true } }, now, hourly), true);
  assert.equal(scheduleIsDue({ lastRun: now - 600_000, lastResult: { ok: true } }, now, hourly), false);
  assert.equal(scheduleIsDue({ lastRun: now - 600_000, lastResult: { ok: false } }, now, hourly), true);
});

test("runBackupCycle: full cycle verifies, writes state, then skips when not due", async (t) => {
  const db = liveDb(t);
  const dest = backupDest(t);
  const statePath = join(dest, "state.json");
  const schedule = parseSchedule("hourly");
  const now = Date.now();

  const first = await runBackupCycle({ db, to: dest, statePath, schedule, nowMs: now });
  assert.equal(first.ok, true);
  assert.equal(first.ran, true);
  assert.ok(existsSync(first.result.filename), "backup sqlite exists");
  assert.ok(existsSync(first.result.watermark), "watermark sidecar exists");
  assert.ok(first.verification.checks.every(c => c.ok),
    `all verification checks pass: ${JSON.stringify(first.verification.checks.filter(c => !c.ok))}`);
  assert.deepEqual(first.verification.stale, [], "fresh backup reconciles clean against live");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.lastRun, now);
  assert.equal(state.lastResult.ok, true);
  assert.ok(state.lastResult.backup.endsWith("room.sqlite"));

  const second = await runBackupCycle({ db, to: dest, statePath, schedule, nowMs: now + 60_000 });
  assert.equal(second.ok, true);
  assert.equal(second.ran, false);
  assert.equal(second.reason, "not-due");

  const forced = await runBackupCycle({ db, to: dest, statePath, schedule, force: true, nowMs: now + 120_000 });
  assert.equal(forced.ran, true);
  assert.equal(forced.ok, true);
});

test("verifyRestoredBackup: flags a backup whose events drifted from the watermark", async (t) => {
  const db = liveDb(t);
  const dest = backupDest(t);
  const statePath = join(dest, "state.json");
  const first = await runBackupCycle({ db, to: dest, statePath, schedule: parseSchedule("hourly"), nowMs: Date.now() });
  assert.equal(first.ok, true);
  const tampered = JSON.parse(readFileSync(first.result.watermark, "utf8"));
  tampered.events += 5;
  const tamperedPath = join(dest, "watermark-tampered.json");
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  const report = await verifyRestoredBackup({ backupFilename: first.result.filename, watermarkPath: tamperedPath });
  assert.equal(report.ok, false);
  const failed = report.checks.find(c => c.name === "events-match-watermark");
  assert.ok(failed && failed.ok === false, "event drift is named");
});

test("verifyRestoredBackup: missing watermark fails fast", async () => {
  const report = await verifyRestoredBackup({ backupFilename: "/nonexistent.sqlite", watermarkPath: "/nonexistent.json" });
  assert.equal(report.ok, false);
  assert.equal(report.checks[0].name, "watermark-readable");
});

test("cli: --print-cron emits a usable crontab line", async (t) => {
  const dest = backupDest(t);
  const { stdout } = await execFileAsync(process.execPath,
    [script, "--print-cron", "--db", "room.sqlite", "--to", dest, "--schedule", "hourly"]);
  assert.match(stdout, /\* \* \* \* \*/);
  assert.match(stdout, /--schedule "hourly"/);
  assert.match(stdout, /scripts\/backup-verify\.mjs/);
});

test("cli: missing --db/--to is a usage error", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [script, "--schedule", "hourly"]),
    /are required/);
});

test("cli: --force runs a full cycle and prints JSON", async (t) => {
  const db = liveDb(t);
  const dest = backupDest(t);
  const { stdout } = await execFileAsync(process.execPath,
    [script, "--db", db, "--to", dest, "--schedule", "hourly", "--force"]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.equal(result.schedule, "hourly");
});
