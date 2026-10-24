import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_STALE_AFTER_MS } from "../server/jobs.mjs";
import { BACKUP_ALERT_RETRY_MS, BACKUP_ALERT_TO, deliverBackupAlert, reviewBackupHealth } from "../server/backup-alert.mjs";
import { CRON_JOBS, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

const HOUR_MS = 60 * 60 * 1000;
const now = Date.parse("2026-10-24T23:00:00Z");

function board(backup) {
  const stored = {};
  for (const job of CRON_JOBS) {
    stored[job.name] = { lastRunAt: now, lastSuccessAt: now, consecutiveFailures: 0, lastSummary: { targetFailed: 0 } };
  }
  stored["room-backup"] = { ...stored["room-backup"], ...backup };
  return jobHealthView(stored, now);
}

test("room backup goes stale after 26 hours without a success and stays green inside that window", () => {
  const fresh = board({ lastRunAt: now - 20 * HOUR_MS, lastSuccessAt: now - 20 * HOUR_MS });
  const backup = fresh.jobs.find(job => job.name === "room-backup");
  assert.equal(backup.staleAfterSeconds, BACKUP_STALE_AFTER_MS / 1000);
  assert.equal(backup.status, "ok");
  assert.equal(fresh.status, "ok");

  const boundary = board({ lastRunAt: now - BACKUP_STALE_AFTER_MS, lastSuccessAt: now - BACKUP_STALE_AFTER_MS });
  assert.equal(boundary.jobs.find(job => job.name === "room-backup").status, "ok");

  const late = board({ lastRunAt: now - 27 * HOUR_MS, lastSuccessAt: now - 27 * HOUR_MS });
  const lateBackup = late.jobs.find(job => job.name === "room-backup");
  assert.equal(lateBackup.status, "stale");
  assert.equal(lateBackup.stale, true);
  assert.equal(late.status, "stale");

  const never = board({ lastRunAt: null, lastSuccessAt: null });
  assert.equal(never.jobs.find(job => job.name === "room-backup").status, "stale");
  assert.equal(never.status, "stale");
});

test("a missed backup notifies once per incident and clears on the next success", async () => {
  const late = {
    lastSuccessAt: now - 27 * HOUR_MS,
    consecutiveFailures: 2,
    lastSummary: { targetFailed: 1 },
    lastError: "secret sk_live_should_not_appear room commons",
  };
  assert.equal(reviewBackupHealth(late, now).notify, true);
  assert.equal(reviewBackupHealth({ lastSuccessAt: now - 20 * HOUR_MS, consecutiveFailures: 0, lastSummary: { targetFailed: 0 } }, now).incident, false);
  assert.equal(reviewBackupHealth({ lastSuccessAt: now - HOUR_MS, consecutiveFailures: 0, lastSummary: { errors: 1 } }, now).incident, true);

  const sent = [];
  const first = await deliverBackupAlert({
    record: late,
    now,
    send: async message => { sent.push(message); },
  });
  assert.equal(first.sent, true);
  assert.equal(first.record.backupIncident, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, BACKUP_ALERT_TO);
  assert.match(sent[0].text, /Hours since last success: 27\.0/);
  assert.match(sent[0].text, /Consecutive failures: 2/);
  assert.match(sent[0].text, /A backup target failed: yes/);
  assert.equal(sent[0].text.includes("sk_live_should_not_appear"), false);
  assert.equal(sent[0].text.includes("commons"), false);

  const again = await deliverBackupAlert({
    record: first.record,
    now: now + HOUR_MS,
    send: async () => { sent.push("again"); },
  });
  assert.equal(again.sent, false);
  assert.equal(sent.length, 1);

  const cleared = await deliverBackupAlert({
    record: { ...first.record, lastSuccessAt: now + 2 * HOUR_MS, consecutiveFailures: 0, lastSummary: { targetFailed: 0 } },
    now: now + 2 * HOUR_MS,
    send: async () => { throw new Error("cleared incident must not send"); },
  });
  assert.equal(cleared.sent, false);
  assert.equal(cleared.record.backupIncident, false);
  assert.equal(cleared.record.backupAlertAttemptAt, null);
});

test("a backup notice waits out a failed send and retries after the quiet period", async () => {
  const late = { lastSuccessAt: null, consecutiveFailures: 1, lastSummary: { targetFailed: 1 } };
  const failed = await deliverBackupAlert({
    record: late,
    now,
    send: async () => { throw new Error("mailbox down: token=secret"); },
  });
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, "send_failed");
  assert.equal(failed.record.backupIncident, undefined);
  assert.equal(failed.record.backupAlertAttemptAt, now);

  const quiet = await deliverBackupAlert({
    record: failed.record,
    now: now + BACKUP_ALERT_RETRY_MS - 1,
    send: async () => { throw new Error("should not retry yet"); },
  });
  assert.equal(quiet.sent, false);
  assert.equal(quiet.reason, null);

  const unconfigured = await deliverBackupAlert({ record: late, now, send: null });
  assert.equal(unconfigured.reason, "mail_unconfigured");
  assert.equal(unconfigured.record.backupIncident, undefined);

  let retried = 0;
  const next = await deliverBackupAlert({
    record: failed.record,
    now: now + BACKUP_ALERT_RETRY_MS,
    send: async () => { retried += 1; },
  });
  assert.equal(retried, 1);
  assert.equal(next.sent, true);
  assert.equal(next.record.backupIncident, true);
  assert.equal(next.record.backupAlertAttemptAt, null);
});
