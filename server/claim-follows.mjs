// COMP-DEEP #6 (CONVO CV-3): claim follow records with totals.
//
// Membership-style follow rows for work claims, after Mattermost's
// ThreadMembership and Zulip's UserTopic: one row per (room, member, claim),
// created implicitly on involvement — the member created, claimed, commented
// on, was mentioned on, or was named reviewer of the claim — with a per-claim
// attention policy (follow | mute | inherit) the member can override without
// losing the row's history. Counters are part of the contract, not client
// arithmetic: unreadCount counts claim events since the member's last read,
// mentionCount counts the events that mentioned them, and claimFollowTotals
// aggregates both for CD-01's needs-me surface (the section rides in
// collectNeedsMe and on GET /work-claims/follows).
//
// Ordering is the room event sequence (emitWorkClaimEvent's per-room seq):
// lastReadSeq / lastEventSeq are room-sequence numbers, the same cursor
// needs-me already speaks. Storage follows the work-claim registry's
// conventions: a plain table beside work_claims (the table also lives in
// workClaimSchema) written with prepared statements, whole-row upserts, and
// no second store. bounty_watchers (server/bounty-escrow.mjs) is the bounty
// noun's watcher list — no policy, no counters — and stays separate: claims
// are this module's scope and the two never share rows.
//
// Every function takes a SQLite handle (store.db) and never throws on a
// missing table: partial stores (handler unit fixtures) simply have no
// follow state yet, and ensureClaimFollowSchema creates it lazily.

export const CLAIM_FOLLOW_POLICIES = Object.freeze(["follow", "mute", "inherit"]);
export const CLAIM_FOLLOW_VIAS = Object.freeze(["create", "claim", "comment", "mention", "review-assignment", "manual"]);

export const claimFollowSchema = `
  CREATE TABLE IF NOT EXISTS claim_follows (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    policy TEXT NOT NULL DEFAULT 'follow',
    unread_count INTEGER NOT NULL DEFAULT 0,
    mention_count INTEGER NOT NULL DEFAULT 0,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    created_via TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, member_id, claim_id)
  );
`;

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function ensureClaimFollowSchema(db) {
  if (!db || typeof db.exec !== "function") return false;
  db.exec(claimFollowSchema);
  return true;
}

function hasFollowTable(db) {
  if (!db || typeof db.prepare !== "function") return false;
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claim_follows'").get());
  } catch { return false; }
}

function ready(db) {
  if (!db || typeof db.prepare !== "function") return false;
  if (hasFollowTable(db)) return true;
  try { return ensureClaimFollowSchema(db) && hasFollowTable(db); }
  catch { return false; }
}

