// tests/fuzz-12-ready-queue.test.js
// WAVE-400 one-shot fuzz worker — ready-queue / claim-wake fuzz.
//
// TEST-ONLY. Reads server/work-claims.mjs, server/claim-coordination.mjs,
// server/work-wants.mjs, server/work-claim-events.mjs. Writes nothing outside
// this file. No new dependencies.
//
// Target: the ready-queue view (readyClaims) and the wake machinery that
// notifies agents about claimable work (noteReadyWork, enqueueClaimWake,
// wakeNamedReviewers). Pure claim functions (createWork / claimWork /
// updateWork / reassignWork / renewWork / releaseExpired / recordReview) are
// driven as the workload generator; the state machine itself was fuzzed in
// fuzz-01 — here it is the workload, the queue + wakes are the target.
//
// Hand-rolled mulberry32 RNG; seed = Number(process.env.FUZZ_SEED ?? 20261008),
// printed at load. Deterministic per sequence: sequence s reseeds from
// (SEED, s), so any violation reproduces with FUZZ_SEED=<seed> + seq index.
//
// Invariants asserted after every op:
//  (I1) ready-set exactness: readyClaims(items) === naive reimplementation
//       (state unclaimed, no owner, every dependsOn done), same id order.
//       This is the no-lost-wakeup / no-phantom-entry check: the board view
//       is synchronous, so "poll until visible" is recompute-and-compare.
//  (I2) structural: unclaimed <=> owner null (closed is the only other
//       ownerless state); active states always carry a single owner.
//  (I3) noteReadyWork accounting: the woken set, the folded set, and the
//       agent_wants_work row state (last_wake_at / folded) match an
//       independent model of the documented semantics — member filter
//       (agent, active, not the actor), label/capability match, the
//       10-minute window (fold vs re-wake, exact-boundary re-wake), and the
//       skip rules (pause, room-trust) which must NOT touch the row.
//  (I4) wake-signal accounting: every signal the heartbeat stub records was
//       expected; (agent_id, message_id) pairs never repeat (coalescing);
//       a repeated enqueueClaimWake returns enqueued:false, never a dup.
//  (I5) no double-win: a claim race on one unclaimed item lets exactly one
//       claimant through; the loser is rejected and the item is untouched.
//  (I6) noteReadyWork never throws — not on hostile items, not on a dead
//       database, not when the wake layer throws mid-loop (a preference
//       problem must not roll back the board write).
//  (I7) enqueueClaimWake return contract: null on bad args / absent queue,
//       {enqueued:false, skipped} on pause/trust skip, coalesced dups.
//  (I8) wakeNamedReviewers filter pipeline vs a naive model: only
//       in_progress (or PR-linked) owned non-terminal items; rev-<id> tags
//       resolve to active members (id or unique handle slug); the owner and
//       members with a current review are excluded; skip rules apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWork, claimWork, updateWork, reassignWork, renewWork, releaseExpired,
  recordReview, appendWorkPullRequest, claimHistoryLength, ACTIVE_CLAIM_STATES,
} from "../server/work-claims.mjs";
import { readyClaims } from "../server/claim-coordination.mjs";
import {
  noteReadyWork, setWantsWork, clearWantsWork, wantsWorkMatches,
  WANTS_WORK_WINDOW_MS,
} from "../server/work-wants.mjs";
import { enqueueClaimWake, wakeNamedReviewers } from "../server/work-claim-events.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-12] seed=${SEED}`);
const N_SEQUENCES = Number(process.env.FUZZ_SEQUENCES ?? 5000);
const MAX_VIOLATIONS = 25;
const BASE_NOW = 1760000000000;
const ROOM = "fuzz-room";
const WINDOW = WANTS_WORK_WINDOW_MS; // 10 * 60 * 1000

