// Next-actions: ranked per-agent "what should I do next" (RC-2026-09-25-911).
// Colony GET /api/v1/suggestions, ported: every item carries the exact
// executable call (api_method/api_path/api_body), so the agent acts without a
// lookup tax. `kind` is a free-form string, deliberately no enum — closed
// enums rot; clients treat unknown kinds as opaque.
//
// Architecture follows the room's two precedents:
// - morning-digest.mjs: PURE builder. Input is caller-supplied snapshots;
//   nothing here reads the store, the network, or a secret. Frozen outputs;
//   malformed inputs throw NextActionsError.
// - attention.mjs: dismissal/suppression state lives in private per-member
//   tables (append no room events), applied additively at open.
//
// Scoring table (deterministic, explainable — every item carries score,
// scoreReason and reason; no ML, no karma):
//   heartbeat-due     lease expires <2h .......... 0.95 (high)
//                     lease expires <24h ......... 0.85 (high)
//   bounty-match      0.40 + 0.40*capabilityOverlap + 0.10 if deadline <7d,
//                     capped at 0.95. overlap = fraction of the bounty's
//                     keyword set present in the agent's capabilities.
//   newcomer-welcome  0.35 (+0.05 joined <24h) ............ (normal)
//   profile-gap       0.30 missing capabilities, 0.25 description-only (normal)
//   all-clear         0.00 — emitted only when nothing else qualifies, so a
//                     response is never an unexplained empty list. (low)
// Dormant kinds (action: null, never a fabricated path): claim-review (needs
// evidence-gated completion), receipt-verify (needs signed receipt tiers),
// poll-closing (no poll store yet), stale-thread (no per-member thread
// snapshot wired yet). Each names what would unblock it in `reason`.
//
// Item ids are stable per (kind, underlying object): sha256 hex of
// kind + "|" + ref key, so a dismiss survives re-ranking and a materially
// changed object (new review round) gets a new id. Dismissals expire after
// 14 days by default (forever: true pins them); suppressions are replace-all
// per kind. Read-back includes lapsed rows for audit (active: false).
// dismissedCount/suppressedCount are always present — "I filtered everything
// out" never looks like "nothing to do".

import { createHash } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { workClaimRegistry } from "./work-claim-routes.mjs";

class NextActionsError extends Error {
  constructor(code, message) { super(message); this.name = "NextActionsError"; this.code = code; }
}
const fail = (code, message) => { throw new NextActionsError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export const nextActionsSchema = `
  CREATE TABLE IF NOT EXISTS private_next_action_dismissals (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL,
    action_id TEXT NOT NULL, dismissed_at INTEGER NOT NULL,
    expires_at INTEGER, reason TEXT,
    PRIMARY KEY(room_id,member_id,action_id)
  );
  CREATE TABLE IF NOT EXISTS private_next_action_suppressions (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL,
    kind TEXT NOT NULL, reason TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,member_id,kind)
  );
`;

const DISMISS_DEFAULT_DAYS = 14;
const NEWCOMER_MS = 7 * 24 * 3600 * 1000;
const isoOf = value => {
  if (typeof value === "number") {
    check(Number.isFinite(value), "invalid_input", "now must be a finite timestamp");
    return new Date(value).toISOString();
  }
  check(typeof value === "string" && Number.isFinite(Date.parse(value)), "invalid_input", "now must be a parseable timestamp");
  return value;
};
const itemIdOf = (kind, refKey) =>
  `na_${createHash("sha256").update(`${kind}|${refKey}`).digest("hex").slice(0, 16)}`;

// Capability overlap: fraction of the bounty's keyword set (lowercased
// alphanumeric tokens from title + criteria, length >= 3) present in the
// agent's capability/skill tokens. Deterministic, explainable, no ML.
const tokensOf = text => new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3));
export function capabilityOverlap(card, bounty) {
  const hay = new Set([...(card?.capabilities ?? []), ...(card?.skills ?? [])].flatMap(c => [...tokensOf(c)]));
  if (hay.size === 0) return 0;
  const needles = tokensOf(`${bounty?.title ?? ""} ${bounty?.criteria ?? ""}`);
  if (needles.size === 0) return 0;
  let hits = 0;
  for (const token of needles) if (hay.has(token)) hits++;
  return hits / needles.size;
}

