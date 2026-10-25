// Agents that answer while their owner is away.
//
// A registered host already receives mention and DM wakes, including after
// the host goes stale. An agent with only an agent.wake subscription and
// no host was skipped: wakeIfOffline refuses to enqueue when no host has
// ever registered, and the callers then skip the webhook ping.
//
// ROOM_OWNER_ASLEEP_WAKE (default off) fills that gap for dm and mention.
// The same flag's dispatch tick journals a ping for a signal that was
// queued without one (a subscription that arrived later, or a ping that
// never started). Webhook retries of an existing delivery are unchanged.

import { WAKE_PING_EVENT } from "./outbound-webhooks.mjs";
import { activeMemberIdForWakeIdentity } from "./wake-identity-resolution.mjs";

const FLAG = "ROOM_OWNER_ASLEEP_WAKE";
const DAY_MS = 24 * 60 * 60 * 1000;
const SLEEPER_KINDS = new Set(["dm", "mention"]);

function flagRaw(store) {
  const env = store && Object.prototype.hasOwnProperty.call(store, "featureEnv")
    ? (store.featureEnv ?? {})
    : process.env;
  return String(env?.[FLAG] ?? "").trim().toLowerCase();
}

// on/1/true covers every room. A comma-separated list covers those rooms.
// A null roomId asks whether the flag is armed at all (the dispatch gate).
export function sleeperWakeEnabled(store, roomId) {
  const raw = flagRaw(store);
  if (raw === "on" || raw === "1" || raw === "true") return true;
  if (raw === "" || raw === "off" || raw === "0" || raw === "false") return false;
  const rooms = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (roomId == null) return rooms.length > 0;
  return rooms.includes(String(roomId).trim().toLowerCase());
}

function missingTable(error) {
  return /no such (table|column)/i.test(String(error?.message ?? ""));
}

function hasWakeSubscription(store, identityId) {
  if (!store?.db?.prepare || typeof identityId !== "string" || identityId.length === 0) return false;
  let rows = [];
  try {
    rows = store.db.prepare(
      "SELECT events_json AS eventsJson FROM agent_webhook_subs WHERE agent_id=? AND enabled=1"
    ).all(identityId);
  } catch (error) {
    if (missingTable(error)) return false;
    throw error;
  }
  for (const row of rows) {
    let events = null;
    try { events = JSON.parse(row.eventsJson); } catch { continue; }
    if (!Array.isArray(events)) continue;
    if (events.includes(WAKE_PING_EVENT) || events.includes("*")) return true;
  }
  return false;
}

function roomFilter(store) {
  const raw = flagRaw(store);
  if (raw === "on" || raw === "1" || raw === "true") return { sql: "", params: [] };
  const rooms = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (rooms.length === 0) return null;
  return {
    sql: ` AND lower(s.room_id) IN (${rooms.map(() => "?").join(",")})`,
    params: rooms,
  };
}

function nowOf(store, now) {
  if (Number.isFinite(now)) return now;
  const clock = typeof store?.now === "function" ? Number(store.now()) : Date.now();
  return Number.isFinite(clock) ? clock : Date.now();
}

// Pending dm/mention signals in covered rooms, newest subscription required,
// any existing agent.wake delivery excluded (pending, failed, or dead).
function selectMissedWakes(store, now, limit) {
  if (!sleeperWakeEnabled(store, null) || !store?.db?.prepare) return [];
  const coverage = roomFilter(store);
  if (!coverage) return [];
  try {
    return store.db.prepare(`SELECT s.signal_id AS signalId, s.agent_id AS agentId, s.kind AS kind,
        s.room_id AS roomId, s.message_id AS messageId, s.created_at AS createdAt
      FROM agent_wake_signals s
      WHERE s.delivered_at IS NULL AND s.kind IN ('dm','mention') AND s.created_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_webhook_deliveries d
          WHERE d.event_id = s.signal_id AND d.event_type = ?
        )
        AND EXISTS (
          SELECT 1 FROM agent_webhook_subs w
          WHERE w.agent_id = s.agent_id AND w.enabled = 1
            AND (instr(w.events_json, '"agent.wake"') > 0 OR instr(w.events_json, '"*"') > 0)
        )
        ${coverage.sql}
      ORDER BY s.created_at, s.signal_id LIMIT ?`)
      .all(nowOf(store, now) - DAY_MS, WAKE_PING_EVENT, ...coverage.params, limit);
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

function deliverable(store, row) {
  if (!row?.signalId || !SLEEPER_KINDS.has(row.kind)) return false;
  if (!sleeperWakeEnabled(store, row.roomId)) return false;
  if (store.agentPlugin?.identityRevoked?.(row.agentId)) return false;
  if (row.roomId && !activeMemberIdForWakeIdentity(store, row.roomId, row.agentId)) return false;
  return hasWakeSubscription(store, row.agentId);
}

// When the next dispatch should run to journal a missed wake. Null keeps
// the job idle so an armed flag with nothing waiting does not look stale.
export function missedWakeDueAt(store, now) {
  for (const row of selectMissedWakes(store, now, 20)) {
    if (deliverable(store, row)) return Number(row.createdAt);
  }
  return null;
}

// Same result as wakeIfOffline when that already woke the agent, the flag
// is off, or the agent has no wake subscription. Otherwise queue the signal
// so the caller journals one ping. Does not deliver; the caller does.
export function wakeForAgent(store, { agentId, kind, roomId, messageId }) {
  const first = store.agentHeartbeats.wakeIfOffline({ agentId, kind, roomId, messageId });
  if (first.woken || !SLEEPER_KINDS.has(kind)) return first;
  if (!sleeperWakeEnabled(store, roomId) || !hasWakeSubscription(store, agentId)) return first;
  const { enqueued, signal } = store.agentHeartbeats.enqueueWake({ agentId, kind, roomId, messageId });
  return { woken: Boolean(signal), enqueued, signal };
}

export function catchUpMissedWakes(store, { limit = 20, now } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : 20;
  let replayed = 0;
  for (const row of selectMissedWakes(store, now, cap)) {
    if (!deliverable(store, row)) continue;
    const result = store.agentPlugin.deliverWakePing({
      identityId: row.agentId,
      signal: { signalId: row.signalId, kind: row.kind, roomId: row.roomId, messageId: row.messageId },
    });
    if (result?.deliveries?.length > 0) replayed += 1;
  }
  return { replayed };
}