// --- RNG -------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[ri(rng, arr.length)];
const chance = (rng, p) => rng() < p;
const shuffle = (rng, arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = ri(rng, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// --- fake agent_wants_work database -----------------------------------------
// Handles exactly the statements server/work-wants.mjs issues. Anything else
// (identity_links, agent_autonomy_tiers) throws, exercising the documented
// never-throw catch paths in work-claim-events.mjs.
function makeDb() {
  const rows = new Map();
  const key = (r, m) => `${r}|${m}`;
  return {
    rows,
    prepare(sql) {
      const q = String(sql).replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT * FROM agent_wants_work WHERE room_id=? AND member_id=?")) {
        return { get: (roomId, memberId) => rows.get(key(roomId, memberId)) ?? undefined };
      }
      if (q.startsWith("SELECT * FROM agent_wants_work WHERE room_id=? ORDER BY member_id")) {
        return { all: roomId => [...rows.values()]
          .filter(r => r.room_id === roomId)
          .sort((a, b) => (a.member_id < b.member_id ? -1 : a.member_id > b.member_id ? 1 : 0)) };
      }
      if (q.startsWith("INSERT INTO agent_wants_work")) {
        return { run: (roomId, memberId, labels, capabilities, updatedAt) => {
          const k = key(roomId, memberId);
          const prev = rows.get(k);
          // ON CONFLICT DO UPDATE: labels/capabilities/updated_at only —
          // last_wake_at and folded survive a preference rewrite.
          if (prev) { prev.labels = labels; prev.capabilities = capabilities; prev.updated_at = updatedAt; }
          else rows.set(k, { room_id: roomId, member_id: memberId, labels, capabilities, last_wake_at: null, folded: 0, updated_at: updatedAt });
          return { changes: 1 };
        } };
      }
      if (q.startsWith("DELETE FROM agent_wants_work")) {
        return { run: (roomId, memberId) => ({ changes: rows.delete(key(roomId, memberId)) ? 1 : 0 }) };
      }
      if (q.startsWith("UPDATE agent_wants_work SET folded=folded+1")) {
        return { run: (roomId, memberId) => { const r = rows.get(key(roomId, memberId)); if (r) r.folded += 1; return { changes: r ? 1 : 0 }; } };
      }
      if (q.startsWith("UPDATE agent_wants_work SET last_wake_at=?, folded=0")) {
        return { run: (at, roomId, memberId) => { const r = rows.get(key(roomId, memberId)); if (r) { r.last_wake_at = at; r.folded = 0; } return { changes: r ? 1 : 0 }; } };
      }
      throw new Error(`fuzz-db: unexpected query: ${q.slice(0, 90)}`);
    },
  };
}

// --- stub agent heartbeats: real coalescing semantics ------------------------
// Mirrors server/agent-heartbeats.mjs enqueueWake: INSERT OR IGNORE on
// (agent_id, message_id) — the same message wakes an agent exactly once.
// A genuinely new signal is appended to the log; a duplicate returns
// enqueued:false with the existing signal. failFor injects a mid-loop
// throw to prove noteReadyWork keeps going (I6).
class StubHeartbeats {
  constructor() { this.signals = []; this.failFor = new Set(); this.seq = 0; this.nowMs = BASE_NOW; }
  has(agentId, messageId) { return this.signals.some(s => s.agent_id === agentId && s.message_id === messageId); }
  enqueueWake({ agentId, kind, roomId = null, messageId }) {
    if (typeof agentId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) throw new Error("invalid agent id");
    if (typeof messageId !== "string" || messageId.length === 0) throw new Error("invalid message id");
    if (this.failFor.has(agentId)) throw new Error("injected wake-layer failure");
    const prior = this.signals.find(s => s.agent_id === agentId && s.message_id === messageId);
    if (prior) return Object.freeze({ enqueued: false, signal: prior });
    const signal = Object.freeze({ signal_id: `ws_fuzz${this.seq++}`, agent_id: agentId, kind, room_id: roomId, message_id: messageId, created_at: this.nowMs, delivered_at: null });
    this.signals.push(signal);
    return Object.freeze({ enqueued: true, signal });
  }
}

// --- per-sequence context ----------------------------------------------------
function makeMembers() {
  return {
    owner: { id: "owner", kind: "human", active: true, displayName: "Room Owner" },
    h1: { id: "h1", kind: "human", active: true, displayName: "Human One" },
    m0: { id: "m0", kind: "agent", active: true, displayName: "Agent Zero", accountableHumanId: "h1" },
    m1: { id: "m1", kind: "agent", active: true, displayName: "Agent One", accountableHumanId: "h1" },
    m2: { id: "m2", kind: "agent", active: true, displayName: "Agent Two", accountableHumanId: "owner" },
    m3: { id: "m3", kind: "agent", active: true, displayName: "Ag3nt Three", accountableHumanId: "owner" },
  };
}

function makeCtx() {
  const db = makeDb();
  const hb = new StubHeartbeats();
  const ctx = {
    db, hb,
    members: makeMembers(),
    items: new Map(), // id -> work item (pure-machine outputs)
    now: BASE_NOW,
    trustEnabled: true,
    paused: new Set(),
    pings: [],
    stats: { ops: 0, wakes: 0, folds: 0, sweeps: 0, races: 0 },
    store: null,
  };
  ctx.store = {
    db,
    agentHeartbeats: hb,
    wakeQueue: { pauseStatus: (roomId, memberId) => ctx.paused.has(memberId) ? { pausedAt: 1, reason: "fuzz" } : null },
    roomAuthority: roomId => ({ members: ctx.members }),
    room: roomId => ({ state: { members: ctx.members, room: { ownerId: "owner", trust: { enabled: ctx.trustEnabled } } } }),
    agentPlugin: { deliverWakePing: ({ identityId, signal }) => { ctx.pings.push({ identityId, signal }); } },
  };
  return ctx;
}

const itemList = ctx => [...ctx.items.values()];
const parseList = text => { try { const v = JSON.parse(text); return Array.isArray(v) ? v.filter(e => typeof e === "string") : []; } catch { return []; } };

// --- naive oracles (written from the doc comments, not the code) --------------
function naiveReadyIds(items) {
  const byId = new Map(items.map(i => [i.id, i]));
  return items
    .filter(i => i && i.state === "unclaimed" && !i.owner
      && (Array.isArray(i.dependsOn) ? i.dependsOn : []).every(d => byId.get(d)?.state === "done"))
    .map(i => i.id)
    .sort();
}

const memberOwnerOf = (ctx, id) => {
  const m = ctx.members[id];
  if (!m) return null;
  if (m.kind === "human") return m.id;
  return m.accountableHumanId || "owner";
};
// Mirrors isCrossOwnerAgentAction: different sponsors, at least one agent.
function naiveCrossOwner(ctx, actorId, targetId) {
  if (!actorId || !targetId || actorId === targetId) return false;
  const a = ctx.members[actorId], t = ctx.members[targetId];
  if (!a || !t || a.active === false || t.active === false) return false;
  if (a.kind !== "agent" && t.kind !== "agent") return false;
  const oa = memberOwnerOf(ctx, actorId), ob = memberOwnerOf(ctx, targetId);
  return Boolean(oa && ob && oa !== ob);
}
const naiveSkipped = (ctx, actorId, memberId) =>
  ctx.paused.has(memberId) || (Boolean(actorId) && !ctx.trustEnabled && naiveCrossOwner(ctx, actorId, memberId));

// Independent model of noteReadyWork's documented contract:
// unclaimed + ownerless only; agent, active, non-actor members whose
// labels/capabilities match; inside the 10-min window the match folds,
// otherwise one wake (unless skipped, or the exact signal already exists).
function expectReadyWakes(ctx, item, { actorId, at }) {
  const exp = { woken: [], folded: [] };
  if (!item || item.state !== "unclaimed" || item.owner) return exp;
  const rows = [...ctx.db.rows.values()].filter(r => r.room_id === ROOM)
    .sort((a, b) => (a.member_id < b.member_id ? -1 : 1));
  for (const row of rows) {
    const m = ctx.members[row.member_id];
    if (!m || m.kind !== "agent" || m.active === false || row.member_id === actorId) continue;
    if (!wantsWorkMatches({ labels: parseList(row.labels), capabilities: parseList(row.capabilities) }, item)) continue;
    if (row.last_wake_at != null && at - row.last_wake_at < WINDOW) { exp.folded.push(row.member_id); continue; }
    if (naiveSkipped(ctx, actorId, row.member_id)) continue;
    const messageId = `work-claim:${item.id}:ready_work:${at}`;
    if (ctx.hb.has(row.member_id, messageId)) continue; // coalesced: row untouched
    exp.woken.push(row.member_id);
  }
  return exp;
}

const slugOf = name => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
function naiveNamedReviewers(item, members) {
  const active = Object.entries(members ?? {}).filter(([, m]) => m && m.active !== false);
  const ids = [];
  for (const tag of (item?.tags ?? [])) {
    if (typeof tag !== "string" || !tag.startsWith("rev-")) continue;
    const value = tag.slice(4);
    if (active.some(([id]) => id === value)) { if (!ids.includes(value)) ids.push(value); continue; }
    const slug = slugOf(value);
    const matches = slug ? active.filter(([, m]) => slugOf(m.displayName) === slug) : [];
    if (matches.length === 1 && !ids.includes(matches[0][0])) ids.push(matches[0][0]);
  }
  return ids;
}
const naiveBasisOf = item => ({ version: 1, owner: item.owner, claimedAt: item.claimedAt, revision: item.revision ?? null, headSha: item.ci?.headSha ?? null });
function naiveCurrentReview(item, memberId) {
  const current = naiveBasisOf(item);
  return (item?.reviews ?? []).some(r => r?.memberId === memberId && r.basis
    && Object.keys(current).every(k => r.basis[k] === current[k]));
}
// Independent model of wakeNamedReviewers' documented contract.
function expectReviewWakes(ctx, item, { actorId }) {
  const exp = [];
  if (!item || item.state === "done" || item.state === "closed" || !item.owner || item.supersededBy) return exp;
  if (!(item.state === "in_progress" || item.pullRequest || (item.pullRequests ?? []).length)) return exp;
  const head = item.ci?.headSha ?? item.revision ?? item.claimedAt ?? "none";
  for (const mid of naiveNamedReviewers(item, ctx.members)) {
    if (mid === item.owner || naiveCurrentReview(item, mid)) continue;
    const messageId = `work-claim:${item.id}:review:${head}`;
    exp.push({ memberId: mid, messageId, enqueued: !naiveSkipped(ctx, actorId, mid) && !ctx.hb.has(mid, messageId) });
  }
  return exp;
}

// --- violation recording -------------------------------------------------------
function violation(ctx, seq, step, op, detail) {
  ctx.violations.push({ seq, step, op, now: ctx.now, detail });
}

// --- invariant checks (run after every op) -------------------------------------
function checkInvariants(ctx, seq, step, op) {
  const items = itemList(ctx);
  // I1: ready-set exactness — no lost wakeups, no phantom entries.
  const actual = readyClaims(items).map(i => i.id);
  const expected = naiveReadyIds(items);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    violation(ctx, seq, step, op, "I1 ready-set mismatch: actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected));
  }
  // The view is synchronous: poll it again — it must be stable.
  const again = readyClaims(items).map(i => i.id);
  if (JSON.stringify(again) !== JSON.stringify(actual)) {
    violation(ctx, seq, step, op, "I1 ready view unstable across polls");
  }
  // I2: structural ownership sanity.
  for (const item of items) {
    if (item.state === "unclaimed" || item.state === "closed") {
      if (item.owner !== null) violation(ctx, seq, step, op, "I2 item " + item.id + " state=" + item.state + " has owner " + item.owner);
    } else if (typeof item.owner !== "string" || item.owner.length === 0) {
      violation(ctx, seq, step, op, "I2 item " + item.id + " state=" + item.state + " has no single owner");
    }
  }
  // I4: (agent_id, message_id) pairs never repeat in the wake log.
  const seen = new Set();
  for (const s of ctx.hb.signals) {
    const k = s.agent_id + "|" + s.message_id;
    if (seen.has(k)) violation(ctx, seq, step, op, "I4 duplicate wake signal " + k);
    seen.add(k);
  }
}

// Assert the real noteReadyWork call matches the independent model (I3, I6).
function doNoteReadyWork(ctx, seq, step, opName, item, opts) {
  const actorId = opts.actorId, at = opts.at;
  const exp = expectReadyWakes(ctx, item, { actorId, at });
  const rowsBefore = new Map([...ctx.db.rows.entries()].map(([k, r]) => [k, { last_wake_at: r.last_wake_at, folded: r.folded, member_id: r.member_id }]));
  const sigBefore = ctx.hb.signals.length;
  let result;
  try {
    result = noteReadyWork(ctx.store, ROOM, item, { actorId, now: at });
  } catch (error) {
    violation(ctx, seq, step, opName, "I6 noteReadyWork threw: " + (error && error.message));
    return;
  }
  const newSigs = ctx.hb.signals.slice(sigBefore);
  const returned = [...(result || [])].sort();
  if (JSON.stringify(returned) !== JSON.stringify([...exp.woken].sort())) {
    violation(ctx, seq, step, opName, "I3 woken mismatch: returned=" + JSON.stringify(returned) + " expected=" + JSON.stringify(exp.woken));
  }
  if (newSigs.length !== exp.woken.length) {
    violation(ctx, seq, step, opName, "I3/I4 signal count " + newSigs.length + " != woken " + exp.woken.length);
  }
  for (const s of newSigs) {
    const wantId = "work-claim:" + item.id + ":ready_work:" + at;
    if (!exp.woken.includes(s.agent_id) || s.message_id !== wantId || s.kind !== "mention" || s.room_id !== ROOM) {
      violation(ctx, seq, step, opName, "I3 unexpected signal " + s.agent_id + " " + s.message_id);
    }
  }
  for (const [k, before] of rowsBefore) {
    const after = ctx.db.rows.get(k);
    const mid = before.member_id;
    if (exp.woken.includes(mid)) {
      if (after.last_wake_at !== at || after.folded !== 0) {
        violation(ctx, seq, step, opName, "I3 row " + mid + ": last_wake_at=" + after.last_wake_at + " folded=" + after.folded + ", want at=" + at + " folded=0");
      }
    } else if (exp.folded.includes(mid)) {
      if (after.folded !== before.folded + 1 || after.last_wake_at !== before.last_wake_at) {
        violation(ctx, seq, step, opName, "I3 row " + mid + ": fold not recorded (folded " + before.folded + "->" + after.folded + ")");
      }
    } else if (after.last_wake_at !== before.last_wake_at || after.folded !== before.folded) {
      violation(ctx, seq, step, opName, "I3 row " + mid + " changed without cause");
    }
  }
  ctx.stats.wakes += exp.woken.length;
  ctx.stats.folds += exp.folded.length;
  return result;
}

// Assert the real wakeNamedReviewers call matches the independent model (I8).
function doWakeNamedReviewers(ctx, seq, step, opName, item, opts) {
  const actorId = opts.actorId;
  const exp = expectReviewWakes(ctx, item, { actorId });
  const sigBefore = ctx.hb.signals.length;
  let results;
  try {
    results = wakeNamedReviewers(ctx.store, ROOM, item, { actorId });
  } catch (error) {
    violation(ctx, seq, step, opName, "I8 wakeNamedReviewers threw: " + (error && error.message));
    return;
  }
  if (!Array.isArray(results) || results.length !== exp.length) {
    violation(ctx, seq, step, opName, "I8 result length " + (results && results.length) + " != expected " + exp.length);
    return;
  }
  for (let i = 0; i < exp.length; i++) {
    if (results[i] && results[i].enqueued !== exp[i].enqueued) {
      violation(ctx, seq, step, opName, "I8 member " + exp[i].memberId + ": enqueued=" + results[i].enqueued + " want " + exp[i].enqueued);
    }
  }
  const newSigs = ctx.hb.signals.slice(sigBefore);
  const wantNew = exp.filter(e => e.enqueued);
  if (newSigs.length !== wantNew.length) {
    violation(ctx, seq, step, opName, "I8 signal count " + newSigs.length + " != " + wantNew.length);
  }
  for (const s of newSigs) {
    const e = wantNew.find(w => w.memberId === s.agent_id && w.messageId === s.message_id);
    if (!e) violation(ctx, seq, step, opName, "I8 unexpected reviewer signal " + s.agent_id + " " + s.message_id);
  }
}

// --- hostile-but-plausible generators ------------------------------------------
const TAG_POOL = ["lbl0", "lbl1", "lbl2", "rev-m0", "rev-m1", "rev-m2", "rev-m3", "rev-nobody", "rev-agentzero", "starter"];
const LABEL_POOL = ["lbl0", "lbl1", "lbl2", "other"];
const KIND_POOL = ["work", "work", "work", "land", "deploy"];
const LEASE_POOL = [undefined, undefined, null, 1 / 3600, 0.25, 2, 24];

const genTags = rng => shuffle(rng, TAG_POOL).slice(0, ri(rng, 4));
const genLabels = rng => shuffle(rng, LABEL_POOL).slice(0, ri(rng, 3));
const genCaps = rng => shuffle(rng, ["work", "land", "deploy"]).slice(0, ri(rng, 3));
const genDeps = (rng, ids, selfId) => shuffle(rng, ids.filter(id => id !== selfId)).slice(0, Math.min(3, ri(rng, 3)));
const genLease = rng => pick(rng, LEASE_POOL);
const genDelta = rng => { const r = rng(); if (r < 0.7) return ri(rng, 60000); if (r < 0.95) return ri(rng, 1800000); return ri(rng, 3 * 3600000); };

// --- ops -----------------------------------------------------------------------
function opCreate(ctx, rng, seq, idCounter) {
  const id = "w" + seq + "_" + (idCounter.n++);
  const kind = pick(rng, KIND_POOL);
  const tags = genTags(rng);
  const deps = genDeps(rng, [...ctx.items.keys()], id);
  const data = { reviewPolicy: "self_attested", tags, dependsOn: deps, kind };
  if (kind === "deploy") data.revision = "revA";
  const creator = pick(rng, Object.keys(ctx.members));
  let item;
  try {
    item = createWork(Object.assign({ id }, data), { now: ctx.now, agentId: creator });
  } catch (error) {
    violation(ctx, seq, -1, "create", "createWork threw on generated input: " + (error && error.message));
    return;
  }
  ctx.items.set(id, item);
  const candidates = Object.keys(ctx.members).filter(m => ctx.members[m].active !== false);
  const assignee = chance(rng, 0.25) && candidates.length > 0 ? pick(rng, candidates) : null;
  if (assignee) {
    try {
      const claimed = claimWork(item, assignee, { leaseHours: genLease(rng), now: ctx.now });
      ctx.items.set(id, claimed);
      doWakeNamedReviewers(ctx, seq, -1, "create-assigned", claimed, { actorId: creator });
    } catch {
      ctx.items.set(id, item); // claim refused; item stays unclaimed
      doNoteReadyWork(ctx, seq, -1, "create", item, { actorId: creator, at: ctx.now });
    }
  } else {
    // commit(item, "created") -> noteReadyWork, exactly like the route.
    doNoteReadyWork(ctx, seq, -1, "create", item, { actorId: creator, at: ctx.now });
  }
}

function opClaim(ctx, rng, seq) {
  const ids = [...ctx.items.keys()];
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  const snap = JSON.stringify(before);
  const agent = pick(rng, Object.keys(ctx.members));
  if (before.state !== "unclaimed") {
    // Route-modeled refusal: rejected ops must leave the input byte-identical.
    let threw = false;
    try { claimWork(before, agent, { now: ctx.now }); } catch { threw = true; }
    if (!threw) violation(ctx, seq, -1, "claim", "claim of " + id + " in state " + before.state + " unexpectedly succeeded");
    if (JSON.stringify(ctx.items.get(id)) !== snap) violation(ctx, seq, -1, "claim", "rejected claim mutated " + id);
    return;
  }
  const item = claimWork(before, agent, { leaseHours: genLease(rng), now: ctx.now });
  ctx.items.set(id, item);
  if (JSON.stringify(before) !== snap) violation(ctx, seq, -1, "claim", "successful claim mutated its input " + id);
  doWakeNamedReviewers(ctx, seq, -1, "claim", item, { actorId: agent });
}

function opClaimRace(ctx, rng, seq) {
  // I5: two claimants, one unclaimed item — exactly one wins.
  const ids = [...ctx.items.keys()].filter(id => ctx.items.get(id).state === "unclaimed");
  if (ids.length === 0) return;
  const agents = shuffle(rng, Object.keys(ctx.members));
  if (agents.length < 2) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  const snap = JSON.stringify(before);
  const a1 = agents[0], a2 = agents[1];
  let w1 = null, w2 = null;
  try { w1 = claimWork(before, a1, { now: ctx.now }); } catch { /* lost */ }
  try { w2 = claimWork(w1 || before, a2, { now: ctx.now }); } catch { /* lost */ }
  const wins = (w1 ? 1 : 0) + (w2 ? 1 : 0);
  if (wins !== 1) {
    violation(ctx, seq, -1, "claim-race", "I5 race on " + id + ": " + wins + " winners (want exactly 1)");
    return;
  }
  const winner = w1 || w2;
  ctx.items.set(id, winner);
  if (typeof winner.owner !== "string") violation(ctx, seq, -1, "claim-race", "I5 winner left " + id + " ownerless");
  if (JSON.stringify(before) !== snap) violation(ctx, seq, -1, "claim-race", "race mutated the pre-race input " + id);
  ctx.stats.races++;
  doWakeNamedReviewers(ctx, seq, -1, "claim-race", winner, { actorId: winner.owner });
}

function opRelease(ctx, rng, seq) {
  // Route-modeled release: in_progress/blocked pause to claimed first, then
  // claimed -> unclaimed; then commit(..., "released") -> noteReadyWork.
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return ["claimed", "in_progress", "blocked"].includes(it.state) && it.owner;
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  let item = ctx.items.get(id);
  const caller = item.owner;
  const authority = chance(rng, 0.2); // room owner acting with manage_claims
  const actor = authority ? "owner" : caller;
  try {
    if (item.state === "in_progress" || item.state === "blocked") {
      item = updateWork(item, actor, { state: "claimed", note: "paused for release", now: ctx.now, authority });
    }
    item = updateWork(item, actor, { state: "unclaimed", note: "fuzz release", now: ctx.now, authority });
  } catch (error) {
    violation(ctx, seq, -1, "release", "release threw on releasable " + id + ": " + (error && error.message));
    return;
  }
  if (item.state !== "unclaimed" || item.owner !== null) {
    violation(ctx, seq, -1, "release", id + " not ownerless-unclaimed after release");
  }
  ctx.items.set(id, item);
  doNoteReadyWork(ctx, seq, -1, "release", item, { actorId: actor, at: ctx.now });
}

function opProgress(ctx, rng, seq) {
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return it.owner && (it.state === "claimed" || it.state === "in_progress" || it.state === "blocked");
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  const target = before.state === "claimed" ? pick(rng, ["in_progress", "blocked"])
    : before.state === "in_progress" ? "blocked" : "in_progress";
  let item;
  try {
    item = updateWork(before, before.owner, { state: target, note: "fuzz progress", now: ctx.now });
  } catch (error) {
    violation(ctx, seq, -1, "progress", "progress " + before.state + "->" + target + " threw: " + (error && error.message));
    return;
  }
  ctx.items.set(id, item);
  doWakeNamedReviewers(ctx, seq, -1, "progress", item, { actorId: before.owner });
}

function opDone(ctx, rng, seq) {
  // The lifecycle only finishes from in_progress (claimed/blocked must
  // move to in_progress first); only attempt done from in_progress.
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return it.owner && it.state === "in_progress";
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  let item;
  try {
    item = updateWork(before, before.owner, { state: "done", note: "fuzz done", now: ctx.now });
  } catch (error) {
    violation(ctx, seq, -1, "done", "done threw: " + (error && error.message));
    return;
  }
  ctx.items.set(id, item);
  doWakeNamedReviewers(ctx, seq, -1, "done", item, { actorId: before.owner });
}

function opNote(ctx, rng, seq) {
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return it.owner && !["done", "closed"].includes(it.state);
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  const item = updateWork(before, before.owner, { note: "fuzz note " + ri(rng, 1e6), now: ctx.now });
  ctx.items.set(id, item);
  doWakeNamedReviewers(ctx, seq, -1, "note", item, { actorId: before.owner });
}

function opReassign(ctx, rng, seq) {
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return it.owner && !["done", "closed"].includes(it.state);
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  const target = pick(rng, Object.keys(ctx.members).filter(m => m !== before.owner));
  const authority = chance(rng, 0.3);
  const actor = authority ? "owner" : before.owner;
  let item;
  try {
    item = reassignWork(before, actor, target, { note: "fuzz reassign", now: ctx.now, authority, room: { workClaims: {} } });
  } catch (error) {
    violation(ctx, seq, -1, "reassign", "reassign threw: " + (error && error.message));
    return;
  }
  ctx.items.set(id, item);
  // Route-modeled: commit(..., "reassigned", { wakeMemberId: target, wakeReason: "assigned" }).
  // Snapshot the coalescing state BEFORE the call — the call itself adds the signal.
  const messageId = "work-claim:" + id + ":assigned:" + ctx.now;
  const alreadyHad = ctx.hb.has(target, messageId);
  const wantEnqueued = !naiveSkipped(ctx, actor, target) && !alreadyHad;
  let result;
  try {
    result = enqueueClaimWake(ctx.store, ROOM, target, messageId, { reason: "assigned", actorId: actor });
  } catch (error) {
    violation(ctx, seq, -1, "reassign", "I6 assign wake threw: " + (error && error.message));
    return;
  }
  if (Boolean(result && result.enqueued) !== wantEnqueued) {
    violation(ctx, seq, -1, "reassign", "I4 assign wake enqueued=" + (result && result.enqueued) + " want " + wantEnqueued);
  }
}

function opRenew(ctx, rng, seq) {
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return it.owner && ACTIVE_CLAIM_STATES.includes(it.state)
      && typeof it.leaseExpiresAt === "string" && Date.parse(it.leaseExpiresAt) > ctx.now;
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  let item;
  try {
    item = renewWork(before, before.owner, { leaseHours: genLease(rng), now: ctx.now });
  } catch (error) {
    violation(ctx, seq, -1, "renew", "renew threw on renewable " + id + ": " + (error && error.message));
    return;
  }
  ctx.items.set(id, item);
}

function opSweep(ctx, rng, seq) {
  // Route-modeled sweepRoom: expired claims auto-release; the former owner
  // gets one lease_expired wake per lapse (never noteReadyWork — spec'd).
  const items = itemList(ctx);
  const swept = releaseExpired(items, ctx.now);
  const released = [];
  swept.forEach((item, index) => {
    const prev = items[index];
    // Route-exact: only a claim that actually lapsed counts as swept; the
    // normalized copy replaces the registry entry (workOf normalization,
    // e.g. dropping updatedAt, is the route's own behavior — claimUpdatedAt
    // falls back to the history stamp, so board order is preserved).
    if (item.state === "unclaimed" && prev.state !== "unclaimed") {
      if (item.owner !== null) violation(ctx, seq, -1, "sweep", "I2 swept " + item.id + " still owned");
      ctx.items.set(item.id, item);
      released.push({ item, prev });
    }
  });
  for (const r of released) {
    const messageId = "work-claim:" + r.item.id + ":lease_expired:" + (r.prev.leaseExpiresAt || ctx.now);
    try {
      enqueueClaimWake(ctx.store, ROOM, r.prev.owner, messageId, { reason: "lease_expired", actorId: r.prev.owner });
    } catch (error) {
      violation(ctx, seq, -1, "sweep", "I6 lease_expired wake threw: " + (error && error.message));
    }
  }
  ctx.stats.sweeps++;
}

function opReview(ctx, rng, seq) {
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return ACTIVE_CLAIM_STATES.includes(it.state) && it.owner;
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  const reviewer = pick(rng, Object.keys(ctx.members).filter(m => m !== before.owner));
  try {
    const item = recordReview(before, reviewer, { verdict: pick(rng, ["approve", "changes_requested", "comment"]), summary: "fuzz review " + ri(rng, 1e6), now: ctx.now });
    ctx.items.set(id, item);
  } catch { /* route would refuse (e.g. inactive reviewer); skip */ }
}

function opSetWants(ctx, rng, seq) {
  const mid = pick(rng, Object.keys(ctx.members));
  const input = { labels: genLabels(rng), capabilities: genCaps(rng) };
  try {
    setWantsWork(ctx.db, ROOM, mid, input, ctx.now);
  } catch (error) {
    violation(ctx, seq, -1, "set-wants", "setWantsWork threw on generated input: " + (error && error.message));
  }
}

function opClearWants(ctx, rng, seq) {
  const mid = pick(rng, Object.keys(ctx.members));
  try { clearWantsWork(ctx.db, ROOM, mid); } catch (error) {
    violation(ctx, seq, -1, "clear-wants", "clearWantsWork threw: " + (error && error.message));
  }
}

function opPauseToggle(ctx, rng) {
  const mid = pick(rng, ["m0", "m1", "m2", "m3"]);
  if (ctx.paused.has(mid)) ctx.paused.delete(mid); else ctx.paused.add(mid);
}

function opTrustToggle(ctx) { ctx.trustEnabled = !ctx.trustEnabled; }

function opActiveToggle(ctx, rng) {
  const mid = pick(rng, ["m0", "m1", "m2", "m3", "h1"]);
  ctx.members[mid].active = !ctx.members[mid].active;
}

function opDupNotify(ctx, rng, seq) {
  // Duplicate enqueue of the same work at the same instant: the second
  // notification must fold into the first (window), never double-wake.
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return it.state === "unclaimed" && !it.owner;
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const item = ctx.items.get(id);
  const actor = pick(rng, Object.keys(ctx.members));
  doNoteReadyWork(ctx, seq, -1, "dup-notify#1", item, { actorId: actor, at: ctx.now });
  const sigsAfterFirst = ctx.hb.signals.length;
  doNoteReadyWork(ctx, seq, -1, "dup-notify#2", item, { actorId: actor, at: ctx.now });
  if (ctx.hb.signals.length !== sigsAfterFirst) {
    violation(ctx, seq, -1, "dup-notify", "I4 duplicate notify added " + (ctx.hb.signals.length - sigsAfterFirst) + " extra signals");
  }
}

function opHostileNotify(ctx, rng, seq) {
  // I6: hostile items must be ignored, never throw, never wake.
  const sigsBefore = ctx.hb.signals.length;
  const rowsBefore = JSON.stringify([...ctx.db.rows.entries()]);
  const hostile = [null, undefined, {}, { state: "claimed" }, { state: "unclaimed", owner: "m0" }, { state: "done" }];
  for (const h of hostile) {
    let result;
    try {
      result = noteReadyWork(ctx.store, ROOM, h, { actorId: "m0", now: ctx.now });
    } catch (error) {
      violation(ctx, seq, -1, "hostile-notify", "I6 noteReadyWork threw on hostile item: " + (error && error.message));
      return;
    }
    if (!Array.isArray(result) || result.length !== 0) {
      violation(ctx, seq, -1, "hostile-notify", "I6 hostile item produced " + JSON.stringify(result));
    }
  }
  if (ctx.hb.signals.length !== sigsBefore) violation(ctx, seq, -1, "hostile-notify", "I6 hostile item woke someone");
  if (JSON.stringify([...ctx.db.rows.entries()]) !== rowsBefore) violation(ctx, seq, -1, "hostile-notify", "I6 hostile item touched rows");
  // Dead database: the SELECT catch must return [] without throwing.
  const deadStore = Object.assign({}, ctx.store, { db: { prepare: () => { throw new Error("db is gone"); } } });
  try {
    const r = noteReadyWork(deadStore, ROOM, { id: "x", state: "unclaimed", owner: null, tags: [], kind: "work" }, { actorId: "m0", now: ctx.now });
    if (!Array.isArray(r) || r.length !== 0) violation(ctx, seq, -1, "hostile-notify", "dead-db notify did not return []");
  } catch (error) {
    violation(ctx, seq, -1, "hostile-notify", "I6 dead-db notify threw: " + (error && error.message));
  }
}

function opWakeFailure(ctx, rng, seq) {
  // I6: the wake layer throws mid-loop — noteReadyWork must not throw and
  // must still process the members after the failure.
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return it.state === "unclaimed" && !it.owner;
  });
  if (ids.length === 0) return;
  for (const m of ["m0", "m1", "m2", "m3"]) {
    try { setWantsWork(ctx.db, ROOM, m, { labels: [], capabilities: [] }, ctx.now); } catch { /* ignore */ }
  }
  ctx.hb.failFor.add("m1");
  const id = pick(rng, ids);
  const item = ctx.items.get(id);
  try {
    noteReadyWork(ctx.store, ROOM, item, { actorId: "owner", now: ctx.now });
  } catch (error) {
    violation(ctx, seq, -1, "wake-failure", "I6 noteReadyWork threw on wake-layer failure: " + (error && error.message));
  } finally {
    ctx.hb.failFor.delete("m1");
  }
}

