// Explicit host opt-in for pointer-only work delivery on the heartbeat pull path.
// Separate additive tables leave the existing mention/DM journal readable by old hosts.
import { randomUUID } from "node:crypto";
import { nextWorkStep } from "../src/workflow.js";
import { firstBlockedWakeTarget } from "../src/events.js";
import { sessionRecord } from "../src/work-item-session.js";
import { heldUntil } from "./attention.mjs";
import { mutedEvent } from "./moderation.mjs";
import { isGuestAgentMemberId } from "./guest-agent-links.mjs";

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
    this.db.prepare(`UPDATE agent_work_wakes SET invalidated_at=? WHERE room_id=? AND work_item_id=?
      AND work_revision<>? AND invalidated_at IS NULL AND delivered_at IS NULL`).run(at, roomId, id, item.revision);
    const next = nextWorkStep(item, at, state.room.ownerId), memberId = next.memberId;
    if (!next.needsAttention || !memberId || memberId === incoming.actorId || !this.permitted(state, item, memberId, incoming.actorId)) return;
    const agentId = this.store.identities.identityIdForMember(roomId, memberId);
    if (!agentId || !this.optedIn(agentId, roomId)) return;
    const pointer = { kind: "work", roomId, workItemId: id, workRevision: item.revision,
      action: next.action, completionEventId: next.completionEventId, evidenceVersion: next.evidenceVersion,
      eventId: incoming.id, nextRead: { tool: "room_read_work", arguments: { roomId, workItemId: id } } };
    this.db.prepare(`INSERT OR IGNORE INTO agent_work_wakes
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)`)
      .run(`ww_${randomUUID()}`, agentId, roomId, memberId, id, item.revision, incoming.id, incoming.actorId, JSON.stringify(pointer), at);
  }
  pending(agentId, { roomId = null, hostId = null, limit = 50 } = {}) {
    // Existing hostless callers retain their mention/DM contract. New work delivery
    // requires the reporting host, whose explicit consent is checked below.
    if (!this.available || hostId === null) return [];
    const rows = this.db.prepare(`SELECT * FROM agent_work_wakes WHERE agent_id=? AND delivered_at IS NULL
      AND invalidated_at IS NULL AND (? IS NULL OR room_id=?) ORDER BY created_at,signal_id`).all(agentId, roomId, roomId);
    const result = [], rooms = new Map(), now = this.store.now();
    for (const row of rows) {
      if (!this.optedIn(agentId, row.room_id, hostId)) continue;
      if (!rooms.has(row.room_id)) rooms.set(row.room_id, this.store.room(row.room_id).state);
      const state = rooms.get(row.room_id), item = state.workItems[row.work_item_id];
      if (!item || item.revision !== row.work_revision || !this.permitted(state, item, row.member_id, row.actor_id)
          || this.store.identities.identityIdForMember(row.room_id, row.member_id) !== agentId
          || this.store.wakeQueue.pauseStatus(row.room_id, row.member_id)) continue;
      const next = nextWorkStep(item, now, state.room.ownerId), pointer = JSON.parse(row.pointer);
      if (!next.needsAttention || next.memberId !== row.member_id || next.action !== pointer.action) continue;
      const prefs = this.store.attention.prefs(row.room_id, row.member_id);
      // The digest deadline is anchored, so polling shortly after its hour still delivers.
      if ((heldUntil(prefs, Math.max(row.created_at, prefs?.updatedAt ?? 0)) ?? 0) > now
          || heldUntil(prefs ? { ...prefs, delivery: "immediate" } : null, now) !== null) continue;
      result.push({ signalId: row.signal_id, agentId, ...pointer, createdAt: row.created_at, deliveredAt: null });
      if (result.length >= limit) break;
    }
    return result;
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
