// Herdr-backend driver for the parity scenario.
//
// The session-execution substrate is the SessionAdapter contract
// (REDESIGN.md §2.2): B2's real `InMemorySessionAdapter` from
// server/session-adapter.mjs. Everything room-observable still flows
// through the REAL room modules, exactly as the integration will wire them
// (compat-plan §1: the claim board is UNAFFECTED — herdr never settles
// claims; REDESIGN §1):
//   - claims:      server/work-claims.mjs (same as legacy)
//   - session run: src/work-item-session.js projection + sessionCard (same)
// Session events are SOURCED from the adapter (spawn/reportState/closePane)
// instead of the legacy heartbeat machinery, then projected through the
// same applySessionFields. The heartbeat presence record is derived from
// adapter self-reported state — the honest path (room-arch mapping #8).
//
// Journal ORDER is part of the parity contract: both drivers journal in
// the canonical order [work.*, session.*] per op, matching the legacy
// driver's order.
import { createWork, claimWork, updateWork } from "../../server/work-claims.mjs";
import {
  applySessionFields, sessionCard,
  SESSION_EVENT_TYPES, SESSION_STATUSES,
} from "../../src/work-item-session.js";
import { createSessionAdapter, INMEMORY_PROTOCOL_VERSION } from "../../server/session-adapter.mjs";
import { createVirtualClock } from "./virtual-clock.mjs";
import { createRoomJournal } from "./room-journal.mjs";

const HOST_ID = "parity-host-1";
const LEASE_HOURS = 24;

// Adapter agent state → room presence. The lane's host transport
// (pull-only) is a host property, unchanged by the session backend.
const presenceOf = (agentState) =>
  ["working", "blocked", "idle"].includes(agentState) ? "online" : "offline";

const sessionEvent = (type, clock, actorId, data = {}) => ({
  type, at: clock.iso(), actorId, data,
});

export async function createHerdrDriver() {
  const clock = createVirtualClock();
  const journal = createRoomJournal(clock);
  const adapter = await createSessionAdapter({ pinnedProtocolVersion: INMEMORY_PROTOCOL_VERSION });
  await adapter.connect();

  // Adapter-internal events are recorded for debuggability only — they are
  // NOT room-observable and are excluded from the parity comparison.
  const adapterEvents = [];
  const sub = await adapter.subscribe(
    ["pane.created", "pane.agent_status_changed", "pane.closed"],
    (ev) => adapterEvents.push({ type: ev.type, state: ev.state ?? null, at: ev.at }),
  );

  let claimItem = null;
  let sessionItem = null;
  let handle = null; // { agentId, paneId, occupant }
  const steps = [];

  const recordStep = (op, extra = {}) => {
    const fromSeq = steps.length === 0 ? 0 : steps[steps.length - 1].journalToSeq;
    const journalDelta = journal.since(fromSeq);
    const stepAdapterEvents = adapterEvents.splice(0, adapterEvents.length);
    steps.push({
      op,
      claim: claimItem,
      sessionCard: sessionItem ? sessionCard(sessionItem) : null,
      journalDelta,
      heartbeat: extra.heartbeat ?? null,
      events: journalDelta.map(e => e.type),
      adapterEvents: stepAdapterEvents,
      journalToSeq: journal.entries.length,
    });
  };

  const tick = () => clock.tick();

  return {
    backend: "herdr",

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
      handle = await adapter.spawnAgent({
        kind: "claude",
        command: "parity-worker",
        metadata: { taskId, memberId: agentId },
      });
      journal.append("work.state_changed", agentId, { from: "claimed", to: "in_progress" });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STARTED, clock, agentId));
      journal.append("session.started", agentId, { status: sessionItem.status });
      await adapter.reportState(handle.paneId, "working", "session start");
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STATUS_CHANGED, clock, agentId,
        { status: SESSION_STATUSES.ACTIVE }));
      journal.append("session.status_changed", agentId, { to: SESSION_STATUSES.ACTIVE });
      recordStep("startSession");
    },

    async heartbeat(taskId, agentId) {
      tick();
      // The herdr heartbeat IS the self-report: reportState("working").
      // The real adapter does not expose a last-report timestamp on the
      // agent record, so lastSeenAt is the driver's own (virtual) clock at
      // the report — the same instant the stub recorded internally.
      const lastSeenAt = clock.iso();
      await adapter.reportState(handle.paneId, "working", "heartbeat");
      const agent = await adapter.getAgent(handle.id);
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STATUS_CHANGED, clock, agentId,
        { status: SESSION_STATUSES.ACTIVE }));
      journal.append("heartbeat.recorded", agentId, { hostId: HOST_ID, mode: "pull-only" });
      journal.append("session.heartbeat", agentId, { heartbeat_at: sessionItem.heartbeat_at });
      const heartbeatRecord = {
        agentId, hostId: HOST_ID, mode: "pull-only",
        status: presenceOf(agent.state),
        lastSeenAt,
        pendingWakes: 0,
      };
      recordStep("heartbeat", { heartbeat: heartbeatRecord });
    },

    async reportBlocked(taskId, agentId, note) {
      tick();
      const now = clock.now();
      // Self-report arrives first (the trigger); the room records it.
      await adapter.reportState(handle.paneId, "blocked", note);
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
      // Resume-before-done, same as the claim machine requires.
      await adapter.reportState(handle.paneId, "working", "resuming");
      claimItem = updateWork(claimItem, agentId, { state: "in_progress", note: "resuming", now });
      journal.append("work.state_changed", agentId, { from: "blocked", to: "in_progress" });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STATUS_CHANGED, clock, agentId,
        { status: SESSION_STATUSES.ACTIVE }));
      journal.append("session.status_changed", agentId, { to: SESSION_STATUSES.ACTIVE });
      await adapter.reportState(handle.paneId, "done", note);
      claimItem = updateWork(claimItem, agentId, { state: "done", note, tags: ["parity"], now });
      journal.append("work.done", agentId, { note, tags: ["parity"] });
      applySessionFields(sessionItem, sessionEvent(SESSION_EVENT_TYPES.STOPPED, clock, agentId,
        { status: SESSION_STATUSES.DONE }));
      journal.append("session.stopped", agentId, { status: SESSION_STATUSES.DONE });
      await adapter.closePane(handle.paneId);
      handle = null;
      recordStep("finish");
    },

    async tryOp(fn) {
      try { await fn(); return { ok: true }; }
      catch (err) { return { ok: false, code: err.code ?? null, message: err.message }; }
    },

    async illegalFinish(taskId, agentId) {
      return updateWork(claimItem, agentId, { state: "done", now: clock.now() });
    },

    trace() {
      // adapterEvents stay in the trace for debuggability; the comparator
      // only compares the room-observable COMPARED_STEP_FIELDS, so they
      // never affect the parity verdict.
      return {
        backend: "herdr",
        steps: steps.map(({ journalToSeq: _drop, ...rest }) => rest),
        journal: journal.entries,
        eventSequence: journal.types(),
      };
    },

    async close() {
      await sub.close().catch(() => {});
      await adapter.disconnect().catch(() => {});
    },
  };
}
