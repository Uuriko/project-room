// D4-3 F-1: backup-verify had no driver — scripts/backup-verify.mjs's
// restore-verification cycle was documented as cron-driven, but no
// scheduler artefact in the tree referenced it. The one backup timer
// that exists (deploy/project-room-backup.timer) targeted a different
// script, scripts/backup-room.mjs, which verifies its copy inline but
// never runs the restore-verification cycle.
//
// Cure: the existing systemd driver takes the verifier. The daily
// timer's service now runs scripts/backup-verify.mjs (backupRoom +
// verifyRestoredBackup + reconcile in one cycle) instead of the
// copy-only script. --force is required: the systemd timer is the
// schedule, and without it the script's own daily due-gate (lastRun +
// 24h in its state file) combined with the timer's RandomizedDelaySec
// can skip a whole day when a fire lands <24h after the previous run.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("backup service runs the restore-verification cycle, not the copy-only script", () => {
  const unit = read("deploy/project-room-backup.service");
  const exec = unit.split("\n").find((line) => line.startsWith("ExecStart="));
  assert.ok(exec, "service carries an ExecStart line");
  assert.match(exec, /scripts\/backup-verify\.mjs/, "ExecStart runs backup-verify.mjs");
  assert.doesNotMatch(exec, /backup-room\.mjs/, "ExecStart no longer runs the copy-only backup-room.mjs");
  assert.match(exec, /--force/, "timer is the schedule: each fire runs one cycle");
  assert.match(exec, /--schedule daily/, "cycle records the daily schedule the timer drives");
  assert.match(exec, /--to \/var\/lib\/project-room\/backups/, "backups land in the existing private destination");
});

test("the driver chain is intact: daily timer -> this service, enabled by install.sh", () => {
  const timer = read("deploy/project-room-backup.timer");
  assert.match(timer, /^OnCalendar=daily$/m);
  assert.match(timer, /^Unit=project-room-backup\.service$/m);
  const install = read("deploy/install.sh");
  assert.match(install, /systemctl enable --now project-room-backup\.timer/);
  assert.match(install, /project-room-backup\.service/, "install.sh renders the service the timer fires");
});