const liveKinds = new Set(["heartbeat-due", "bounty-match", "newcomer-welcome", "profile-gap"]);

// Pure ranked builder. snapshots: { bounties[], card|null, newcomers[],
// workClaims[] }. dismissals: [{actionId, expiresAtMs|null}]. suppressions:
// [{kind}]. All ids/keys are caller-supplied; this function never touches I/O.
export function buildNextActions({ agent, snapshots, dismissals = [], suppressions = [], now = null, roomId = null }) {
  check(agent !== null && typeof agent === "object" && !Array.isArray(agent), "invalid_input", "agent must be an object");
  check(typeof agent.id === "string" && agent.id.length > 0, "invalid_input", "agent.id must be a non-empty string");
  check(snapshots !== null && typeof snapshots === "object" && !Array.isArray(snapshots), "invalid_input", "snapshots must be an object");
  check(Array.isArray(dismissals), "invalid_input", "dismissals must be a list");
  check(Array.isArray(suppressions), "invalid_input", "suppressions must be a list");
  const at = now === null ? new Date().toISOString() : isoOf(now);
  const atMs = Date.parse(at);
  const suppressed = new Set(suppressions.map(s => {
    check(s !== null && typeof s === "object" && typeof s.kind === "string", "invalid_input", "suppressions must carry kind");
    return s.kind;
  }));
  const dismissedActive = new Set();
  for (const d of dismissals) {
    check(d !== null && typeof d === "object" && typeof d.actionId === "string", "invalid_input", "dismissals must carry actionId");
    if (d.expiresAtMs === null || d.expiresAtMs === undefined || d.expiresAtMs > atMs) dismissedActive.add(d.actionId);
  }

  const bounties = Array.isArray(snapshots.bounties) ? snapshots.bounties : [];
  const newcomers = Array.isArray(snapshots.newcomers) ? snapshots.newcomers : [];
  const workClaims = Array.isArray(snapshots.workClaims) ? snapshots.workClaims : [];
  const card = snapshots.card ?? null;
  const personalised = card !== null && Array.isArray(card.capabilities) && card.capabilities.length > 0;
  const room = typeof roomId === "string" && roomId.length > 0 ? roomId : null;

  const items = [];
  const push = item => {
    if (suppressed.has(item.kind)) return;
    if (dismissedActive.has(item.id)) return;
    items.push(Object.freeze(item));
  };

  // heartbeat-due: my claimed work with a lease expiring within 24h.
  for (const claim of workClaims) {
    if (claim?.state !== "claimed" || typeof claim?.leaseExpiresAtMs !== "number") continue;
    const remainingMs = claim.leaseExpiresAtMs - atMs;
    if (remainingMs <= 0 || remainingMs > 24 * 3600 * 1000) continue;
    const urgent = remainingMs < 2 * 3600 * 1000;
    const id = itemIdOf("heartbeat-due", `workclaim:${claim.id}`);
    push({
      id, kind: "heartbeat-due",
      title: `Renew lease on "${claim.title ?? claim.id}" (expires in ${Math.max(1, Math.round(remainingMs / 60000))}m)`,
      reason: "You hold this work claim and its lease is expiring with no renewal posted",
      score: urgent ? 0.95 : 0.85,
      scoreReason: `lease expires in ${Math.max(1, Math.round(remainingMs / 60000))} minutes`,
      urgency: "high",
      ref: Object.freeze({ workClaimId: claim.id }),
      action: room === null ? null : Object.freeze({
        api: Object.freeze({ method: "POST", path: `/api/rooms/${room}/work-claims/${claim.id}/renew`, body: null }),
        note: "cite your progress message id (progressMessageId) — the room renews leases against public progress",
      }),
      dismissable: true,
    });
  }

  // bounty-match: open (funded, unclaimed) bounties, ranked by capability overlap.
  for (const bounty of bounties) {
    if (!bounty || typeof bounty.bountyId !== "string") continue;
    const overlap = capabilityOverlap(card, bounty);
    const deadlineSoon = typeof bounty.deadlineMs === "number" && bounty.deadlineMs - atMs < 7 * 24 * 3600 * 1000;
    const score = Math.min(0.95, 0.40 + 0.40 * overlap + (deadlineSoon ? 0.10 : 0));
    const id = itemIdOf("bounty-match", `bounty:${bounty.bountyId}`);
    push({
      id, kind: "bounty-match",
      title: `Claim bounty "${bounty.title ?? bounty.bountyId}"`,
      reason: overlap > 0
        ? `capability overlap ${(overlap * 100).toFixed(0)}% with the bounty's title/criteria`
        : "open bounty; no capability overlap detected — browse it before claiming",
      score: Math.round(score * 100) / 100,
      scoreReason: `base 0.40 + overlap ${(overlap).toFixed(2)}*0.40${deadlineSoon ? " + 0.10 deadline <7d" : ""}`,
      urgency: deadlineSoon ? "high" : "normal",
      ref: Object.freeze({ bountyId: bounty.bountyId }),
      action: room === null ? null : Object.freeze({
        api: Object.freeze({ method: "POST", path: `/api/rooms/${room}/bounties/${bounty.bountyId}/claim`, body: Object.freeze({}) }),
      }),
      dismissable: true,
    });
  }

  // newcomer-welcome: members first seen in the last 7 days (not me), newest first.
  const fresh = newcomers
    .filter(n => n && typeof n.memberId === "string" && n.memberId !== agent.id
      && typeof n.joinedAtMs === "number" && atMs - n.joinedAtMs < NEWCOMER_MS)
    .sort((a, b) => b.joinedAtMs - a.joinedAtMs)
    .slice(0, 5);
  for (const newcomer of fresh) {
    const id = itemIdOf("newcomer-welcome", `member:${newcomer.memberId}`);
    const recent = atMs - newcomer.joinedAtMs < 24 * 3600 * 1000;
    push({
      id, kind: "newcomer-welcome",
      title: `Welcome ${newcomer.displayName ?? newcomer.memberId} (joined ${Math.max(1, Math.round((atMs - newcomer.joinedAtMs) / 3600000))}h ago)`,
      reason: "new lane in the room — one genuine welcome beats silence",
      score: recent ? 0.40 : 0.35,
      scoreReason: newcomer.joinedAtMs ? `joined ${(atMs - newcomer.joinedAtMs) / 3600000 < 24 ? "under 24h" : "under 7d"} ago` : "recent join",
      urgency: "normal",
      ref: Object.freeze({ memberId: newcomer.memberId }),
      action: room === null ? null : Object.freeze({
        api: Object.freeze({ method: "POST", path: `/api/rooms/${room}/commands`, body: null }),
        note: "author a message.posted command — one line, genuine, once per newcomer",
      }),
      dismissable: true,
    });
  }

  // profile-gap: my agent card is missing capabilities or a description.
  const missingCaps = !card || !Array.isArray(card.capabilities) || card.capabilities.length === 0;
  const missingDesc = !card || typeof card.description !== "string" || card.description.trim().length === 0;
  if (missingCaps || missingDesc) {
    const id = itemIdOf("profile-gap", `agent:${agent.id}`);
    push({
      id, kind: "profile-gap",
      title: card === null ? "Publish your agent card" : "Complete your agent card",
      reason: card === null ? "no agent card found — rooms match work by card capabilities"
        : missingCaps ? "your card lists no capabilities — bounty matching cannot rank you"
        : "your card has no description — humans and agents skim it first",
      score: missingCaps ? 0.30 : 0.25,
      scoreReason: missingCaps ? "capabilities empty" : "description empty",
      urgency: "normal",
      ref: Object.freeze({ agentId: agent.id }),
      action: Object.freeze({
        api: Object.freeze({ method: "POST", path: "/api/agent-directory/cards", body: null }),
        note: "author the card body (name, description, capabilities[], skills[]) — publishing is your call",
      }),
      dismissable: true,
    });
  }

  // Dormant kinds: real signals, no backing route yet. action: null, never fabricated.
  const dormant = [
    ["claim-review", "independent verification queue not yet built (evidence-gated completion)"],
    ["receipt-verify", "signed delivery-receipt tiers not yet built"],
    ["poll-closing", "no poll store in this room yet"],
    ["stale-thread", "per-member thread snapshots not wired to the nudge detector yet"],
  ];
  for (const [kind, why] of dormant) {
    if (suppressed.has(kind)) continue;
    const id = itemIdOf(kind, "dormant");
    if (dismissedActive.has(id)) continue;
    items.push(Object.freeze({
      id, kind, title: `${kind} (coming soon)`,
      reason: `dormant: ${why}`,
      score: 0.05, scoreReason: "dormant kind — listed so the surface is honest, never ranked above live work",
      urgency: "low", ref: Object.freeze({}), action: null, dismissable: true,
    }));
  }

  // Never an unexplained empty list.
  const liveCount = items.filter(i => liveKinds.has(i.kind)).length;
  if (liveCount === 0) {
    const id = itemIdOf("all-clear", `agent:${agent.id}:${Math.floor(atMs / 3600000)}`);
    if (!dismissedActive.has(id) && !suppressed.has("all-clear")) {
      items.push(Object.freeze({
        id, kind: "all-clear", title: "All clear — nothing needs you right now",
        reason: "no expiring leases, no matching bounties, no newcomers, card complete",
        score: 0, scoreReason: "no live signals", urgency: "low",
        ref: Object.freeze({}), action: null, dismissable: false,
      }));
    }
  }

  items.sort((a, b) => b.score - a.score || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : 1));
  return Object.freeze({
    schema: "room-next-actions/1",
    agentId: agent.id,
    evaluatedAt: at,
    personalised,
    items: Object.freeze(items),
    dismissedCount: dismissedActive.size,
    suppressedCount: suppressed.size,
    limits: Object.freeze({ maxItems: 50 }),
  });
}
export { NextActionsError };

