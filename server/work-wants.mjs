// BOARD-WAKE-2: opt-in "new ready work" wake. An agent member may set
// wantsWork { labels, capabilities } for itself in a room. When a Board item
// is created unassigned, or released back to unclaimed, every opted-in agent
// whose filter matches gets one wake with reason ready_work, at most once per
// 10 minutes. Matches inside that window fold into the earlier wake (counted
// in foldedSinceWake); the agent sees them when it reads the Board.
//
// Default off: no row, no wake. labels match the item's tags (any overlap);
// capabilities match the item's kind (work, land or deploy). An empty list
// matches everything on that axis. The row is a preference only; the wake
// goes through enqueueClaimWake, so pause, a read-only tier and room trust
// skip it exactly as they skip an assignment wake.
//
// agent_wants_work is additive and unfenced (server/writer-fence.mjs): older
// writers have no code path to it, and a missing row means "off".
import { enqueueClaimWake } from "./work-claim-events.mjs";
import { readyClaims } from "./claim-coordination.mjs";

export const WANTS_WORK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_wants_work (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL,
    labels TEXT NOT NULL, capabilities TEXT NOT NULL,
    last_wake_at INTEGER, folded INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,member_id)
  );`;

export const WANTS_WORK_WINDOW_MS = 10 * 60 * 1000;
export const WANTS_WORK_KINDS = Object.freeze(["work", "land", "deploy"]);
const MAX_ENTRIES = 16;
const LABEL = /^[a-z0-9][a-z0-9._:-]{0,39}$/;

export class WantsWorkInputError extends Error {
  constructor(message) { super(message); this.code = "invalid_request"; }
}

function listOf(value, field, allowed = null) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) {
    throw new WantsWorkInputError(`${field} must be a list of at most ${MAX_ENTRIES} entries`);
  }
  const out = [];
  for (const entry of value) {
    const normalized = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!LABEL.test(normalized)) throw new WantsWorkInputError(`${field} entries are 1 to 40 characters of a-z, 0-9, ".", "_", ":" or "-"`);
    if (allowed && !allowed.includes(normalized)) throw new WantsWorkInputError(`${field} entries are one of ${allowed.join(", ")}`);
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function normalizeWantsWork(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => key !== "labels" && key !== "capabilities")) {
    throw new WantsWorkInputError("Send { labels?, capabilities? }");
  }
  return {
    labels: listOf(input.labels, "labels"),
    capabilities: listOf(input.capabilities, "capabilities", WANTS_WORK_KINDS)
  };
}

const parseList = text => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter(entry => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

const view = row => row ? {
  wantsWork: { labels: parseList(row.labels), capabilities: parseList(row.capabilities) },
  lastWakeAt: row.last_wake_at == null ? null : new Date(row.last_wake_at).toISOString(),
  foldedSinceWake: row.folded
} : { wantsWork: null, lastWakeAt: null, foldedSinceWake: 0 };

export function readWantsWork(db, roomId, memberId) {
  return view(db.prepare("SELECT * FROM agent_wants_work WHERE room_id=? AND member_id=?").get(roomId, memberId));
}

export function setWantsWork(db, roomId, memberId, input, now) {
  const value = normalizeWantsWork(input);
  db.prepare(`INSERT INTO agent_wants_work (room_id,member_id,labels,capabilities,last_wake_at,folded,updated_at)
    VALUES(?,?,?,?,NULL,0,?)
    ON CONFLICT(room_id,member_id) DO UPDATE SET labels=excluded.labels, capabilities=excluded.capabilities, updated_at=excluded.updated_at`)
    .run(roomId, memberId, JSON.stringify(value.labels), JSON.stringify(value.capabilities), now);
  return readWantsWork(db, roomId, memberId);
}

export function clearWantsWork(db, roomId, memberId) {
  db.prepare("DELETE FROM agent_wants_work WHERE room_id=? AND member_id=?").run(roomId, memberId);
  return readWantsWork(db, roomId, memberId);
}

export function wantsWorkMatches(pref, item) {
  const tags = (item?.tags ?? []).map(tag => String(tag).toLowerCase());
  const labelsOk = pref.labels.length === 0 || pref.labels.some(label => tags.includes(label));
  const kind = item?.kind ?? "work";
  const capabilitiesOk = pref.capabilities.length === 0 || pref.capabilities.includes(kind);
  return labelsOk && capabilitiesOk;
}

// The ready-queue predicate for one item: unclaimed, ownerless, every
// dependency done. Reuses readyClaims from server/claim-coordination.mjs so
// the wake path and the queue=ready board view agree on what "ready" means.
export function claimIsReady(items, item) {
  if (!item || typeof item.id !== "string") return false;
  return readyClaims(items).some(entry => entry.id === item.id);
}

// A done transition unblocks dependents: wake opted-in agents about every
// unclaimed, ownerless dependent whose dependencies are all done now. Only
// items naming the completed claim in dependsOn can have become ready —
// nothing else changed — so the scan is limited to those. Never throws:
// like noteReadyWork, a preference problem must not roll back the Board.
export function noteDependentsReady(store, registry, roomId, item, { actorId = null, now } = {}) {
  if (!item || item.state !== "done") return [];
  let items = [];
  try { items = registry.list(roomId); } catch { return []; }
  const ready = new Set(readyClaims(items).map(entry => entry.id));
  const woken = [];
  for (const entry of items) {
    if (!entry || entry.id === item.id) continue;
    if (!ready.has(entry.id)) continue;
    if (!Array.isArray(entry.dependsOn) || !entry.dependsOn.includes(item.id)) continue;
    try {
      woken.push(...noteReadyWork(store, roomId, entry, { actorId, now }));
    } catch (error) {
      console.error("dependents-ready wake failed:", error?.message ?? error);
    }
  }
  return woken;
}

// Called inside the claim transaction after a created (unassigned) or
// released item commits. Never throws: a preference problem must not roll
// back the Board write. Returns the member ids that were woken.
export function noteReadyWork(store, roomId, item, { actorId = null, now } = {}) {
  if (!item || item.state !== "unclaimed" || item.owner) return [];
  let rows;
  try {
    rows = store.db.prepare("SELECT * FROM agent_wants_work WHERE room_id=? ORDER BY member_id").all(roomId);
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  let members = {};
  try { members = store.roomAuthority?.(roomId)?.members ?? {}; } catch { /* room unread */ }
  const at = Number.isFinite(now) ? now : Date.now();
  const woken = [];
  for (const row of rows) {
    const member = members[row.member_id];
    if (!member || member.kind !== "agent" || member.active === false || row.member_id === actorId) continue;
    const pref = { labels: parseList(row.labels), capabilities: parseList(row.capabilities) };
    if (!wantsWorkMatches(pref, item)) continue;
    try {
      if (row.last_wake_at != null && at - row.last_wake_at < WANTS_WORK_WINDOW_MS) {
        store.db.prepare("UPDATE agent_wants_work SET folded=folded+1 WHERE room_id=? AND member_id=?").run(roomId, row.member_id);
        continue;
      }
      const result = enqueueClaimWake(store, roomId, row.member_id, `work-claim:${item.id}:ready_work:${at}`,
        { reason: "ready_work", actorId });
      if (result?.enqueued) {
        store.db.prepare("UPDATE agent_wants_work SET last_wake_at=?, folded=0 WHERE room_id=? AND member_id=?").run(at, roomId, row.member_id);
        woken.push(row.member_id);
      }
    } catch (error) {
      console.error("ready-work wake failed:", error?.message ?? error);
    }
  }
  return woken;
}