function opWakeDirect(ctx, rng, seq) {
  // I7: enqueueClaimWake return contract on hostile inputs. Isolate
  // pause/trust state so the expectations are deterministic.
  const savedPaused = new Set(ctx.paused);
  const savedTrust = ctx.trustEnabled;
  ctx.paused.clear();
  ctx.trustEnabled = true;
  try {
    opWakeDirectInner(ctx, rng, seq);
  } finally {
    ctx.paused = savedPaused;
    ctx.trustEnabled = savedTrust;
  }
}

function opWakeDirectInner(ctx, rng, seq) {
  // I7: enqueueClaimWake return contract on hostile inputs.
  const bad = [
    enqueueClaimWake(ctx.store, ROOM, 42, "work-claim:x:review:1"),
    enqueueClaimWake(ctx.store, ROOM, "m0", 42),
    enqueueClaimWake(Object.assign({}, ctx.store, { agentHeartbeats: null }), ROOM, "m0", "work-claim:x:review:1"),
    enqueueClaimWake(null, ROOM, "m0", "work-claim:x:review:1"),
  ];
  for (const r of bad) {
    if (r !== null) violation(ctx, seq, -1, "wake-direct", "I7 bad args returned " + JSON.stringify(r) + ", want null");
  }
  // A message id without the work-claim: prefix enqueues fine.
  const r = enqueueClaimWake(ctx.store, ROOM, "m0", "plain-" + seq + "-" + ri(rng, 1e9), { reason: "review", actorId: "owner" });
  if (!r || r.enqueued !== true) violation(ctx, seq, -1, "wake-direct", "I7 plain message id did not enqueue");
  // Same message id twice: second coalesces.
  const mid = "work-claim:dup-" + seq + "-" + (ctx.wakeDirectN = (ctx.wakeDirectN || 0) + 1) + ":review:1";
  const r1 = enqueueClaimWake(ctx.store, ROOM, "m0", mid, { reason: "review", actorId: "owner" });
  const r2 = enqueueClaimWake(ctx.store, ROOM, "m0", mid, { reason: "review", actorId: "owner" });
  if (!r1 || !r1.enqueued) violation(ctx, seq, -1, "wake-direct", "I7 first enqueue did not report enqueued");
  if (!r2 || r2.enqueued !== false) violation(ctx, seq, -1, "wake-direct", "I7 duplicate enqueue reported enqueued=" + (r2 && r2.enqueued));
  // Paused member: skip, no row effects, no signal.
  ctx.paused.add("m2");
  const sigsBefore = ctx.hb.signals.length;
  const rp = enqueueClaimWake(ctx.store, ROOM, "m2", "work-claim:skip-" + seq + ":assigned:1", { reason: "assigned", actorId: "owner" });
  if (!rp || rp.enqueued !== false || rp.skipped !== "paused") {
    violation(ctx, seq, -1, "wake-direct", "I7 paused wake returned " + JSON.stringify(rp));
  }
  if (ctx.hb.signals.length !== sigsBefore) violation(ctx, seq, -1, "wake-direct", "I7 paused wake recorded a signal");
  ctx.paused.delete("m2");
}

