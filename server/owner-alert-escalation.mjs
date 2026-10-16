// Owner-alert escalation engine (charter B-3 step 3, PR4): the O2
// disposition. src/owner-alerts.mjs was a complete dispatcher — raise,
// dedupe, dispatch, acknowledge, escalate — orphaned since it shipped:
// nothing ever injected a notifier, so no pending approval anywhere
// escalated (full map orphan O2). The charter's options were wire it as
// the escalation engine behind the aging doctrine, or delete it in the
// same step. This module wires it:
//
//   - Storage: the dispatcher's snapshot persists per room in the
//     additive `owner_alert_state` side table (registered in
//     writer-fence.mjs unfencedAdditiveTables; the snapshot is delivery
//     state, never room content and never a grant).
//   - Notifier: the decision push class (server/human-push.mjs
//     notifyDecision) — counts-only pushes to the room's owner. The
//     alert's title/body live only in the stored snapshot; the push
//     itself carries no content, per the push privacy contract.
//   - Raiser: the attention-aging job calls runOwnerAlertEscalation()
//     after its expiry sweep. Asks the doctrine calls escalated (access
//     requests past their escalation age) raise a warning alert;
//     asks within 24h of lapsing undecided raise a critical one, which
//     the dispatcher's own sweep re-notifies after its 15-minute
//     escalation window while it stays unacknowledged.
//
// Acknowledge/resolve are the owner's acts inside the room; when the
// underlying ask is decided, the aging job resolves matching alerts by
// source, so the alert queue cannot drift from the ask stores (the
// stores themselves are never merged or mutated by this module beyond
// the alert snapshot table).

import { createOwnerAlertDispatcher } from "../src/owner-alerts.mjs";
import { classifyAsk, escalatedAccessRequests } from "./attention-aging.mjs";

export const ownerAlertStateSchema = `
  CREATE TABLE IF NOT EXISTS owner_alert_state (
    room_id TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const CRITICAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function storageFor(store, roomId) {
  const db = store.db;
  db.exec(ownerAlertStateSchema);
  return {
    load() {
      const row = db.prepare("SELECT snapshot_json FROM owner_alert_state WHERE room_id=?").get(roomId);
      if (!row) return null;
      try { return JSON.parse(row.snapshot_json); } catch { return null; }
    },
    save(snapshot) {
      db.prepare(`INSERT INTO owner_alert_state (room_id, snapshot_json, updated_at) VALUES (?,?,?)
        ON CONFLICT(room_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at`)
        .run(roomId, JSON.stringify(snapshot), store.now());
    }
  };
}

// Build the room's dispatcher with production wiring. `alertId` is
// deterministic per (room, ask) so restarts re-raise nothing: the
// dispatcher's own dedupe (same source+title inside its window) plus
// the persisted snapshot carry continuity.
export function ownerAlertDispatcherFor(store, roomId) {
  const state = store.room(roomId)?.state;
  const ownerId = state?.room?.ownerId ?? null;
  const notifier = {
    async notify() {
      // Counts-only: how many alerts are live for this room right now
      // is computed by the caller-facing dispatcher state at send time;
      // here we push the room's waiting-decision count as the number of
      // pending access asks plus one for this alert's ask.
      const pending = store.db.prepare(
        "SELECT COUNT(*) AS n FROM access_requests WHERE room_id=? AND status IN ('pending','pending_upgrade')"
      ).get(roomId)?.n ?? 1;
      store.humanPush?.notifyDecision({
        roomId,
        state: store.room(roomId).state,
        memberId: ownerId,
        count: Math.max(1, pending)
      });
    }
  };
  let counter = 0;
  return createOwnerAlertDispatcher({
    clock: () => store.now(),
    id: () => `oa_${roomId}_${(counter += 1)}_${store.now()}`,
    notifier,
    storage: storageFor(store, roomId)
  });
}

const alertSource = requestId => `access_request:${requestId}`;

// One escalation tick for one room. Raises alerts for escalated access
// asks, resolves alerts whose ask is no longer pending, and runs the
// dispatcher's critical-escalation sweep. Returns what it did so the
// job can report it. Every dispatcher failure is caught per phase: an
// alerting failure must never fail the aging job's expiry sweep.
export async function runOwnerAlertEscalation(store, roomId, { now = Date.now() } = {}) {
  const out = { raised: 0, dispatched: 0, resolved: 0, escalated: 0, errors: 0 };
  if (!store?.db?.prepare || !store.humanPush) return out;
  let dispatcher;
  try { dispatcher = ownerAlertDispatcherFor(store, roomId); }
  catch { return { ...out, errors: 1 }; }

  const escalated = escalatedAccessRequests(store.db, { now, roomId });
  const liveSources = new Set();
  for (const ask of escalated) {
    const source = alertSource(ask.requestId);
    liveSources.add(source);
    const verdict = classifyAsk({ family: "access_request", createdAt: ask.createdAt, now });
    const critical = verdict.msToExpiry != null && verdict.msToExpiry <= CRITICAL_WINDOW_MS;
    const title = critical ? "Access request lapses within a day" : "Access request waiting";
    const existing = dispatcher.list({}).find(alert => alert.source === source && alert.state !== "resolved");
    try {
      const alert = existing ?? dispatcher.raise({
        severity: critical ? "critical" : "warning",
        title,
        body: `An access request in this room has waited about ${Math.round(verdict.ageMs / 3600000)}h undecided. ${verdict.consequence}.`,
        source
      }, "attention-aging");
      if (!existing) out.raised += 1;
      if (alert.state === "pending") {
        await dispatcher.dispatch(alert.id, "attention-aging");
        out.dispatched += 1;
      }
    } catch { out.errors += 1; }
  }

  // Resolve alerts whose ask was decided or lapsed since the last tick:
  // the alert queue mirrors the ask store, never the other way round.
  for (const alert of dispatcher.list({})) {
    if (alert.state === "resolved") continue;
    if (typeof alert.source === "string" && alert.source.startsWith("access_request:") && !liveSources.has(alert.source)) {
      try { dispatcher.resolve(alert.id, "attention-aging", "ask no longer pending"); out.resolved += 1; }
      catch { out.errors += 1; }
    }
  }

  try { out.escalated = (await dispatcher.sweep("attention-aging")).length; }
  catch { out.errors += 1; }
  return out;
}

// Rooms present in this store: the DO runtime holds one room per store,
// the Node runtime holds many; the escalation tick is per room either
// way, enumerated from the rooms table the store already keeps.
export function roomsWithEscalatedAsks(store, { now = Date.now() } = {}) {
  if (!store?.db?.prepare) return [];
  const roomIds = new Set(escalatedAccessRequests(store.db, { now }).map(row => row.roomId));
  // A room with live alerts but no currently-escalated ask still needs a
  // tick so its alerts resolve instead of lingering.
  try {
    for (const row of store.db.prepare("SELECT room_id FROM owner_alert_state").all()) roomIds.add(row.room_id);
  } catch { /* table absent until the first dispatcher is built */ }
  return [...roomIds];
}
