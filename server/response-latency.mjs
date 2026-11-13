// Response latency: one bounded, derived read of "who answers whom, how fast,
// and what was dropped". Nothing here is a new store. The Room journal already
// is the typed, timestamped event log (events: sequence, type, actorId, at,
// data); mention_states/mention_observations already carry delivered, ack and
// responded stamps. This module reads the journal tail once, pairs each
// request-shaped event with its first answer by the addressed member, and
// aggregates per direction (from -> to) and context.
//
// Contexts and their request -> answer pairs (all from existing event types):
//   mention  public message with @name           -> responded (mention_observations)
//   dm       first unanswered private message    -> first private message back
//   request  message.posted requestKind          -> message.posted responseToRequestId
//            (ack = reply_request.progressed by the recipient; the 10 s ack window)
//   work     work.proposed (accountableMemberId) -> first event by that member on the item
//   handoff  work.handoff_recorded               -> first event by the triage member on the item
//
// "Dropped" means an unanswered request older than its SLA (or a mention whose
// own deadline passed). Late means answered, but after the SLA. SLAs are
// measurement thresholds, not policy: they only decide the label.
//
// The idea (every action is a typed event; the more event types, the more the
// log can tell its members) is shared with Buzz (block/buzz, Apache-2.0); no
// Buzz source is copied here. See docs/TYPED-EVENTS.md. (The hash-chained
// room_signal_log that feeds `wake` is the one close port: server/signal-log.mjs.)
import { ownMember } from "../src/events.js";
import { ACK_WINDOW_MS } from "./request-states.mjs";
import { readReceiptSignals } from "./receipt-signals.mjs";
import { isCurrentRoom, currentRoomOwnerAuthority, readCurrentRecord, withCurrentReadContext } from "./current-room-repository.mjs";

export const LATENCY_VERSION = 1;
export const LATENCY_MAX_BYTES = 6144;
// One call reads at most this many journal rows (plus one indexed probe per
// message for mention rows). Daily Durable Object rows_read is the scarce
// budget, so the window is fixed and the result is memoized per head.
export const LATENCY_SCAN_EVENTS = 1500;
export const LATENCY_MEMO_MS = 60_000;
// Wake context: the last rows of room_signal_log (primary-key range, one read).
export const LATENCY_WAKE_SCAN = 600;
const WAKE_GROUP = Object.freeze({ mention: "message", dm: "message", assignment: "work", ask: "work", land: "work", bond: "work" });
const MIN = 60_000;
export const LATENCY_SLA_MS = Object.freeze({ mention: 30 * MIN, dm: 30 * MIN, request: 30 * MIN, work: 60 * MIN, handoff: 60 * MIN });
export const LATENCY_CONTEXTS = Object.freeze(Object.keys(LATENCY_SLA_MS));
export const LATENCY_ACK_WINDOW_MS = ACK_WINDOW_MS;
const CAPS = Object.freeze({ pairs: 12, dropped: 8, waiting: 6 });