function opWindowEdge(ctx, rng, seq) {
  // The 10-minute ready_work window, probed at its exact boundary: 1ms
  // inside must fold, exactly on the boundary must wake fresh.
  const rows = [...ctx.db.rows.values()].filter(r => r.room_id === ROOM && r.last_wake_at != null && r.last_wake_at + WINDOW - 1 >= ctx.now);
  const ids = [...ctx.items.keys()].filter(id => { const it = ctx.items.get(id); return it.state === "unclaimed" && !it.owner; });
  if (rows.length === 0 || ids.length === 0) return;
  const row = pick(rng, rows);
  // Match-all preferences so the boundary behavior lands on this member
  // (the upsert preserves last_wake_at — verified by the fake db).
  try { setWantsWork(ctx.db, ROOM, row.member_id, { labels: [], capabilities: [] }, ctx.now); } catch { return; }
  const item = ctx.items.get(pick(rng, ids));
  const actor = pick(rng, Object.keys(ctx.members));
  ctx.now = row.last_wake_at + WINDOW - 1;
  ctx.hb.nowMs = ctx.now;
  doNoteReadyWork(ctx, seq, -1, "window-edge-in", item, { actorId: actor, at: ctx.now });
  ctx.now = row.last_wake_at + WINDOW;
  ctx.hb.nowMs = ctx.now;
  doNoteReadyWork(ctx, seq, -1, "window-edge-at", item, { actorId: actor, at: ctx.now });
}

