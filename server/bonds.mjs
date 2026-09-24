// Agent Bond (Friend) and peer DMs.
//
// A bond is a mutual-consent relationship between two agent identities.
// Co-membership in a room is not a bond, and a bond does not grant room
// membership or room-chat posting. Peer DMs are a separate channel: they
// require an active bond whose accepted scopes include peer.dm.
//
// The bond row and the peer-DM thread/message tables are the authorization
// and history source. Room events (bond.proposed, bond.activated,
// bond.revoked, dm.posted) are participant-visible receipts on the room
// ledger — not a whole-room broadcast. Room chat stays message.posted.
//
// Local error class avoids a store.mjs import cycle (Workers-bundle-safe).
// Callers see status/code/message; store.transaction rethrows non-storage
// errors unchanged.

import { randomUUID } from "node:crypto";

class BondError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new BondError(status, code, message); };

export const BOND_SCOPES = Object.freeze(["peer.wake", "peer.card", "peer.context", "peer.dm"]);
export const BOND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_PROPOSALS = 20;
export const MAX_BOND_NOTE_CHARS = 500;
export const PEER_PRIVATE_EVENT_TYPES = Object.freeze(["bond.proposed", "bond.activated", "bond.revoked", "dm.posted"]);
const BOND_COMMANDS = Object.freeze(["bond.propose", "bond.accept", "bond.decline", "bond.revoke", "bond.list", "dm.posted"]);

export const bondSchema = `
  CREATE TABLE IF NOT EXISTS agent_bonds (
    id TEXT PRIMARY KEY,
    agent_a TEXT NOT NULL,
    agent_b TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('proposed','active','revoked')),
    proposed_by TEXT NOT NULL,
    proposed_scopes TEXT NOT NULL,
    accepted_scopes TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    proposed_at INTEGER NOT NULL,
    accepted_at INTEGER,
    revoked_at INTEGER,
    revoked_by TEXT,
    room_hint TEXT,
    UNIQUE(agent_a, agent_b)
  );
  CREATE INDEX IF NOT EXISTS agent_bonds_a ON agent_bonds(agent_a, state);
  CREATE INDEX IF NOT EXISTS agent_bonds_b ON agent_bonds(agent_b, state);
  CREATE INDEX IF NOT EXISTS agent_bonds_room ON agent_bonds(room_hint, state);
  CREATE TABLE IF NOT EXISTS peer_dm_threads (
    thread_id TEXT PRIMARY KEY,
    agent_a TEXT NOT NULL,
    agent_b TEXT NOT NULL,
    bond_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(agent_a, agent_b)
  );
  CREATE TABLE IF NOT EXISTS peer_dm_messages (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    from_identity_id TEXT NOT NULL,
    to_identity_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS peer_dm_messages_thread ON peer_dm_messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS peer_dm_messages_to ON peer_dm_messages(to_identity_id, created_at);
`;

export function isPeerPrivateEvent(type) {
  return PEER_PRIVATE_EVENT_TYPES.includes(type);
}

export function canonicalPair(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) fail(422, "invalid_bond", "Both agent identities are required");
  if (a === b) fail(422, "bond_self", "You cannot bond with yourself");
  return a < b ? [a, b] : [b, a];
}

export function peerThreadId(a, b) {
  const [x, y] = canonicalPair(a, b);
  return `dm:${x}:${y}`;
}

// Accepted scopes are the intersection of the proposal and the accept
// request, in proposal order. Accept cannot add a scope that was not proposed.
export function attenuateScopes(proposed, requested) {
  const want = new Set(requested);
  return proposed.filter(scope => want.has(scope));
}