const clip = (text, n) => {
  if (typeof text !== "string") return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const stamp = value => { const t = typeof value === "number" ? value : Date.parse(value); return Number.isFinite(t) ? t : null; };
// Nearest-rank percentile over a sorted array.
export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const WORK_ACTIVITY = type => typeof type === "string" && (type.startsWith("work.") || type.startsWith("claim.") || type === "work_claim.updated" || type === "verification.recorded" || type === "owner.decision_recorded");

// Pure. events: journal rows ascending by seq, already restricted to what the
// viewer may see: { seq, id, type, actorId, at, toId, messageId, requestKind,
// responseTo, requestMessageId, progress, workItemId, accountableId }.
// mentions: { eventId, memberId, state, createdAt, timeoutAt, decidedAt, ackAt, respondedAt }.
export function collectLatencyItems({ events, mentions = [], ownerId = null, now }) {
  const items = [];
  const open = (ctx, from, to, at, ref, extra = {}) => {
    const item = { ctx, from, to, at, ref, ackAt: null, replyAt: null, cancelled: false, sla: LATENCY_SLA_MS[ctx], ...extra };
    items.push(item);
    return item;
  };
  const dmOpen = new Map(); // "S>R" -> open anchor
  const requests = new Map(); // request message id -> item
  const works = new Map(); // workItemId -> [items awaiting activity by `to`]
  const byEvent = new Map(events.map(e => [e.id, e]));
  for (const e of events) {
    const t = stamp(e.at);
    if (t === null || typeof e.actorId !== "string") continue;
    if (e.type === "message.posted") {
      if (e.responseTo && requests.has(e.responseTo)) {
        const item = requests.get(e.responseTo);
        if (item.to === e.actorId && item.replyAt === null) item.replyAt = t;
        continue;
      }
      if (e.requestKind && e.toId && e.toId !== e.actorId) {
        const id = e.messageId ?? e.id;
        requests.set(id, open("request", e.actorId, e.toId, t, id));
        continue;
      }
      if (e.toId && e.toId !== e.actorId) {
        // A private message that answers an open one never opens a new
        // request: otherwise "done, thanks" would start a clock on its asker.
        const back = dmOpen.get(`${e.toId}>${e.actorId}`);
        if (back) { back.replyAt = t; dmOpen.delete(`${e.toId}>${e.actorId}`); continue; }
        const key = `${e.actorId}>${e.toId}`;
        if (!dmOpen.has(key)) dmOpen.set(key, open("dm", e.actorId, e.toId, t, e.messageId ?? e.id));
      }
      continue;
    }
    if (e.type === "reply_request.progressed" && requests.has(e.requestMessageId)) {
      const item = requests.get(e.requestMessageId);
      if (item.to === e.actorId && item.ackAt === null) item.ackAt = t;
      continue;
    }
    if (e.type === "reply_request.cancelled" && requests.has(e.requestMessageId)) {
      const item = requests.get(e.requestMessageId);
      if (item.from === e.actorId) item.cancelled = true;
      continue;
    }
    if (typeof e.workItemId === "string" && e.workItemId) {
      // Any later work-shaped event by the addressed member answers the clock.
      const waiting = works.get(e.workItemId);
      if (waiting && WORK_ACTIVITY(e.type)) {
        for (const item of waiting) if (item.replyAt === null && item.to === e.actorId && item.at <= t && item.seq < e.seq) item.replyAt = t;
      }
      if (e.type === "work.proposed" && typeof e.accountableId === "string" && e.accountableId !== e.actorId) {
        const item = open("work", e.actorId, e.accountableId, t, e.workItemId, { seq: e.seq });
        works.set(e.workItemId, [...(works.get(e.workItemId) ?? []), item]);
      } else if (e.type === "work.handoff_recorded") {
        const to = typeof e.toId === "string" && e.toId ? e.toId : ownerId;
        if (typeof to === "string" && to !== e.actorId) {
          const item = open("handoff", e.actorId, to, t, e.workItemId, { seq: e.seq });
          works.set(e.workItemId, [...(works.get(e.workItemId) ?? []), item]);
        }
      }
    }
  }
  // Mentions: public messages only. Private messages are the dm context, and a
  // mention row on one must not appear twice or leak to a non-party.
  for (const m of mentions) {
    const e = byEvent.get(m.eventId);
    if (!e || e.toId || e.type !== "message.posted" || e.actorId === m.memberId) continue;
    const replyAt = m.respondedAt ?? (m.state === "responded" ? m.decidedAt : null);
    const expired = !replyAt && (m.state === "timed_out" || (Number.isFinite(m.timeoutAt) && m.timeoutAt <= now && m.state !== "responded"));
    const item = open("mention", e.actorId, m.memberId, m.createdAt ?? stamp(e.at), e.messageId ?? e.id,
      { ackAt: m.ackAt ?? null, replyAt: replyAt ?? null, deadlineMissed: expired });
    if (Number.isFinite(m.timeoutAt) && Number.isFinite(item.at) && m.timeoutAt > item.at) item.sla = m.timeoutAt - item.at;
  }
  return items;
}

const statusOf = (item, now) => {
  if (item.cancelled) return "cancelled";
  if (item.replyAt !== null) return "answered";
  return item.deadlineMissed || now - item.at > item.sla ? "dropped" : "waiting";
};

// Pure. rows: room_signal_log rows { type, ts_ms, detail } newest first. Counts
// only, grouped (message = mention+dm, work = assignment/ask/land/bond) and
// without targets, so a private DM wake does not name anyone to other viewers.
// acked with door "cron" is the stale prune: expired unhandled, not an answer.
export function buildWakeContext(rows, { scan = LATENCY_WAKE_SCAN } = {}) {
  if (!rows?.length) return null;
  const read = rows.length;
  const groups = {};
  rows = rows.filter(row => typeof row.type === "string" && (row.type.startsWith("wake.") || row.type === "turn.completed")); // receipts share the table
  if (!rows.length) return null;
  const turns = { completed: 0, silent: 0, unknown: 0 };
  for (const row of rows) {
    let d = {};
    try { d = JSON.parse(row.detail ?? "{}"); } catch { /* counts still hold */ }
    if (row.type === "turn.completed") { turns.completed += 1; if (d.rp === 0) turns.silent += 1; else if (d.rp !== 1) turns.unknown += 1; continue; }
    const group = WAKE_GROUP[d.k] ?? "other";
    const g = groups[group] ?? (groups[group] = { sent: 0, delivered: 0, acked: 0, expired: 0, dropped: 0, deliverMs: [], ackMs: [] });
    if (row.type === "wake.sent") g.sent += 1;
    else if (row.type === "wake.delivered") { g.delivered += 1; if (Number.isFinite(d.lat)) g.deliverMs.push(d.lat); }
    else if (row.type === "wake.acked") {
      if (d.d === "cron") g.expired += 1; else { g.acked += 1; if (Number.isFinite(d.lat)) g.ackMs.push(d.lat); }
    } else if (row.type === "wake.dropped") g.dropped += 1;
  }
  const out = {};
  for (const [name, g] of Object.entries(groups)) {
    const { deliverMs, ackMs, ...counts } = g;
    deliverMs.sort((a, b) => a - b); ackMs.sort((a, b) => a - b);
    out[name] = { ...counts, deliverP50Ms: percentile(deliverMs, 50), ackP50Ms: percentile(ackMs, 50), ackP90Ms: percentile(ackMs, 90) };
  }
  return { rows: rows.length, since: iso(rows.at(-1).ts_ms), complete: read < scan, ...(turns.completed ? { turns } : {}), ...out };
}

// Pure. receipts: readReceiptSignals output (newest first). Merge -> prod smoke:
// a merge ships at the first good PROD DEPLOY posted after it. Reports shipped /
// pending counts, the oldest pending age, merge-to-prod p50/p90 and how the latest
// deploy ended. Counts only what the typed receipts hold (the window is honest).
export function buildShipContext(receipts, nowMs) {
  if (!receipts?.length) return null;
  const asc = [...receipts].sort((a, b) => a.seq - b.seq);
  const merges = asc.filter(r => r.parsed.kind === "merged");
  const deploys = asc.filter(r => r.parsed.kind === "deploy");
  if (!merges.length && !deploys.length) return null;
  const okDeploys = deploys.filter(r => r.parsed.smoke === "ok");
  const lat = [];
  let pending = 0, oldest = null;
  for (const m of merges) {
    const d = okDeploys.find(x => x.seq > m.seq);
    if (d) lat.push(Math.max(0, Date.parse(d.at) - Date.parse(m.at)));
    else { pending += 1; const t = Date.parse(m.at); if (oldest === null || t < oldest) oldest = t; }
  }
  lat.sort((a, b) => a - b);
  const last = deploys.at(-1);
  return { merged: merges.length, shipped: lat.length, pending, ...(oldest !== null ? { oldestPendingMin: Math.max(0, Math.round((nowMs - oldest) / MIN)) } : {}),
    mergeToProdP50Ms: percentile(lat, 50), mergeToProdP90Ms: percentile(lat, 90), lastDeploy: last ? last.parsed.smoke : "none" };
}

export function buildResponseLatency({ roomId, viewerId, ownerId = null, now, through, window, events, mentions = [], members = {}, wake = null, ship = null }) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const name = id => (id == null ? null : clip(ownMember(members, id)?.displayName, 24) ?? String(id).slice(0, 12));
  const items = collectLatencyItems({ events, mentions, ownerId, now: nowMs });
  const groups = new Map();
  const totals = Object.fromEntries(LATENCY_CONTEXTS.map(c => [c, { n: 0, answered: 0, waiting: 0, dropped: 0, late: 0, replyMs: [] }]));
  let cancelled = 0;
  const droppedRows = [], waitingRows = [];
  for (const item of items) {
    const status = statusOf(item, nowMs);
    if (status === "cancelled") { cancelled += 1; continue; }
    const latency = status === "answered" ? Math.max(0, item.replyAt - item.at) : null;
    const late = latency !== null && latency > item.sla;
    const key = `${item.from}\u0000${item.to}\u0000${item.ctx}`;
    const g = groups.get(key) ?? { from: item.from, to: item.to, ctx: item.ctx, n: 0, answered: 0, waiting: 0, dropped: 0, late: 0, replyMs: [], ackMs: [], unacked: 0 };
    groups.set(key, g);
    const t = totals[item.ctx];
    for (const x of [g, t]) { x.n += 1; x[status] += 1; if (late) x.late += 1; if (latency !== null) x.replyMs.push(latency); }
    if (item.ctx === "request" || item.ctx === "mention") {
      if (item.ackAt !== null) g.ackMs.push(Math.max(0, item.ackAt - item.at));
      if (item.ctx === "request" && (item.ackAt === null ? nowMs - item.at > LATENCY_ACK_WINDOW_MS : item.ackAt - item.at > LATENCY_ACK_WINDOW_MS)) g.unacked += 1;
    }
    if (status === "dropped") droppedRows.push({ ctx: item.ctx, from: item.from, to: item.to, ref: item.ref, at: item.at });
    if (status === "waiting") waitingRows.push({ ctx: item.ctx, from: item.from, to: item.to, ref: item.ref, at: item.at });
  }
  const stats = list => { list.sort((a, b) => a - b); return { p50Ms: percentile(list, 50), p90Ms: percentile(list, 90), maxMs: list.length ? list[list.length - 1] : null }; };
  const pairRows = [...groups.values()].map(g => {
    const { p50Ms, p90Ms, maxMs } = stats(g.replyMs);
    const row = { from: name(g.from), to: name(g.to), ctx: g.ctx, n: g.n, answered: g.answered, waiting: g.waiting, dropped: g.dropped, late: g.late, p50Ms, p90Ms, maxMs };
    if (g.ackMs.length) row.ackP50Ms = stats(g.ackMs).p50Ms;
    if (g.unacked) row.unacked = g.unacked;
    row._k = [g.dropped, g.late, g.waiting, p90Ms ?? 0, `${g.from}${g.to}${g.ctx}`];
    return row;
  }).sort((a, b) => b._k[0] - a._k[0] || b._k[1] - a._k[1] || b._k[2] - a._k[2] || b._k[3] - a._k[3] || (a._k[4] < b._k[4] ? -1 : 1));
  const byAge = (a, b) => a.at - b.at || (a.ref < b.ref ? -1 : 1);
  const shape = r => ({ ctx: r.ctx, from: name(r.from), to: name(r.to), ref: String(r.ref).slice(0, 64), ageMin: Math.max(0, Math.round((nowMs - r.at) / MIN)) });
  droppedRows.sort(byAge); waitingRows.sort(byAge);
  const state = {
    contractVersion: LATENCY_VERSION, roomId, viewerId, through, evaluatedAt: iso(nowMs), untrusted: true,
    window: window ?? null,
    slaMinutes: Object.fromEntries(LATENCY_CONTEXTS.map(c => [c, LATENCY_SLA_MS[c] / MIN])), ackWindowSec: LATENCY_ACK_WINDOW_MS / 1000,
    totals: Object.fromEntries(LATENCY_CONTEXTS.map(c => { const { replyMs, ...rest } = totals[c]; return [c, { ...rest, ...stats(replyMs) }]; })),
    cancelled,
    pairs: pairRows.slice(0, CAPS.pairs).map(({ _k, ...row }) => row),
    dropped: droppedRows.slice(0, CAPS.dropped).map(shape),
    waiting: waitingRows.slice(0, CAPS.waiting).map(shape),
    ...(wake ? { wake } : {}),
    ...(ship ? { ship } : {}),
    truncated: {}
  };
  const shed = { pairs: pairRows.length - state.pairs.length, dropped: droppedRows.length - state.dropped.length, waiting: waitingRows.length - state.waiting.length };
  for (const [k, v] of Object.entries(shed)) if (v > 0) state.truncated[k] = v;
  const size = () => Buffer.byteLength(JSON.stringify(state));
  for (const key of ["waiting", "pairs", "dropped"]) {
    while (size() > LATENCY_MAX_BYTES && state[key].length > 1) { state[key].pop(); state.truncated[key] = (state.truncated[key] ?? 0) + 1; }
  }
  return state;
}

