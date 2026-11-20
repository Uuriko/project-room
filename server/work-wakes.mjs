// Explicit host opt-in for pointer-only work delivery on the heartbeat pull path.
// Separate additive tables leave the existing mention/DM journal readable by old hosts.
import { readWakeWindow } from './wake-delivery-window.mjs';
import { createHash, randomUUID } from "node:crypto";
import { nextWorkStep, workActions } from "../src/workflow.js";
import { firstBlockedWakeTarget } from "../src/events.js";
import { sessionRecord } from "../src/work-item-session.js";
import { heldUntil } from "./attention.mjs";
import { mutedEvent } from "./moderation.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";
import { outsidePrivateWork, selectedWorkRead } from "./work-context.mjs";
import { recordWakeEvent } from "./wake-metrics.mjs";
import { isCurrentRoom } from "./current-room-repository.mjs";
import { boardClaimId } from "./work-item-board.mjs";
import { boardPrerequisiteState, nativePrerequisiteState } from "./work-item-state.mjs";

export const workWakeSchema = `
  CREATE TABLE IF NOT EXISTS agent_work_wake_hosts (
    agent_id TEXT NOT NULL, host_id TEXT NOT NULL, room_id TEXT,
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    PRIMARY KEY(agent_id,host_id)
  );
  CREATE TABLE IF NOT EXISTS agent_work_wakes (
    signal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, room_id TEXT NOT NULL,
    member_id TEXT NOT NULL, work_item_id TEXT NOT NULL, work_revision INTEGER NOT NULL,
    event_id TEXT NOT NULL, actor_id TEXT NOT NULL, pointer TEXT NOT NULL,
    created_at INTEGER NOT NULL, delivered_at INTEGER, invalidated_at INTEGER,
    UNIQUE(agent_id,room_id,event_id)
  );
  CREATE INDEX IF NOT EXISTS agent_work_wakes_pending ON agent_work_wakes(agent_id,delivered_at,invalidated_at);
`;

