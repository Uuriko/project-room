// Acknowledgement for an assignment or mention.
// Acknowledged as soon as the assignee picks up. Not responding after the timeout.
export const ACK_TIMEOUT_MS = 120_000;

export const ACK_STATES = Object.freeze(["waiting", "acknowledged", "not_responding"]);

export const ACK_LABELS = Object.freeze({
  waiting: "Waiting",
  acknowledged: "Acknowledged",
  not_responding: "Not responding",
});

export function ackState({ openedAt = null, ackedAt = null, now = Date.now(), timeoutMs = ACK_TIMEOUT_MS, pickedUp = false } = {}) {
  const acked = Number.isFinite(ackedAt) ? ackedAt : null;
  if (pickedUp || acked !== null) {
    return Object.freeze({
      state: "acknowledged",
      at: acked === null ? null : new Date(acked).toISOString(),
      label: ACK_LABELS.acknowledged,
    });
  }
  const opened = Number.isFinite(openedAt) ? openedAt : null;
  if (opened !== null && Number.isFinite(now) && now - opened >= timeoutMs) {
    return Object.freeze({ state: "not_responding", at: null, label: ACK_LABELS.not_responding });
  }
  return Object.freeze({ state: "waiting", at: null, label: ACK_LABELS.waiting });
}

// The holder picked the claim up themselves, or already moved it.
// A reassign leaves the new owner waiting until they ack or start.
export function claimHolderAck(claim, { now = Date.now(), timeoutMs = ACK_TIMEOUT_MS, ackedAt = null } = {}) {
  if (!claim?.owner || claim.state === "unclaimed" || claim.state === "closed") return null;
  const history = Array.isArray(claim.history) ? claim.history : [];
  const last = history.length ? history[history.length - 1] : null;
  const selfClaimed = last?.action === "claimed" && last.agentId === claim.owner;
  const started = claim.state === "in_progress" || claim.state === "blocked" || claim.state === "delivered" || claim.state === "done";
  const freshAck = Number.isFinite(ackedAt) && (!Number.isFinite(Date.parse(claim.claimedAt ?? "")) || ackedAt >= Date.parse(claim.claimedAt));
  return ackState({
    openedAt: Date.parse(claim.claimedAt ?? ""),
    ackedAt: freshAck ? ackedAt : null,
    now,
    timeoutMs,
    pickedUp: selfClaimed || started,
  });
}

export function mentionAck(row, now = Date.now(), timeoutMs = ACK_TIMEOUT_MS) {
  if (!row) return null;
  const state = row.state;
  if (state === "acknowledged" || state === "responded") {
    const at = Number.isFinite(row.ackedAt) ? row.ackedAt : Number.isFinite(row.decidedAt) ? row.decidedAt : null;
    return ackState({ ackedAt: at ?? now, now, timeoutMs, pickedUp: true });
  }
  const openedAt = Number.isFinite(row.createdAt) ? row.createdAt : null;
  const deadline = Number.isFinite(row.timeoutAt) ? row.timeoutAt : (openedAt === null ? null : openedAt + timeoutMs);
  if (state === "timed_out" || (deadline !== null && now >= deadline)) {
    return ackState({ openedAt: openedAt ?? now - timeoutMs, now, timeoutMs, pickedUp: false });
  }
  return ackState({ openedAt, now, timeoutMs, pickedUp: false });
}