// One short line for room_project_state: how many requests are dropped / waiting /
// late right now, the worst pair, and the median wake ack. Same numbers as the
// full read (it is derived from it), so the two can never disagree.
export function latencyLine(doc) {
  if (!doc?.totals) return null;
  let dropped = 0, waiting = 0, late = 0;
  for (const t of Object.values(doc.totals)) { dropped += t.dropped ?? 0; waiting += t.waiting ?? 0; late += t.late ?? 0; }
  const w = doc.pairs?.find(p => p.dropped > 0 || p.waiting > 0);
  return { dropped, waiting, late,
    ...(w ? { worst: `${w.from} -> ${w.to} (${w.ctx}): ${w.dropped} dropped, ${w.waiting} waiting` } : {}),
    ...(doc.wake?.message?.ackP50Ms != null ? { wakeAckP50Ms: doc.wake.message.ackP50Ms } : {}),
    ...(doc.wake?.turns?.silent ? { silentTurns: doc.wake.turns.silent } : {}),
    ...(doc.ship?.pending ? { unshipped: doc.ship.pending, oldestUnshippedMin: doc.ship.oldestPendingMin } : {}),
    see: "room_response_latency" };
}

const memos = new WeakMap();
const EVENT_SQL = `SELECT sequence AS seq, id, json_extract(body,'$.type') AS type, json_extract(body,'$.actorId') AS actorId, json_extract(body,'$.at') AS at,
    json_extract(body,'$.data.toMemberId') AS toId, json_extract(body,'$.data.messageId') AS messageId, json_extract(body,'$.data.requestKind') AS requestKind,
    json_extract(body,'$.data.responseToRequestId') AS responseTo, json_extract(body,'$.data.requestMessageId') AS requestMessageId,
    json_extract(body,'$.data.workItemId') AS workItemId, json_extract(body,'$.data.accountableMemberId') AS accountableId
  FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence`;