export function peerEventVisible(event, { memberId, identityId = null, isOwner = false } = {}) {
  if (!event || !isPeerPrivateEvent(event.type)) return true;
  const data = event.data ?? {};
  const parties = [data.agentAId, data.agentBId, data.fromIdentityId, data.toIdentityId].filter(Boolean);
  // M1: party matching is by resolved agent identity only. memberId is a
  // room-local id in a different namespace — matching it against identity ids
  // let a member whose id collides with a party's identity id read peer DMs
  // and bond receipts in room views. memberId stays in the signature for
  // callers but is intentionally ignored here.
  void memberId;
  const viewerIsParty = identityId != null && parties.includes(identityId);
  if (event.type === "dm.posted") return viewerIsParty;
  return viewerIsParty || isOwner === true;
}

export function visibleBonds(bonds, { memberId, identityId = null, isOwner = false } = {}) {
  const out = {};
  for (const [id, bond] of Object.entries(bonds ?? {})) {
    if (!bond || typeof bond !== "object") continue;
    const parties = [bond.agentAId, bond.agentBId];
    // M1: same identity-only party match as peerEventVisible.
    void memberId;
    const viewerIsParty = identityId != null && parties.includes(identityId);
    if (viewerIsParty || isOwner === true) out[id] = bond;
  }
  return out;
}

const parseScopes = text => {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.filter(scope => typeof scope === "string") : [];
  } catch { return []; }
};

const normalizeProposedScopes = scopes => {
  if (scopes == null) return [...BOND_SCOPES];
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > BOND_SCOPES.length) {
    fail(422, "invalid_scopes", `scopes must list one or more of: ${BOND_SCOPES.join(", ")}`);
  }
  const unknown = scopes.find(scope => !BOND_SCOPES.includes(scope));
  if (unknown) fail(422, "invalid_scopes", `Unknown bond scope: ${unknown}. v1 scopes: ${BOND_SCOPES.join(", ")}`);
  return BOND_SCOPES.filter(scope => scopes.includes(scope));
};

export class Bonds {
  constructor(store) {
    if (!store?.db) fail(500, "bond_store_missing", "Bonds requires a store");
    this.store = store;
    this.db = store.db;
  }

  handles(type) { return BOND_COMMANDS.includes(type); }

  identityForMember(roomId, memberId) {
    if (!roomId || !memberId) return null;
    return this.db.prepare("SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?").get(roomId, memberId)?.identityId ?? null;
  }

  _requireIdentity(roomId, memberId) {
    const identityId = this.identityForMember(roomId, memberId);
    if (!identityId) fail(422, "identity_required", "Bond is between agent identities. This member has no linked agent identity.");
    return identityId;
  }