export class WorkWakes {
  constructor(store) { this.store = store; this.db = store.db; this.available = false; }
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = workWakeSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) if (normalize(sql) !== normalize(actual)) throw new Error("Work wake schema requires operator reconciliation");
    this.available = true;
    return true;
  }
  setHost(agentId, hostId, enabled, roomId = null) {
    this.db.prepare(`INSERT INTO agent_work_wake_hosts VALUES(?,?,?,?)
      ON CONFLICT(agent_id,host_id) DO UPDATE SET room_id=excluded.room_id,enabled=excluded.enabled`)
      .run(agentId, hostId, roomId, enabled ? 1 : 0);
  }
  hostEnabled(agentId, hostId) {
    if (!this.available) return false;
    return this.db.prepare("SELECT enabled FROM agent_work_wake_hosts WHERE agent_id=? AND host_id=?").get(agentId, hostId)?.enabled === 1;
  }
  optedIn(agentId, roomId, hostId = null) {
    if (!this.available) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM agent_work_wake_hosts WHERE agent_id=? AND enabled=1
      AND (room_id IS NULL OR room_id=?) AND (? IS NULL OR host_id=?) LIMIT 1`).get(agentId, roomId, hostId, hostId));
  }
  permitted(state, item, memberId, actorId) {
    const member = state.members[memberId];
    const session = sessionRecord(item);
    return member?.active !== false && member?.kind === "agent" && !isGuestAgentMemberId(memberId)
      && !state.room.archivedAt && member.notificationPreferences?.work_updates !== "none"
      && !firstBlockedWakeTarget(state, actorId, [memberId])
      && !mutedEvent(state, memberId, { actorId })
      && !session.stop_requested_at && session.status !== "suspended";
  }
  // Called within the command transaction, after its event and projection land.
  transition(roomId, before, state, incoming) {
    const id = incoming.data?.workItemId, item = state.workItems[id];
    if (!item || item.revision === before.workItems[id]?.revision) return;
    const at = this.store.now();
    const invalidated = this.db.prepare(`UPDATE agent_work_wakes SET invalidated_at=? WHERE room_id=? AND work_item_id=?
      AND work_revision<>? AND invalidated_at IS NULL AND delivered_at IS NULL`).run(at, roomId, id, item.revision).changes;
    // #3345: superseded-before-delivery is a designed outcome, counted so
    // the work store's emitted vs acked reconciles instead of leaking.
    if (invalidated > 0) recordWakeEvent(this.db, { at, roomId, store: "work",
      event: "invalidated", kind: "work", n: invalidated });
    this.emitWork(roomId, state, item, incoming, at);
    this.releaseSuccessors(roomId, before, state, item, incoming, at);
  }

  scopedReceiver(roomId, agentId, now, hostId = null) {
    // The lease table is installed only when a runtime opts into listener leases.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_wake_listener_leases'").get()) return false;
    return Boolean(this.db.prepare(`SELECT 1 FROM agent_wake_listener_leases l
      JOIN agent_work_wake_hosts h ON h.agent_id=l.agent_id AND h.host_id=l.listener_id AND h.enabled=1
      WHERE l.room_key=? AND l.lease_expires_at>? AND (h.room_id IS NULL OR h.room_id=l.room_key)
        AND (? IS NULL OR l.agent_id=?) AND (? IS NULL OR l.listener_id=?) LIMIT 1`)
      .get(roomId, now, agentId, agentId, hostId, hostId));
  }

  successorBasis(roomId, state, item, memberId, at) {
    const ids = this.store.workClaims.get(roomId, boardClaimId(item.id))?.dependsOn ?? item.dependsOn ?? [];
    if (!ids.length || item.state !== "accepted") return null;
    const parties = this.store.privateWorkParties(roomId, { workIds: [item.id, ...ids] });
    if (outsidePrivateWork(parties.get(item.id), item, memberId)) return null;
    const evidence = [];
    for (const id of ids) {
      const parent = state.workItems[id];
      if (!nativePrerequisiteState(parent, at).satisfied || outsidePrivateWork(parties.get(id), parent, memberId)
        || !boardPrerequisiteState(this.store.workClaims.get(roomId, boardClaimId(id))).satisfied) return null;
      evidence.push([id, parent.receipt.eventId, parent.receipt.evidenceVersion]);
    }
    return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  }

  releaseSuccessors(roomId, before, state, prerequisite, incoming, at) {
    // Normalized writes project selected records, not the room's reverse edges.
    if (!nativePrerequisiteState(prerequisite, at).satisfied
      || nativePrerequisiteState(before.workItems[prerequisite.id], at).satisfied
      || isCurrentRoom(this.db, roomId) || !this.scopedReceiver(roomId, null, at)) return;
    for (const item of Object.values(state.workItems)) {
      if (item.state !== "accepted" || !item.dependsOn?.includes(prerequisite.id)) continue;
      const memberId = item.accountableMemberId;
      const agentId = this.store.identities.identityIdForMember(roomId, memberId);
      if (!agentId || !this.scopedReceiver(roomId, agentId, at)) continue;
      const basis = this.successorBasis(roomId, state, item, memberId, at);
      if (basis) this.emitWork(roomId, state, item, incoming, at, basis);
    }
  }

  emitWork(roomId, state, item, incoming, at, dependencyBasis = null) {
    const id = item.id, next = nextWorkStep(item, at, state.room.ownerId), memberId = next.memberId;
    if (dependencyBasis && (!["start", "claim"].includes(next.action)
      || !workActions(item, state.members[memberId], at).some(([action]) => action === next.action))) return;
    if (!next.needsAttention || !memberId || memberId === incoming.actorId) return;
    // #3345: the consent/permission gates below are designed suppressions;
    // count them so the work store's attempt denominator is complete
    // (before this, a gated work wake vanished without a trace).
    if (!this.permitted(state, item, memberId, incoming.actorId)) {
      recordWakeEvent(this.db, { at, roomId, store: "work",
        event: "suppressed_policy", kind: "work", subjectId: memberId });
      return;
    }
    const nextRead = selectedWorkRead(roomId, next);
    // Successor wakes use the elected pull receiver. A native webhook keeps its
    // original one-event/one-recipient binding to the directly changed item.
    if (!dependencyBasis) this.store.enqueueNativeMcpEvent?.({ roomId, memberId, eventId: incoming.id, actorId: incoming.actorId,
      kind: "work", workItemId: id, workRevision: item.revision, nextRead });
    const agentId = this.store.identities.identityIdForMember(roomId, memberId);
    if (!agentId || !this.optedIn(agentId, roomId)) {
      recordWakeEvent(this.db, { at, roomId, store: "work",
        event: "suppressed_policy", kind: "work", subjectId: agentId ?? memberId });
      return;
    }
    const pointer = { kind: "work", roomId, workItemId: id, workRevision: item.revision,
      action: next.action, completionEventId: next.completionEventId, evidenceVersion: next.evidenceVersion,
      eventId: incoming.id, nextRead, ...(dependencyBasis ? { dependencyBasis } : {}) };
    const eventKey = dependencyBasis
      ? "ready_" + createHash("sha256").update(JSON.stringify([id, item.revision, next.action, dependencyBasis])).digest("hex")
      : incoming.id;
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO agent_work_wakes
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)`)
      .run(`ww_${randomUUID()}`, agentId, roomId, memberId, id, item.revision, eventKey, incoming.actorId, JSON.stringify(pointer), at);
    // #3345: one audited outcome per work-wake attempt (insert = emitted;
    // INSERT OR IGNORE on the (agent, room, event) key = coalesced).
    recordWakeEvent(this.db, { at, roomId, store: "work",
      event: inserted.changes > 0 ? "emitted" : "coalesced", kind: "work", subjectId: agentId });
    // #3262: a genuinely new work signal releases the room-hosted poll
    // waiter, mirroring enqueueWake — otherwise a host parked on the poll
    // door sleeps through the assignment until its wait expires.
    if (inserted.changes > 0 && (!dependencyBasis || !this.store.wakeQueue.pauseStatus(roomId, memberId)))
      this.store.agentHeartbeats?._releaseWakeWaiter(agentId, roomId);
  }
  pending(agentId, { roomId = null, hostId = null, limit = 50, after = null, bounded = false, order = "oldest" } = {}) {
    // Existing hostless callers retain their mention/DM contract. New work delivery
    // requires the reporting host, whose explicit consent is checked below.
    if (!this.available || hostId === null) return bounded ? { signals: [], more: false, through: null } : [];
    const window = bounded ? readWakeWindow(this.db, 'agent_work_wakes', agentId, after, roomId, order) : null;
    const rows = window ? window.rows : this.db.prepare(`SELECT * FROM agent_work_wakes WHERE agent_id=? AND delivered_at IS NULL
      AND invalidated_at IS NULL AND (? IS NULL OR room_id=?)
      AND (? IS NULL OR created_at>? OR (created_at=? AND signal_id>?))
      ORDER BY created_at,signal_id`).all(agentId, roomId, roomId, after?.createdAt ?? null, after?.createdAt ?? 0, after?.createdAt ?? 0, after?.signalId ?? "");
    const result = [], rooms = new Map(), memberships = new Map(), policies = new Map(), now = this.store.now();
    for (const row of rows) {
      if (roomId !== null && row.room_id !== roomId) continue;
      if (!policies.has(row.room_id)) policies.set(row.room_id, { optedIn: this.optedIn(agentId, row.room_id, hostId), members: new Map() });
      const policy = policies.get(row.room_id); if (!policy.optedIn) continue;
      if (!rooms.has(row.room_id)) rooms.set(row.room_id, this.store.room(row.room_id).state);
      const state = rooms.get(row.room_id), item = state.workItems[row.work_item_id];
      const key = JSON.stringify([row.room_id, row.member_id]);
      if (!memberships.has(key)) memberships.set(key, this.store.identities.identityIdForMember(row.room_id, row.member_id));
      if (!policy.members.has(row.member_id)) policy.members.set(row.member_id, { paused: this.store.wakeQueue.pauseStatus(row.room_id, row.member_id), prefs: this.store.attention.prefs(row.room_id, row.member_id) });
      const memberPolicy = policy.members.get(row.member_id);
      if (!item || item.revision !== row.work_revision || !this.permitted(state, item, row.member_id, row.actor_id)
          || memberships.get(key) !== agentId
          || memberPolicy.paused) continue;
      const next = nextWorkStep(item, now, state.room.ownerId);
      const { dependencyBasis, ...pointer } = JSON.parse(row.pointer);
      if (dependencyBasis && (!this.scopedReceiver(row.room_id, agentId, now, hostId)
        || !workActions(item, state.members[row.member_id], now).some(([action]) => action === next.action)
        || this.successorBasis(row.room_id, state, item, row.member_id, now) !== dependencyBasis)) continue;
      if (!next.needsAttention || next.memberId !== row.member_id || next.action !== pointer.action) continue;
      const prefs = memberPolicy.prefs;
      // The digest deadline is anchored, so polling shortly after its hour still delivers.
      if ((heldUntil(prefs, Math.max(row.created_at, prefs?.updatedAt ?? 0)) ?? 0) > now
          || heldUntil(prefs ? { ...prefs, delivery: "immediate" } : null, now) !== null) continue;
      result.push({ signalId: row.signal_id, agentId, ...pointer, createdAt: row.created_at, deliveredAt: null });
      if (result.length >= limit) break;
    }
    return bounded ? { signals: result, more: window.more, through: window.through } : result;
  }
  ack(agentId, signalIds, roomId = null) {
    if (!this.available) return [];
    const acknowledged = [], at = this.store.now();
    const statement = this.db.prepare(`UPDATE agent_work_wakes SET delivered_at=? WHERE agent_id=? AND signal_id=?
      AND delivered_at IS NULL AND invalidated_at IS NULL AND (? IS NULL OR room_id=?)`);
    for (const id of signalIds) if (statement.run(at, agentId, id, roomId, roomId).changes) acknowledged.push(id);
    return acknowledged;
  }
}