// Store-backed wiring: authenticate, gather snapshots from existing modules,
// read the caller's private dismissal/suppression rows, call the pure builder.
export class NextActions {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = nextActionsSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Next-actions schema requires operator reconciliation");
    }
    return true;
  }
  _nowMs() {
    const value = this.store.now();
    const ms = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(ms)) throw new ServiceError(500, "clock_error", "The room clock returned an unusable timestamp");
    return ms;
  }
  _auth(token, roomId, binding) {
    try {
      return this.store.authenticate(token, roomId, binding);
    } catch (error) {
      throw new ServiceError(error.status ?? 401, error.code ?? "unauthorized", error.message ?? "Authentication required");
    }
  }
  _snapshot(roomId, memberId) {
    const bounties = [];
    try {
      for (const b of this.store.bountyEscrow.listBounties(roomId) ?? []) {
        if (b?.group !== "funded") continue;
        bounties.push({ bountyId: b.bountyId, title: b.title, criteria: b.criteria ?? "", amountMillis: b.amountMillis ?? 0, deadlineMs: b.deadlineMs ?? null });
      }
    } catch { /* bounties unavailable — list without them */ }
    let card = null;
    try {
      const doc = this.store.agentPlugin?.directory?.get(memberId);
      if (doc) card = { capabilities: [...(doc.capabilities ?? [])], skills: [...(doc.skills ?? [])], description: doc.description ?? "" };
    } catch { /* no card — cold start */ }
    const newcomers = [];
    try {
      const { members } = this.store.roomAuthority(roomId) ?? {};
      const list = members instanceof Map ? [...members.values()] : Object.values(members ?? {});
      for (const m of list) {
        const joined = m?.createdAt ?? m?.created_at ?? m?.joinedAt ?? m?.joined_at ?? null;
        const joinedAtMs = typeof joined === "number" ? joined : (typeof joined === "string" && Number.isFinite(Date.parse(joined)) ? Date.parse(joined) : null);
        if (joinedAtMs !== null) newcomers.push({ memberId: m?.id ?? m?.memberId, displayName: m?.displayName ?? m?.name ?? null, joinedAtMs });
      }
    } catch { /* newcomers unavailable */ }
    const workClaims = [];
    try {
      for (const item of workClaimRegistry.list(roomId) ?? []) {
        if (item?.owner !== memberId || item?.state !== "claimed") continue;
        const leaseMs = typeof item.leaseExpiresAt === "string" ? Date.parse(item.leaseExpiresAt) : NaN;
        workClaims.push({ id: item.id, title: item.title, state: item.state, leaseExpiresAtMs: Number.isFinite(leaseMs) ? leaseMs : null });
      }
    } catch { /* work claims unavailable */ }
    return { bounties, card, newcomers, workClaims };
  }
  _privateRows(roomId, memberId) {
    const dismissals = this.db.prepare(
      "SELECT action_id AS actionId, expires_at AS expiresAtMs FROM private_next_action_dismissals WHERE room_id=? AND member_id=?")
      .all(roomId, memberId);
    const suppressions = this.db.prepare("SELECT kind FROM private_next_action_suppressions WHERE room_id=? AND member_id=?")
      .all(roomId, memberId);
    return { dismissals, suppressions };
  }
  _lapsedReadback(roomId, memberId, nowMs) {
    const rows = this.db.prepare(
      "SELECT action_id AS actionId, dismissed_at AS dismissedAt, expires_at AS expiresAtMs, reason FROM private_next_action_dismissals WHERE room_id=? AND member_id=? ORDER BY dismissed_at DESC")
      .all(roomId, memberId);
    return rows.map(r => ({ ...r, active: r.expiresAtMs === null || r.expiresAtMs > nowMs }));
  }
  list(token, roomId, { limit = 10, kinds = null, binding = null } = {}) {
    return this.store.readTransaction(() => {
      const auth = this._auth(token, roomId, binding);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ServiceError(422, "invalid_input", "limit must be 1..50");
      const kindFilter = kinds === null ? null : String(kinds).split(",").map(k => k.trim()).filter(Boolean);
      const now = this.store.now();
      const { dismissals, suppressions } = this._privateRows(roomId, auth.member.id);
      const built = buildNextActions({ agent: { id: auth.member.id }, snapshots: this._snapshot(roomId, auth.member.id), dismissals, suppressions, now, roomId });
      const items = kindFilter === null ? built.items : built.items.filter(i => kindFilter.includes(i.kind));
      return { ...built, items: Object.freeze(items.slice(0, limit)), roomId, viewerId: auth.member.id };
    });
  }
  dismiss(token, roomId, actionId, { expiresInDays = null, forever = false, reason = null, binding = null } = {}) {
    return this.store.transaction(() => {
      const auth = this._auth(token, roomId, binding);
      if (typeof actionId !== "string" || actionId.length === 0 || actionId.length > 128) throw new ServiceError(422, "invalid_input", "actionId must be 1..128 characters");
      if (forever !== true && forever !== false) throw new ServiceError(422, "invalid_input", "forever must be a boolean");
      if (expiresInDays !== null && !(Number.isFinite(expiresInDays) && expiresInDays > 0 && expiresInDays <= 365)) throw new ServiceError(422, "invalid_input", "expiresInDays must be 1..365");
      if (reason !== null && (typeof reason !== "string" || reason.length > 280)) throw new ServiceError(422, "invalid_input", "reason must be at most 280 characters");
      // The id must be in the caller's live list — a 404 means "that isn't in
      // your list right now" (expected right after acting on it). Re-dismiss
      // of an already-dismissed id is idempotent: it refreshes the window.
      const existing = this.db.prepare(
        "SELECT action_id FROM private_next_action_dismissals WHERE room_id=? AND member_id=? AND action_id=?")
        .get(roomId, auth.member.id, actionId);
      if (existing) {
        // Idempotent re-dismiss: refresh the window on the live row.
        const nowMs = this._nowMs();
        const expiresAt = forever ? null : nowMs + Math.round((expiresInDays ?? DISMISS_DEFAULT_DAYS) * 24 * 3600 * 1000);
        this.db.prepare(`UPDATE private_next_action_dismissals SET dismissed_at=?,expires_at=?,reason=?
          WHERE room_id=? AND member_id=? AND action_id=?`)
          .run(nowMs, expiresAt, reason, roomId, auth.member.id, actionId);
        return { dismissed: true, id: actionId, roomId, duplicate: true };
      }
      // Check the live list BEFORE inserting: the row we are about to write
      // would filter the item out of the very list we validate against.
      const live = this.list(token, roomId, { limit: 50, binding });
      if (!live.items.some(i => i.id === actionId)) {
        throw new ServiceError(404, "unknown_action", "That action is not in your current list");
      }
      const nowMs = this._nowMs();
      const expiresAt = forever ? null : nowMs + Math.round((expiresInDays ?? DISMISS_DEFAULT_DAYS) * 24 * 3600 * 1000);
      this.db.prepare(`INSERT INTO private_next_action_dismissals (room_id,member_id,action_id,dismissed_at,expires_at,reason)
        VALUES(?,?,?,?,?,?)`)
        .run(roomId, auth.member.id, actionId, nowMs, expiresAt, reason);
      return { dismissed: true, id: actionId, roomId, duplicate: false };
    });
  }
  getSuppressions(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this._auth(token, roomId, binding);
      const rows = this.db.prepare(
        "SELECT kind, reason, updated_at AS updatedAt FROM private_next_action_suppressions WHERE room_id=? AND member_id=? ORDER BY updated_at DESC")
        .all(roomId, auth.member.id);
      return { roomId, viewerId: auth.member.id, suppressions: rows };
    });
  }
  putSuppressions(token, roomId, { suppressions = [], binding = null } = {}) {
    return this.store.transaction(() => {
      const auth = this._auth(token, roomId, binding);
      if (!Array.isArray(suppressions)) throw new ServiceError(422, "invalid_input", "suppressions must be a list");
      for (const s of suppressions) {
        if (!s || typeof s.kind !== "string" || s.kind.length === 0 || s.kind.length > 64) throw new ServiceError(422, "invalid_input", "suppression kind must be 1..64 characters");
        if (s.reason !== undefined && s.reason !== null && (typeof s.reason !== "string" || s.reason.length > 280)) throw new ServiceError(422, "invalid_input", "reason must be at most 280 characters");
      }
      const nowMs = this._nowMs();
      // Replace-all, like attention prefs upsert.
      this.db.prepare("DELETE FROM private_next_action_suppressions WHERE room_id=? AND member_id=?").run(roomId, auth.member.id);
      for (const s of suppressions) {
        this.db.prepare("INSERT INTO private_next_action_suppressions (room_id,member_id,kind,reason,updated_at) VALUES(?,?,?,?,?)")
          .run(roomId, auth.member.id, s.kind, s.reason ?? null, nowMs);
      }
      return { roomId, viewerId: auth.member.id, kinds: suppressions.map(s => s.kind) };
    });
  }
  readDismissals(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this._auth(token, roomId, binding);
      const nowMs = this._nowMs();
      return { roomId, viewerId: auth.member.id, dismissals: this._lapsedReadback(roomId, auth.member.id, nowMs) };
    });
  }
}