const MENTION_SQL = `SELECT m.message_event_id AS eventId, m.mentioned_member_id AS memberId, m.state, m.created_at AS createdAt, m.timeout_at AS timeoutAt,
    m.decided_at AS decidedAt, o.acknowledged_at AS ackAt, o.responded_at AS respondedAt
  FROM events e JOIN mention_states m ON m.room_id=e.room_id AND m.message_event_id=e.id
  LEFT JOIN mention_observations o ON o.room_id=m.room_id AND o.message_event_id=m.message_event_id AND o.mentioned_member_id=m.mentioned_member_id
  WHERE e.room_id=? AND e.sequence>? AND e.sequence<=? AND json_extract(e.body,'$.type')='message.posted'`;

// The read. Same authorization and window rules as project state: bounded
// journal tail, clamped by the viewer's history floor, private messages only
// for their two parties.
export function readResponseLatency(store, token, roomId, { expectedSessionBinding = null } = {}) {
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const viewerId = auth.member.id, now = store.now();
    const current = isCurrentRoom(store.db, roomId);
    let head, ownerId = null, legacyMembers = null;
    if (current) {
      head = store.headSequence(roomId);
      ownerId = currentRoomOwnerAuthority(store.db, roomId)?.ownerId ?? null;
    } else {
      const room = store.room(roomId);
      head = room.sequence || store.headSequence(roomId);
      ownerId = room.state.room.ownerId; legacyMembers = room.state.members;
    }
    const memoKey = `${roomId}\u0000${viewerId}`;
    const memo = (memos.get(store) ?? memos.set(store, new Map()).get(store));
    const hit = memo.get(memoKey);
    if (hit && hit.head === head && now - hit.at < LATENCY_MEMO_MS) return hit.value;
    const historyFloor = store.historyFloor(roomId, viewerId, head);
    const floor = Math.max(0, head - LATENCY_SCAN_EVENTS, historyFloor ? historyFloor.sequence - 1 : 0);
    const rows = store.db.prepare(EVENT_SQL).all(roomId, floor, head);
    // A private message is visible to its two parties only; everything it
    // causes (replies, requests) carries the same pair, so filtering the
    // request-shaped rows by party is enough.
    const events = rows.filter(r => !r.toId || r.actorId === viewerId || r.toId === viewerId);
    let mentions = [];
    try { mentions = store.db.prepare(MENTION_SQL).all(roomId, floor, head); } catch { mentions = []; }
    const used = new Set();
    for (const e of events) { if (e.actorId) used.add(e.actorId); if (e.toId) used.add(e.toId); }
    for (const m of mentions) used.add(m.memberId);
    let members = legacyMembers ?? {};
    if (current) {
      // Current rooms keep members in protected records: resolve only the ids
      // the journal window names, inside the read budget (at most 40).
      members = {};
      try {
        withCurrentReadContext(store.db, roomId, b => {
          for (const id of used) {
            if (Object.keys(members).length >= 40) break;
            const rec = readCurrentRecord(store.db, roomId, "members", id, b);
            if (rec && rec.id === id) members[id] = rec;
          }
        });
      } catch { /* names degrade to short ids; the numbers do not depend on them */ }
    }
    let wakeRows = [];
    try {
      wakeRows = store.db.prepare("SELECT type, ts_ms, detail FROM room_signal_log WHERE room_id=? ORDER BY seq DESC LIMIT ?").all(roomId, LATENCY_WAKE_SCAN);
    } catch { wakeRows = []; /* table is lazy: no wake signal has been logged yet */ }
    const value = buildResponseLatency({ roomId, viewerId, ownerId, now, through: head,
      window: { fromSeq: floor + 1, throughSeq: head, events: rows.length, complete: floor === 0 }, events, mentions, members,
      wake: buildWakeContext(wakeRows), ship: buildShipContext(readReceiptSignals(store.db, roomId, { limit: 200 }), now) });
    memo.set(memoKey, { head, at: now, value });
    if (memo.size > 64) memo.delete(memo.keys().next().value);
    return value;
  });
}