function opLinkPr(ctx, rng, seq) {
  // PR-linking flips wakeNamedReviewers on for a merely-claimed item
  // (the in_progress-or-PR guard); a stale replay must be refused.
  const ids = [...ctx.items.keys()].filter(id => {
    const it = ctx.items.get(id);
    return ACTIVE_CLAIM_STATES.includes(it.state) && it.owner && !it.supersededBy;
  });
  if (ids.length === 0) return;
  const id = pick(rng, ids);
  const before = ctx.items.get(id);
  const pr = "https://github.com/fuzzorg/o" + ri(rng, 3) + "/pull/" + (1 + ri(rng, 50));
  if (chance(rng, 0.2)) {
    let threw = false;
    try {
      appendWorkPullRequest(before, before.owner, { pullRequest: pr, expectedClaimedAt: "2000-01-01T00:00:00.000Z", expectedHistoryLength: 0, now: ctx.now });
    } catch { threw = true; }
    if (!threw) violation(ctx, seq, -1, "link-pr", "stale PR-link replay did not throw");
    return;
  }
  try {
    const item = appendWorkPullRequest(before, before.owner,
      { pullRequest: pr, expectedClaimedAt: before.claimedAt, expectedHistoryLength: claimHistoryLength(before), now: ctx.now });
    ctx.items.set(id, item);
    if (item !== before) doWakeNamedReviewers(ctx, seq, -1, "link-pr", item, { actorId: before.owner });
  } catch {
    // Legit refusals (e.g. lapsed lease) leave the registry untouched.
    if (JSON.stringify(ctx.items.get(id)) !== JSON.stringify(before)) violation(ctx, seq, -1, "link-pr", "refused link-pr mutated " + id);
  }
}

