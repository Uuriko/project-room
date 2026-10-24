// Once-per-incident notice when the daily room backup has no recent success.
// The decision is pure. Delivery is a caller-supplied send function so a
// test can prove the notice without a mailbox. The body names age and
// failure counts only: no error text, room ids, keys, or secrets.
import { BACKUP_STALE_AFTER_MS } from "./jobs.mjs";

export const BACKUP_ALERT_TO = "potter@trydemigod.com";
export const BACKUP_ALERT_RETRY_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function summaryCount(summary, key) {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function reviewBackupHealth(record, now) {
  const rec = record && typeof record === "object" ? record : {};
  const successAt = Number.isFinite(rec.lastSuccessAt) ? rec.lastSuccessAt : null;
  const ageMs = successAt == null ? null : Math.max(0, now - successAt);
  const consecutiveFailures = Number.isFinite(rec.consecutiveFailures) ? rec.consecutiveFailures : 0;
  const targetFailed = summaryCount(rec.lastSummary, "targetFailed") > 0 || summaryCount(rec.lastSummary, "errors") > 0;
  const incident = successAt == null || ageMs > BACKUP_STALE_AFTER_MS || consecutiveFailures > 0 || targetFailed;
  const flagged = rec.backupIncident === true;
  const attemptAt = Number.isFinite(rec.backupAlertAttemptAt) ? rec.backupAlertAttemptAt : null;
  const retryReady = attemptAt == null || now - attemptAt >= BACKUP_ALERT_RETRY_MS;
  return {
    incident,
    notify: incident && !flagged && retryReady,
    clear: !incident && flagged,
    ageMs,
    consecutiveFailures,
    targetFailed,
  };
}

export function backupAlertText(decision) {
  const hours = decision.ageMs == null ? "none" : (decision.ageMs / HOUR_MS).toFixed(1);
  return [
    "Room backup has no recent success.",
    `Hours since last success: ${hours}.`,
    `Consecutive failures: ${decision.consecutiveFailures}.`,
    `A backup target failed: ${decision.targetFailed ? "yes" : "no"}.`,
  ].join(" ");
}

// Returns the heartbeat record to store. `sent` is true only after send
// resolves. A missing sender or a failed send leaves the incident unflagged
// and stamps the attempt so the next cron does not retry immediately.
export async function deliverBackupAlert({ record, now, send }) {
  const current = record && typeof record === "object" ? record : {};
  const decision = reviewBackupHealth(current, now);
  if (decision.clear) {
    return { record: { ...current, backupIncident: false, backupAlertAttemptAt: null }, sent: false, reason: null };
  }
  if (!decision.notify) return { record: current, sent: false, reason: null };
  if (typeof send !== "function") {
    return { record: { ...current, backupAlertAttemptAt: now }, sent: false, reason: "mail_unconfigured" };
  }
  try {
    await send({
      to: BACKUP_ALERT_TO,
      subject: "Room backup has no recent success",
      text: backupAlertText(decision),
    });
    return { record: { ...current, backupIncident: true, backupAlertAttemptAt: null }, sent: true, reason: null };
  } catch {
    return { record: { ...current, backupAlertAttemptAt: now }, sent: false, reason: "send_failed" };
  }
}
