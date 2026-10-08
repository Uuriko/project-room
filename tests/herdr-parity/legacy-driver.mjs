// Legacy-backend driver for the parity scenario.
//
// Drives the REAL legacy session machinery — the same modules production
// uses today:
//   - claims:      server/work-claims.mjs (createWork/claimWork/updateWork)
//   - session run: src/work-item-session.js (applySessionFields projection +
//                  sessionCard, the served card shape)
//   - heartbeats:  server/agent-heartbeats.mjs (AgentHeartbeats over an
//                  in-memory SQLite store, deterministic clock)
//
// Every room-observable artifact (claim item, session card, journal, event
// sequence, heartbeat presence record) is recorded per scenario step into
// the trace the comparator checks against the herdr run.
import { DatabaseSync } from "node:sqlite";
import { createWork, claimWork, updateWork } from "../../server/work-claims.mjs";
import {
  applySessionFields, sessionCard,
  SESSION_EVENT_TYPES, SESSION_STATUSES,
} from "../../src/work-item-session.js";
import { AgentHeartbeats, agentHeartbeatSchema } from "../../server/agent-heartbeats.mjs";
import { createVirtualClock } from "./virtual-clock.mjs";
import { createRoomJournal } from "./room-journal.mjs";

const HOST_ID = "parity-host-1";
const LEASE_HOURS = 24;

const sessionEvent = (type, clock, actorId, data = {}) => ({
  type, at: clock.iso(), actorId, data,
});

export async function createLegacyDriver() {
  const clock = createVirtualClock();
  const journal = createRoomJournal(clock);
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  const heartbeats = new AgentHeartbeats({ db, now: () => clock.now() });

  let claimItem = null;
  let sessionItem = null; // work item carrying the session ledger fields
  const steps = [];

  const recordStep = (op, extra = {}) => {
    const fromSeq = steps.length === 0 ? 0 : steps[steps.length - 1].journalToSeq;
    const journalDelta = journal.since(fromSeq);
    const events = journalDelta.map(e => e.type);
    steps.push({
      op,
      claim: claimItem,
      sessionCard: sessionItem ? sessionCard(sessionItem) : null,
      journalDelta,
      heartbeat: extra.heartbeat ?? null,
      events,
      journalToSeq: journal.entries.length,
    });
  };

  const tick = () => clock.tick();

  return {
    backend: "legacy",

    async claim(taskId, agentId) {
      tick();
      const now = clock.now();
      claimItem = claimWork(
        createWork({ id: taskId, title: `${taskId} title` }, { now }),
        agentId, { leaseHours: LEASE_HOURS, now },
      );
      sessionItem = {
        id: taskId, title: `${taskId} title`, revision: 1,
        state: "proposed", accountableMemberId: agentId,
        status: SESSION_STATUSES.QUEUED,
      };
      journal.append("work.claimed", agentId, { taskId, state: claimItem.state });
      recordStep("claim");
    },

    async startSession(taskId, agentId) {
      tick();
      const now = clock.now();
      claimItem = updateWork(claimItem, agentId, { state: "in_progress", now });
      journal.append("work.state_changed", agentId, { from: "claimed", to: "in_progress" });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STARTED, clock, agentId));
      journal.append("session.started", agentId, { status: sessionItem.status });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STATUS_CHANGED, clock, agentId,
        { status: SESSION_STATUSES.ACTIVE }));
      journal.append("session.status_changed", agentId, { to: SESSION_STATUSES.ACTIVE });
      recordStep("startSession");
    },

    async heartbeat(taskId, agentId) {
      tick();
      const { pendingWakes } = heartbeats.heartbeat({ agentId, hostId: HOST_ID, mode: "pull-only" });
      const status = heartbeats.statusOf(agentId);
      // Same-status STATUS_CHANGED is the legacy heartbeat-renew path.
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STATUS_CHANGED, clock, agentId,
        { status: SESSION_STATUSES.ACTIVE }));
      journal.append("heartbeat.recorded", agentId, { hostId: HOST_ID, mode: "pull-only" });
      journal.append("session.heartbeat", agentId, { heartbeat_at: sessionItem.heartbeat_at });
      const heartbeatRecord = {
        agentId, hostId: HOST_ID, mode: "pull-only",
        status: status.status,
        lastSeenAt: status.lastSeenAt === null ? null : new Date(status.lastSeenAt).toISOString(),
        pendingWakes: pendingWakes.length,
      };
      recordStep("heartbeat", { heartbeat: heartbeatRecord });
    },

    async reportBlocked(taskId, agentId, note) {
      tick();
      const now = clock.now();
      claimItem = updateWork(claimItem, agentId, { state: "blocked", note, now });
      journal.append("work.state_changed", agentId, { from: "in_progress", to: "blocked", note });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STATUS_CHANGED, clock, agentId,
        { status: SESSION_STATUSES.SUSPENDED }));
      journal.append("session.status_changed", agentId, { to: SESSION_STATUSES.SUSPENDED });
      recordStep("reportBlocked");
    },

    async finish(taskId, agentId, note) {
      tick();
      const now = clock.now();
      // The claim machine requires resume-before-done: blocked → in_progress → done.
      claimItem = updateWork(claimItem, agentId, { state: "in_progress", note: "resuming", now });
      journal.append("work.state_changed", agentId, { from: "blocked", to: "in_progress" });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STATUS_CHANGED, clock, agentId,
        { status: SESSION_STATUSES.ACTIVE }));
      journal.append("session.status_changed", agentId, { to: SESSION_STATUSES.ACTIVE });
      claimItem = updateWork(claimItem, agentId, { state: "done", note, tags: ["parity"], now });
      journal.append("work.done", agentId, { note, tags: ["parity"] });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STOPPED, clock, agentId,
        { status: SESSION_STATUSES.DONE }));
      journal.append("session.stopped", agentId, { status: SESSION_STATUSES.DONE });
      recordStep("finish");
    },

    // Runs fn, capturing a thrown error as data (for error-path parity).
    async tryOp(fn) {
      try { await fn(); return { ok: true }; }
      catch (err) { return { ok: false, code: err.code ?? null, message: err.message }; }
    },

    // The claim machine refuses claimed → done; used by the error-path test.
    async illegalFinish(taskId, agentId) {
      return updateWork(claimItem, agentId, { state: "done", now: clock.now() });
    },

    trace() {
      return {
        backend: "legacy",
        steps: steps.map(({ journalToSeq: _drop, ...rest }) => rest),
        journal: journal.entries,
        eventSequence: journal.types(),
      };
    },

    async close() { db.close(); },
  };
}