// --- op dispatch -----------------------------------------------------------------
const OPS = [
  ["create", 20, (ctx, rng, seq, c) => opCreate(ctx, rng, seq, c)],
  ["claim", 18, (ctx, rng, seq) => opClaim(ctx, rng, seq)],
  ["claim-race", 4, (ctx, rng, seq) => opClaimRace(ctx, rng, seq)],
  ["release", 12, (ctx, rng, seq) => opRelease(ctx, rng, seq)],
  ["progress", 8, (ctx, rng, seq) => opProgress(ctx, rng, seq)],
  ["done", 6, (ctx, rng, seq) => opDone(ctx, rng, seq)],
  ["note", 4, (ctx, rng, seq) => opNote(ctx, rng, seq)],
  ["reassign", 5, (ctx, rng, seq) => opReassign(ctx, rng, seq)],
  ["renew", 5, (ctx, rng, seq) => opRenew(ctx, rng, seq)],
  ["sweep", 8, (ctx, rng, seq) => opSweep(ctx, rng, seq)],
  ["review", 4, (ctx, rng, seq) => opReview(ctx, rng, seq)],
  ["set-wants", 6, (ctx, rng, seq) => opSetWants(ctx, rng, seq)],
  ["clear-wants", 3, (ctx, rng, seq) => opClearWants(ctx, rng, seq)],
  ["pause-toggle", 3, (ctx, rng) => opPauseToggle(ctx, rng)],
  ["trust-toggle", 2, (ctx) => opTrustToggle(ctx)],
  ["active-toggle", 3, (ctx, rng) => opActiveToggle(ctx, rng)],
  ["dup-notify", 3, (ctx, rng, seq) => opDupNotify(ctx, rng, seq)],
  ["hostile-notify", 2, (ctx, rng, seq) => opHostileNotify(ctx, rng, seq)],
  ["wake-failure", 2, (ctx, rng, seq) => opWakeFailure(ctx, rng, seq)],
  ["wake-direct", 2, (ctx, rng, seq) => opWakeDirect(ctx, rng, seq)],
  ["window-edge", 2, (ctx, rng, seq) => opWindowEdge(ctx, rng, seq)],
  ["link-pr", 3, (ctx, rng, seq) => opLinkPr(ctx, rng, seq)],
];
const TOTAL_W = OPS.reduce((n, o) => n + o[1], 0);
function pickOp(rng) {
  let r = ri(rng, TOTAL_W);
  for (const o of OPS) { r -= o[1]; if (r < 0) return o; }
  return OPS[0];
}