const view = row => row == null ? null : ({
  memberId: row.member_id,
  claimId: row.claim_id,
  roomId: row.room_id,
  policy: row.policy,
  following: row.policy === "follow",
  unreadCount: row.unread_count,
  mentionCount: row.mention_count,
  lastReadSeq: row.last_read_seq,
  lastEventSeq: row.last_event_seq,
  createdVia: row.created_via,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const validId = value => typeof value === "string" && value.length > 0 && value.length <= 384;
const seqOf = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);

function checkScope(roomId, memberId, claimId) {
  if (!validId(roomId)) throw new TypeError("claim follow needs a roomId");
  if (!validId(memberId)) throw new TypeError("claim follow needs a memberId");
  if (!validId(claimId)) throw new TypeError("claim follow needs a claimId");
}

// Create the row if absent (policy 'follow', createdVia = via). An existing
// row keeps its policy and its first createdVia: a member who muted a claim
// is never silently re-followed by later involvement, and provenance names
// the involvement that first subscribed them. Returns the record view.
export function followClaim(db, { roomId, memberId, claimId, via = "manual", at = Date.now(), seq = 0 } = {}) {
  checkScope(roomId, memberId, claimId);
  if (!CLAIM_FOLLOW_VIAS.includes(via)) throw new TypeError(`unknown claim follow via: ${via}`);
  if (!ready(db)) return null;
  const stamp = Number.isFinite(at) ? at : Date.now();
  db.prepare(`INSERT INTO claim_follows
      (room_id, member_id, claim_id, policy, unread_count, mention_count, last_read_seq, last_event_seq, created_via, created_at, updated_at)
      VALUES (?, ?, ?, 'follow', 0, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id, member_id, claim_id) DO UPDATE SET updated_at = excluded.updated_at`)
    .run(roomId, memberId, claimId, seqOf(seq), seqOf(seq), via, stamp, stamp);
  return getClaimFollow(db, { roomId, memberId, claimId });
}

export function getClaimFollow(db, { roomId, memberId, claimId } = {}) {
  checkScope(roomId, memberId, claimId);
  if (!ready(db)) return null;
  const row = db.prepare("SELECT * FROM claim_follows WHERE room_id=? AND member_id=? AND claim_id=?")
    .get(roomId, memberId, claimId);
  return view(row ?? null);
}

// The per-claim override: follow | mute | inherit. Muting never deletes the
// record — counters, seqs and createdVia stay as history; the policy alone
// decides whether new activity accrues. Creates the row (via 'manual') when
// the member sets a policy on a claim they have no row for yet.
export function setClaimFollowPolicy(db, { roomId, memberId, claimId, policy, at = Date.now(), seq = 0 } = {}) {
  checkScope(roomId, memberId, claimId);
  if (!CLAIM_FOLLOW_POLICIES.includes(policy)) throw new TypeError(`unknown claim follow policy: ${policy}`);
  if (!ready(db)) return null;
  const stamp = Number.isFinite(at) ? at : Date.now();
  db.prepare(`INSERT INTO claim_follows
      (room_id, member_id, claim_id, policy, unread_count, mention_count, last_read_seq, last_event_seq, created_via, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?, 'manual', ?, ?)
    ON CONFLICT(room_id, member_id, claim_id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at`)
    .run(roomId, memberId, claimId, policy, seqOf(seq), seqOf(seq), stamp, stamp);
  return getClaimFollow(db, { roomId, memberId, claimId });
}

// One claim event landed at room sequence `seq`. Every follower whose policy
// is not mute accrues one unread event (the actor never counts their own
// event); members named in mentionMemberIds additionally accrue a mention.
// lastEventSeq advances for every row, muted included — it is the claim's
// event horizon for that member, not a notification. Returns the number of
// rows that accrued unread.
export function recordClaimFollowActivity(db, { roomId, claimId, seq = 0, actorId = null, mentionMemberIds = [], at = Date.now() } = {}) {
  if (!validId(roomId) || !validId(claimId)) throw new TypeError("claim follow activity needs roomId and claimId");
  if (!ready(db)) return 0;
  const stamp = Number.isFinite(at) ? at : Date.now();
  const atSeq = seqOf(seq);
  const mentions = new Set((mentionMemberIds ?? []).filter(id => validId(id) && id !== actorId));
  const rows = db.prepare("SELECT member_id, policy FROM claim_follows WHERE room_id=? AND claim_id=?").all(roomId, claimId);
  let accrued = 0;
  const bump = db.prepare(`UPDATE claim_follows SET unread_count = unread_count + 1,
      mention_count = mention_count + ?, last_event_seq = MAX(last_event_seq, ?), updated_at = ?
    WHERE room_id=? AND member_id=? AND claim_id=?`);
  const horizon = db.prepare(`UPDATE claim_follows SET last_event_seq = MAX(last_event_seq, ?), updated_at = ?
    WHERE room_id=? AND member_id=? AND claim_id=?`);
  for (const row of rows) {
    if (row.policy === "mute" || row.member_id === actorId) {
      horizon.run(atSeq, stamp, roomId, row.member_id, claimId);
      continue;
    }
    bump.run(mentions.has(row.member_id) ? 1 : 0, atSeq, stamp, roomId, row.member_id, claimId);
    accrued += 1;
  }
  return accrued;
}

// Reading the claim: advance lastReadSeq (never backwards) to the claim's
// latest event seq for this member — or to `seq` when the caller knows the
// room's current sequence — and zero the counters. No row, no-op: reading a
// claim you do not follow does not subscribe you to it.
export function markClaimFollowRead(db, { roomId, memberId, claimId, seq = 0, at = Date.now() } = {}) {
  checkScope(roomId, memberId, claimId);
  if (!ready(db)) return null;
  const stamp = Number.isFinite(at) ? at : Date.now();
  db.prepare(`UPDATE claim_follows SET
      last_read_seq = MAX(last_read_seq, last_event_seq, ?),
      unread_count = 0, mention_count = 0, updated_at = ?
    WHERE room_id=? AND member_id=? AND claim_id=?`)
    .run(seqOf(seq), stamp, roomId, memberId, claimId);
  return getClaimFollow(db, { roomId, memberId, claimId });
}

export function listClaimFollows(db, { roomId, memberId } = {}) {
  if (!validId(roomId) || !validId(memberId)) throw new TypeError("claim follow list needs roomId and memberId");
  if (!ready(db)) return [];
  return db.prepare("SELECT * FROM claim_follows WHERE room_id=? AND member_id=? ORDER BY claim_id ASC")
    .all(roomId, memberId).map(view);
}

// The totals CD-01 aggregates: { followedClaims, unreadClaims, unreadEvents,
// mentions } for one member — in one room, or across every room when roomId
// is omitted. followedClaims counts policy='follow' rows only; unread counts
// only accrue on non-muted rows, so the sums already honour mute.
export function claimFollowTotals(db, { roomId = null, memberId } = {}) {
  if (!validId(memberId)) throw new TypeError("claim follow totals need a memberId");
  if (roomId !== null && !validId(roomId)) throw new TypeError("claim follow totals roomId must be an id or null");
  const empty = { followedClaims: 0, unreadClaims: 0, unreadEvents: 0, mentions: 0 };
  if (!ready(db)) return empty;
  const where = roomId === null ? "member_id=?" : "room_id=? AND member_id=?";
  const args = roomId === null ? [memberId] : [roomId, memberId];
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN policy='follow' THEN 1 ELSE 0 END), 0) AS followed,
      COALESCE(SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END), 0) AS unread_claims,
      COALESCE(SUM(unread_count), 0) AS unread_events,
      COALESCE(SUM(mention_count), 0) AS mention_total
    FROM claim_follows WHERE ${where}`).get(...args);
  return {
    followedClaims: row?.followed ?? 0,
    unreadClaims: row?.unread_claims ?? 0,
    unreadEvents: row?.unread_events ?? 0,
    mentions: row?.mention_total ?? 0,
  };
}

// The wiring core, called by emitWorkClaimEvent for every committed claim
// event and unit-tested directly. Derives the implicit follows from the
// event, then accrues the event's activity. Named reviewers are resolved by
// the caller (resolveNamedReviewers needs the room's member map) and passed
// in as reviewerIds. Returns a small summary, or null when the store has no
// follow table. Callers wrap this so follow bookkeeping can never roll back
// a claim write.
export function syncClaimFollowsForEvent(db, { roomId, claimId, item = null, action, actorId = null, sequence = 0, reviewerIds = [], attentionMemberId = null, followVia = null, at = Date.now() } = {}) {
  if (!validId(roomId) || !validId(claimId) || !ready(db)) return null;
  const stamp = Number.isFinite(at) ? at : Date.now();
  const seq = seqOf(sequence);
  const followed = [];
  const ensure = (memberId, via) => {
    if (!validId(memberId)) return;
    followClaim(db, { roomId, memberId, claimId, via, at: stamp, seq });
    followed.push(memberId);
  };
  if (action === "created") ensure(actorId, "create");
  // A taken claim: actor == new owner. A claim assigned at creation emits
  // 'claimed' with the creator as actor — the creator's via is 'create'.
  if (action === "claimed") {
    ensure(item?.owner, "claim");
    if (actorId && actorId !== item?.owner) ensure(actorId, "create");
    else ensure(actorId, "claim");
  }
  if (action === "reassigned") ensure(item?.owner, "claim");
  if (action === "reviewed") ensure(actorId, "comment");
  if (followVia === "comment") ensure(actorId, "comment");
  for (const memberId of reviewerIds ?? []) ensure(memberId, "review-assignment");
  const mentionIds = [];
  if (validId(attentionMemberId)) { ensure(attentionMemberId, "mention"); mentionIds.push(attentionMemberId); }
  const accrued = recordClaimFollowActivity(db, { roomId, claimId, seq, actorId, mentionMemberIds: mentionIds, at: stamp });
  return { followed, accrued };
}

// A discussion message landed on a claim (store.trackMentions): the author
// follows via 'comment'; each resolved @mention target follows via 'mention'
// and accrues the mention (and the event's unread) immediately, since the
// message is itself the claim event for counter purposes.
export function syncClaimFollowsForDiscussion(db, { roomId, claimId, authorId = null, mentionMemberIds = [], sequence = 0, at = Date.now() } = {}) {
  if (!validId(roomId) || !validId(claimId) || !ready(db)) return null;
  const stamp = Number.isFinite(at) ? at : Date.now();
  const seq = seqOf(sequence);
  if (validId(authorId)) followClaim(db, { roomId, memberId: authorId, claimId, via: "comment", at: stamp, seq });
  for (const memberId of mentionMemberIds ?? []) {
    if (validId(memberId) && memberId !== authorId) followClaim(db, { roomId, memberId, claimId, via: "mention", at: stamp, seq });
  }
  const accrued = recordClaimFollowActivity(db, { roomId, claimId, seq, actorId: authorId, mentionMemberIds, at: stamp });
  return { accrued };
}

// Resolve a discussion workItemId to the claim that carries it: board claims
// usually reuse the work item id as the claim id; otherwise the claim row
// names it in item_json.workItemId. Returns the claim id or null.
export function claimIdForWorkItem(db, roomId, workItemId) {
  if (!db || typeof db.prepare !== "function" || !validId(roomId) || !validId(workItemId)) return null;
  try {
    const direct = db.prepare("SELECT claim_id FROM work_claims WHERE room_id=? AND claim_id=?").get(roomId, workItemId);
    if (direct) return direct.claim_id;
    const linked = db.prepare("SELECT claim_id FROM work_claims WHERE room_id=? AND json_extract(item_json, '$.workItemId')=? LIMIT 1").get(roomId, workItemId);
    return linked?.claim_id ?? null;
  } catch { return null; }
}