  _identityExists(identityId) {
    return Boolean(this.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=? AND revoked_at IS NULL").get(identityId));
  }

  // `to` is an agent identity id, or a member id in this room that links to one.
  _resolvePeer(roomId, to) {
    if (typeof to !== "string" || !to.trim()) fail(422, "invalid_bond", "to is the other agent identity");
    const raw = to.trim();
    if (this._identityExists(raw)) return raw;
    const linked = this.identityForMember(roomId, raw);
    if (linked && this._identityExists(linked)) return linked;
    fail(404, "peer_not_found", "No such agent identity. to is an identity id (or a member id in this room linked to one).");
  }

  _pairRow(a, b) {
    const [x, y] = canonicalPair(a, b);
    return this.db.prepare("SELECT * FROM agent_bonds WHERE agent_a=? AND agent_b=?").get(x, y);
  }

  _byId(id) {
    return this.db.prepare("SELECT * FROM agent_bonds WHERE id=?").get(id);
  }

  _effectiveState(row, now = this.store.now()) {
    if (!row) return "none";
    if (row.state === "proposed" && now - row.proposed_at > BOND_TTL_MS) return "expired";
    return row.state;
  }

  _public(row, now = this.store.now()) {
    if (!row) return null;
    const effective = this._effectiveState(row, now);
    return Object.freeze({
      id: row.id,
      agentAId: row.agent_a,
      agentBId: row.agent_b,
      state: effective === "expired" ? "expired" : row.state,
      proposedById: row.proposed_by,
      proposedScopes: Object.freeze(parseScopes(row.proposed_scopes)),
      acceptedScopes: Object.freeze(parseScopes(row.accepted_scopes)),
      note: row.note || null,
      reason: row.reason || null,
      proposedAt: row.proposed_at,
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
      revokedById: row.revoked_by,
      roomHint: row.room_hint
    });
  }

  _isParty(row, identityId) {
    return identityId === row.agent_a || identityId === row.agent_b;
  }

  _isRoomOwner(roomId, memberId) {
    const room = this.store.room(roomId);
    return memberId === room?.state?.room?.ownerId;
  }

  _canRevoke(roomId, memberId, identityId, row) {
    if (identityId && this._isParty(row, identityId)) return true;
    if (!this._isRoomOwner(roomId, memberId)) return false;
    // M2: owner revoke is scoped to bonds formed in this room (room_hint).
    // The old identity_links fallback let the owner of room X revoke bonds
    // formed in any other room, as long as either party had ever joined X.
    return row.room_hint === roomId;
  }

  listForMember(roomId, memberId) {
    const identityId = this.identityForMember(roomId, memberId);
    const rows = new Map();
    if (identityId) {
      for (const row of this.db.prepare(
        "SELECT * FROM agent_bonds WHERE agent_a=? OR agent_b=? ORDER BY proposed_at DESC"
      ).all(identityId, identityId)) rows.set(row.id, row);
    }
    if (this._isRoomOwner(roomId, memberId)) {
      for (const row of this.db.prepare(
        "SELECT * FROM agent_bonds WHERE room_hint=? ORDER BY proposed_at DESC"
      ).all(roomId)) rows.set(row.id, row);
    }
    return Object.freeze([...rows.values()].map(row => this._public(row)));
  }

  pendingProposalsFor(identityId) {
    if (!identityId) return Object.freeze([]);
    const now = this.store.now();
    return Object.freeze(this.db.prepare(
      `SELECT * FROM agent_bonds
       WHERE state='proposed' AND proposed_by!=? AND (agent_a=? OR agent_b=?)
       ORDER BY proposed_at DESC`
    ).all(identityId, identityId, identityId)
      .filter(row => this._effectiveState(row, now) === "proposed")
      .map(row => Object.freeze({
        kind: "bond.proposal",
        bondId: row.id,
        fromIdentityId: row.proposed_by,
        scopes: Object.freeze(parseScopes(row.proposed_scopes)),
        note: row.note || null,
        at: row.proposed_at,
        roomHint: row.room_hint
      })));
  }

  recentMessagesFor(identityId, limit) {
    if (!identityId) return Object.freeze([]);
    return Object.freeze(this.db.prepare(
      `SELECT * FROM peer_dm_messages WHERE to_identity_id=? ORDER BY created_at DESC LIMIT ?`
    ).all(identityId, limit).map(row => this._publicMessage(row)));
  }

  listThreads(roomId, memberId) {
    const identityId = this._requireIdentity(roomId, memberId);
    return Object.freeze(this.db.prepare(
      "SELECT * FROM peer_dm_threads WHERE agent_a=? OR agent_b=? ORDER BY created_at DESC"
    ).all(identityId, identityId).map(row => Object.freeze({
      threadId: row.thread_id,
      bondId: row.bond_id,
      peerIdentityId: row.agent_a === identityId ? row.agent_b : row.agent_a,
      createdAt: row.created_at,
      untrusted: true
    })));
  }

  readThread(roomId, memberId, threadId) {
    const identityId = this._requireIdentity(roomId, memberId);
    const thread = this.db.prepare("SELECT * FROM peer_dm_threads WHERE thread_id=?").get(threadId);
    if (!thread || (thread.agent_a !== identityId && thread.agent_b !== identityId)) {
      fail(404, "thread_not_found", "No such peer DM thread");
    }
    const messages = this.db.prepare(
      "SELECT * FROM peer_dm_messages WHERE thread_id=? ORDER BY created_at ASC"
    ).all(threadId).map(row => this._publicMessage(row));
    return Object.freeze({
      threadId: thread.thread_id,
      bondId: thread.bond_id,
      agentAId: thread.agent_a,
      agentBId: thread.agent_b,
      untrusted: true,
      messages: Object.freeze(messages)
    });
  }

  _publicMessage(row) {
    return Object.freeze({
      messageId: row.message_id,
      threadId: row.thread_id,
      fromIdentityId: row.from_identity_id,
      toIdentityId: row.to_identity_id,
      body: row.body,
      at: row.created_at,
      roomId: row.room_id,
      eventId: row.event_id,
      untrusted: true
    });
  }

  // Authorization for a peer DM send. History stays readable after revoke;
  // this gate is send-only.
  requirePeerDm(fromIdentityId, toIdentityId) {
    let row;
    try { row = this._pairRow(fromIdentityId, toIdentityId); }
    catch (error) { if (error instanceof BondError) throw error; throw error; }
    const state = this._effectiveState(row);
    if (state === "none" || state === "expired") {
      fail(403, "no_bond", state === "expired"
        ? "The bond proposal expired. Propose again with bond.propose { to }. Co-membership is not a bond."
        : "No active bond with this agent. Propose one with bond.propose { to }. Co-membership is not a bond.");
    }
    if (state === "proposed") {
      fail(403, "bond_pending", "A bond is proposed but not accepted yet. The other agent must bond.accept before peer.dm works.");
    }
    if (state === "revoked") {
      fail(403, "bond_revoked", "This bond was revoked. Propose again with bond.propose to reconnect.");
    }
    const accepted = parseScopes(row.accepted_scopes);
    if (!accepted.includes("peer.dm")) {
      fail(403, "scope_denied", "The active bond does not include peer.dm. Accepted scopes are a subset of the proposal; send only works when peer.dm was accepted.");
    }
    return row;
  }

  // Called inside RoomStore.command's write transaction. Does not open its own.
  // Returns { kind: "event", eventType, data, seal? } or { kind: "idempotent", bond }
  // or { kind: "read", bonds }.
  prepare(roomId, memberId, command) {
    if (command.type === "bond.list") return { kind: "read", bonds: this.listForMember(roomId, memberId) };
    if (command.type === "bond.propose") return this._propose(roomId, memberId, command.data ?? {});
    if (command.type === "bond.accept") return this._accept(roomId, memberId, command.data ?? {});
    if (command.type === "bond.decline") return this._decline(roomId, memberId, command.data ?? {});
    if (command.type === "bond.revoke") return this._revoke(roomId, memberId, command.data ?? {});
    if (command.type === "dm.posted") return this._postDm(roomId, memberId, command.data ?? {});
    fail(422, "invalid_command", "Unknown bond command");
  }

  sealDm(pending, eventId) {
    if (!pending) return;
    this.db.prepare(
      `INSERT INTO peer_dm_messages
       (message_id, thread_id, room_id, event_id, from_identity_id, to_identity_id, body, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(pending.messageId, pending.threadId, pending.roomId, eventId, pending.fromIdentityId, pending.toIdentityId, pending.body, pending.createdAt);
  }

  _note(note) {
    if (note == null) return "";
    if (typeof note !== "string") fail(422, "invalid_bond", "note must be text");
    const clean = note.trim();
    if (clean.length > MAX_BOND_NOTE_CHARS) fail(422, "invalid_bond", `note must be ${MAX_BOND_NOTE_CHARS} characters or fewer`);
    return clean;
  }

  _propose(roomId, memberId, data) {
    const identityId = this._requireIdentity(roomId, memberId);
    const peerId = this._resolvePeer(roomId, data.to);
    if (peerId === identityId) fail(422, "bond_self", "You cannot bond with yourself");
    const scopes = normalizeProposedScopes(data.scopes);
    const note = this._note(data.note);
    const [agentA, agentB] = canonicalPair(identityId, peerId);
    const existing = this.db.prepare("SELECT * FROM agent_bonds WHERE agent_a=? AND agent_b=?").get(agentA, agentB);
    const now = this.store.now();
    if (existing && this._effectiveState(existing, now) === "proposed") {
      return { kind: "idempotent", bond: this._public(existing, now) };
    }
    if (existing && existing.state === "active") {
      fail(409, "bond_active", "This pair already has an active bond. Revoke it before proposing a new one.");
    }
    const pending = this.db.prepare(
      "SELECT count(*) AS n FROM agent_bonds WHERE proposed_by=? AND state='proposed' AND NOT (agent_a=? AND agent_b=?)"
    ).get(identityId, agentA, agentB).n;
    if (pending >= MAX_PENDING_PROPOSALS) {
      fail(429, "bond_rate_limited", "Too many pending bond proposals. Wait for a reply or revoke one.");
    }
    const bondId = `bond-${randomUUID()}`;
    const scopeJson = JSON.stringify(scopes);
    if (existing) {
      this.db.prepare(
        `UPDATE agent_bonds
         SET id=?, state='proposed', proposed_by=?, proposed_scopes=?, accepted_scopes='[]',
             note=?, reason='', proposed_at=?, accepted_at=NULL, revoked_at=NULL, revoked_by=NULL, room_hint=?
         WHERE agent_a=? AND agent_b=?`
      ).run(bondId, identityId, scopeJson, note, now, roomId, agentA, agentB);
    } else {
      this.db.prepare(
        `INSERT INTO agent_bonds
         (id, agent_a, agent_b, state, proposed_by, proposed_scopes, accepted_scopes, note, reason, proposed_at, accepted_at, revoked_at, revoked_by, room_hint)
         VALUES (?,?,?,'proposed',?,?, '[]',?,'',?,NULL,NULL,NULL,?)`
      ).run(bondId, agentA, agentB, identityId, scopeJson, note, now, roomId);
    }
    return {
      kind: "event",
      eventType: "bond.proposed",
      data: {
        bondId, agentAId: agentA, agentBId: agentB, proposerIdentityId: identityId, scopes,
        ...(note ? { note } : {})
      }
    };
  }

  _loadForParty(roomId, memberId, bondId, { ownerMayAct = false } = {}) {
    if (typeof bondId !== "string" || !bondId) fail(422, "invalid_bond", "bondId is required");
    const identityId = this.identityForMember(roomId, memberId);
    const row = this._byId(bondId);
    if (!row) fail(404, "bond_not_found", "No such bond");
    const party = identityId && this._isParty(row, identityId);
    const owner = ownerMayAct && this._canRevoke(roomId, memberId, identityId, row);
    if (!party && !owner) fail(404, "bond_not_found", "No such bond");
    return { row, identityId };
  }

  _accept(roomId, memberId, data) {
    const identityId = this._requireIdentity(roomId, memberId);
    const { row } = this._loadForParty(roomId, memberId, data.bondId);
    if (row.proposed_by === identityId) {
      fail(403, "bond_not_recipient", "Only the other agent can accept. You cannot accept your own proposal.");
    }
    const state = this._effectiveState(row);
    if (state === "expired") fail(403, "bond_revoked", "This bond proposal expired. Propose again with bond.propose.");
    if (state === "revoked") fail(403, "bond_revoked", "This bond was revoked. Propose again with bond.propose to reconnect.");
    if (state === "active") fail(409, "bond_active", "This bond is already active.");
    const proposed = parseScopes(row.proposed_scopes);
    // Unknown names are dropped, not added. The stored set is the intersection.
    const requested = data.scopes == null ? proposed : (Array.isArray(data.scopes) ? data.scopes : fail(422, "invalid_scopes", "scopes must be an array"));
    const accepted = attenuateScopes(proposed, requested.filter(scope => BOND_SCOPES.includes(scope)));
    if (accepted.length === 0) {
      fail(422, "scope_denied", "Accept must keep at least one proposed scope. It cannot add scopes that were not proposed.");
    }
    const now = this.store.now();
    this.db.prepare(
      "UPDATE agent_bonds SET state='active', accepted_scopes=?, accepted_at=?, reason='' WHERE id=?"
    ).run(JSON.stringify(accepted), now, row.id);
    return {
      kind: "event",
      eventType: "bond.activated",
      data: {
        bondId: row.id,
        agentAId: row.agent_a,
        agentBId: row.agent_b,
        proposerIdentityId: row.proposed_by,
        acceptedScopes: accepted
      }
    };
  }

  _decline(roomId, memberId, data) {
    const identityId = this._requireIdentity(roomId, memberId);
    const { row } = this._loadForParty(roomId, memberId, data.bondId);
    if (row.proposed_by === identityId) {
      fail(403, "bond_not_recipient", "Only the agent who received the proposal can decline it.");
    }
    const state = this._effectiveState(row);
    if (state === "active") fail(409, "bond_active", "This bond is active. Use bond.revoke to end it.");
    if (state !== "proposed") fail(403, "bond_revoked", "This bond is no longer proposed.");
    return this._markRevoked(row, identityId, "declined");
  }

  _revoke(roomId, memberId, data) {
    const identityId = this.identityForMember(roomId, memberId);
    const { row } = this._loadForParty(roomId, memberId, data.bondId, { ownerMayAct: true });
    if (!this._canRevoke(roomId, memberId, identityId, row)) fail(404, "bond_not_found", "No such bond");
    const state = this._effectiveState(row);
    if (state === "revoked" || state === "expired") {
      fail(403, "bond_revoked", "This bond was already revoked.");
    }
    const actor = identityId || memberId;
    return this._markRevoked(row, actor, "revoked");
  }

  _markRevoked(row, revokedById, reason) {
    const now = this.store.now();
    this.db.prepare(
      "UPDATE agent_bonds SET state='revoked', reason=?, revoked_at=?, revoked_by=? WHERE id=?"
    ).run(reason, now, revokedById, row.id);
    return {
      kind: "event",
      eventType: "bond.revoked",
      data: {
        bondId: row.id,
        agentAId: row.agent_a,
        agentBId: row.agent_b,
        revokedById,
        reason
      }
    };
  }

  _postDm(roomId, memberId, data) {
    const identityId = this._requireIdentity(roomId, memberId);
    const peerId = this._resolvePeer(roomId, data.to);
    if (peerId === identityId) fail(422, "bond_self", "You cannot DM yourself");
    if (typeof data.body !== "string" || !data.body.trim()) fail(422, "invalid_dm", "data.body is required");
    if (data.body.length > 4096) fail(422, "invalid_dm", "data.body must be 4096 characters or fewer");
    if (typeof data.messageId !== "string" || !data.messageId.trim()) fail(422, "invalid_dm", "messageId is required");
    const bond = this.requirePeerDm(identityId, peerId);
    const [agentA, agentB] = canonicalPair(identityId, peerId);
    const threadId = peerThreadId(identityId, peerId);
    const now = this.store.now();
    const taken = this.db.prepare("SELECT from_identity_id, body, thread_id FROM peer_dm_messages WHERE message_id=?").get(data.messageId);
    if (taken) {
      if (taken.from_identity_id === identityId && taken.body === data.body && taken.thread_id === threadId) {
        fail(409, "idempotency_conflict", "messageId was already used. Retry the same command id to replay it.");
      }
      fail(409, "idempotency_conflict", "messageId was already used for a different peer DM");
    }
    this.db.prepare(
      `INSERT INTO peer_dm_threads (thread_id, agent_a, agent_b, bond_id, created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(agent_a, agent_b) DO UPDATE SET bond_id=excluded.bond_id`
    ).run(threadId, agentA, agentB, bond.id, now);
    return {
      kind: "event",
      eventType: "dm.posted",
      data: {
        messageId: data.messageId,
        threadId,
        bondId: bond.id,
        body: data.body,
        fromIdentityId: identityId,
        toIdentityId: peerId
      },
      dm: { messageId: data.messageId, threadId, roomId, fromIdentityId: identityId, toIdentityId: peerId, body: data.body, createdAt: now }
    };
  }
}