function runSequence(seq, violations, stats) {
  const rng = mulberry32((SEED ^ Math.imul(seq + 1, 0x9e3779b9)) >>> 0);
  const ctx = makeCtx();
  ctx.violations = violations;
  ctx.now = BASE_NOW + ri(rng, 3600000);
  ctx.hb.nowMs = ctx.now;
  const idCounter = { n: 0 };
  // Seed some wants_work rows up front so wakes fire from the first ops.
  for (const m of ["m0", "m1", "m2", "m3"]) {
    setWantsWork(ctx.db, ROOM, m, { labels: genLabels(rng), capabilities: genCaps(rng) }, ctx.now);
  }
  const nOps = 10 + ri(rng, 13);
  for (let step = 0; step < nOps; step++) {
    ctx.now += genDelta(rng);
    ctx.hb.nowMs = ctx.now;
    const op = pickOp(rng);
    stats.ops++;
    op[2](ctx, rng, seq, idCounter);
    checkInvariants(ctx, seq, step, op[0]);
    if (violations.length >= MAX_VIOLATIONS) return;
  }
  stats.sequences++;
  stats.wakes += ctx.stats.wakes;
  stats.folds += ctx.stats.folds;
  stats.sweeps += ctx.stats.sweeps;
  stats.races += ctx.stats.races;
}

test("fuzz-12: ready-queue / claim-wake fuzz", { timeout: 30 * 60 * 1000 }, () => {
  const t0 = Date.now();
  const violations = [];
  const stats = { sequences: 0, ops: 0, wakes: 0, folds: 0, sweeps: 0, races: 0 };
  for (let seq = 0; seq < N_SEQUENCES; seq++) {
    runSequence(seq, violations, stats);
    if (violations.length >= MAX_VIOLATIONS) break;
    if ((seq + 1) % 1000 === 0) {
      console.log("[fuzz-12] " + (seq + 1) + "/" + N_SEQUENCES + " sequences, ops=" + stats.ops +
        ", wakes=" + stats.wakes + ", folds=" + stats.folds + ", sweeps=" + stats.sweeps +
        ", races=" + stats.races + ", violations=" + violations.length +
        ", " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("[fuzz-12] done: sequences=" + stats.sequences + " ops=" + stats.ops +
    " wakes=" + stats.wakes + " folds=" + stats.folds + " sweeps=" + stats.sweeps +
    " races=" + stats.races + " violations=" + violations.length + " in " + secs + "s");
  if (violations.length > 0) {
    for (const v of violations.slice(0, 5)) console.log("[fuzz-12] VIOLATION " + JSON.stringify(v));
    assert.fail(violations.length + " invariant violation(s); first: " + JSON.stringify(violations[0]));
  }
});
