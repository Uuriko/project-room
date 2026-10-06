// Buyer sign-off loops — the buyer-visible revision loop.
//
// This is the piece the fulfillment dry run flagged structurally missing:
// "submission → buyer review → revision request → re-delivery → sign-off".
//
// A loop anchors to a trial task id (opaque string; the trial-task state
// machine in #1624 is the source of truth for the work itself). While the
// trial task sits in `submitted`, this loop records the buyer's side:
// each delivery round (deliverable ref + sha256 + summary), each buyer
// review (accept | request_changes, with a note), and the final sign-off.
// The buyer accepts here BEFORE the evaluator posts the trial verdict —
// that ordering is the documented handoff; this module does not edit the
// trial-task state machine.
//
// States: open → submitted → under_review → changes_requested → submitted
// (round++) → … → accepted | cancelled. The revision terms (maxRounds)
// come from the linked Demigod contract's terms snapshot, or from explicit
// input, default 3.
//
// RECORD-ONLY: sign-off records review decisions. It never releases money.
import { canonicalJson } from '../src/audit-receipts.mjs';
import { validId } from '../src/events.js';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const check = (ok, code, message) => { if (!ok) fail(422, code, message); };
const shape = (value, required, optional = []) => {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid_signoff', 'Expected an object');
  check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'invalid_signoff', 'Unexpected or missing fields');
};
const credentialPattern = /\bpri_[A-Za-z0-9_-]+|\bBearer\s+\S+|#join\/|[?&](?:token|auth|secret|key)=/i;
const text = (value, max, what = 'text') => {
  check(typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !credentialPattern.test(value), 'invalid_signoff', `Invalid ${what} or credential-shaped content`);
  return value.trim();
};
const identifier = value => { check(validId(value), 'invalid_signoff', 'Invalid identifier'); return value; };
const sha256 = value => {
  check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid_signoff', 'sha256 must be 64 lowercase hex');
  return value;
};

export const buyerSignoffSchema = `
CREATE TABLE IF NOT EXISTS buyer_signoff_loops (
  loop_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
  trial_task_id TEXT NOT NULL, contract_id TEXT, buyer_id TEXT NOT NULL,
  status TEXT NOT NULL, round INTEGER NOT NULL, max_rounds INTEGER NOT NULL,
  rounds_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS buyer_signoff_requests (
  room_id TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  input TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(room_id, request_id)
);
CREATE INDEX IF NOT EXISTS buyer_signoff_loops_room_trial
  ON buyer_signoff_loops(room_id, trial_task_id);`;

export const SIGNOFF_STATUSES = ['open', 'submitted', 'under_review', 'changes_requested', 'accepted', 'cancelled'];
const TERMINAL = new Set(['accepted', 'cancelled']);
const REVIEWABLE = new Set(['submitted', 'under_review']);

export class BuyerSignoff {
  constructor(store) { this.store = store; this.db = store.db; }

  roomState(roomId) {
    const { state } = this.store.room(roomId);
    if (state.room.archivedAt) fail(409, 'room_archived', 'Archived rooms cannot manage sign-off loops');
    return state;
  }

  isOwner(state, actorId) { return state.room.ownerId === actorId; }

  record(row, buyerView = false) {
    const rounds = JSON.parse(row.rounds_json);
    const current = rounds.length ? rounds[rounds.length - 1] : null;
    const base = {
      schema: 'buyer-signoff-loop/1',
      loopId: row.loop_id,
      trialTaskId: row.trial_task_id,
      contractId: row.contract_id,
      buyerId: row.buyer_id,
      status: row.status,
      round: row.round,
      maxRounds: row.max_rounds,
      rounds,
      currentDeliverable: current ? current.deliverable : null,
      recordOnly: true,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
    if (!buyerView) base.roomId = row.room_id;
    return base;
  }

  // Buyer-visible status: where the job stands, without room internals.
  // This is the status page the dry run found missing (gap #5).
  status(roomId, loopId) {
    const row = this.getRow(loopId, roomId);
    const rec = this.record(row, true);
    return {
      loopId: rec.loopId,
      trialTaskId: rec.trialTaskId,
      state: rec.status,
      round: rec.round,
      maxRounds: rec.maxRounds,
      currentDeliverable: rec.currentDeliverable,
      lastReview: rec.rounds.length ? rec.rounds[rec.rounds.length - 1].review ?? null : null,
      recordOnly: true,
    };
  }

  request(roomId, actorId, input, action) {
    identifier(input.requestId);
    return this.store.transaction(() => {
      const fingerprint = canonicalJson(input);
      const previous = this.db.prepare('SELECT * FROM buyer_signoff_requests WHERE room_id=? AND request_id=?').get(roomId, input.requestId);
      if (previous) {
        if (previous.actor_id !== actorId || previous.input !== fingerprint) fail(409, 'request_id_reused', 'Request ID already used with different input');
        return JSON.parse(previous.outcome);
      }
      const outcome = action();
      this.db.prepare('INSERT INTO buyer_signoff_requests VALUES (?,?,?,?,?)').run(roomId, input.requestId, actorId, fingerprint, JSON.stringify(outcome));
      return outcome;
    });
  }

  getRow(loopId, roomId) {
    identifier(loopId);
    const row = this.db.prepare('SELECT * FROM buyer_signoff_loops WHERE loop_id=? AND room_id=?').get(loopId, roomId);
    if (!row) fail(404, 'signoff_not_found', 'Sign-off loop not found');
    return row;
  }

  maxRoundsFor(state, input, contractId) {
    if (input.maxRounds != null) {
      check(Number.isSafeInteger(input.maxRounds) && input.maxRounds >= 1 && input.maxRounds <= 10, 'invalid_signoff', 'maxRounds must be 1-10');
      return input.maxRounds;
    }
    if (contractId != null) {
      const contract = this.db.prepare('SELECT terms_json FROM demigod_contracts WHERE contract_id=? AND room_id=?').get(contractId, state.room.id);
      const terms = contract ? JSON.parse(contract.terms_json) : null;
      const rounds = terms?.revisionTerms?.maxRounds;
      if (Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 10) return rounds;
    }
    return 3;
  }

  create(roomId, actorId, input) {
    const state = this.roomState(roomId);
    shape(input, ['requestId', 'loopId', 'trialTaskId', 'buyerId'], ['contractId', 'maxRounds']);
    identifier(input.loopId);
    const trialTaskId = identifier(input.trialTaskId);
    const buyerId = identifier(input.buyerId);
    const contractId = input.contractId == null ? null : identifier(input.contractId);
    check(state.members[buyerId] && state.members[buyerId].active !== false, 'invalid_signoff', 'buyerId must be an active room member');
    if (!this.isOwner(state, actorId) && actorId !== buyerId) fail(403, 'signoff_not_party', 'Only the buyer or the room owner may open a sign-off loop');
    return this.request(roomId, actorId, { action: 'create', ...input }, () => {
      if (this.db.prepare('SELECT loop_id FROM buyer_signoff_loops WHERE loop_id=?').get(input.loopId)) fail(409, 'signoff_exists', 'Sign-off loop ID already exists');
      if (contractId != null && !this.db.prepare('SELECT contract_id FROM demigod_contracts WHERE contract_id=? AND room_id=?').get(contractId, roomId)) {
        fail(404, 'demigod_contract_not_found', 'Contract not found');
      }
      const now = this.store.now();
      this.db.prepare('INSERT INTO buyer_signoff_loops VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(input.loopId, roomId, trialTaskId, contractId, buyerId, 'open', 0,
          this.maxRoundsFor(state, input, contractId), '[]', now, now);
      return this.record(this.getRow(input.loopId, roomId));
    });
  }

  submit(roomId, actorId, loopId, input) {
    this.roomState(roomId);
    shape(input, ['requestId', 'deliverableRef', 'sha256', 'summary', 'candidateId']);
    const deliverable = {
      ref: text(input.deliverableRef, 2000, 'deliverableRef'),
      sha256: sha256(input.sha256),
      summary: text(input.summary, 2000, 'summary'),
      candidateId: identifier(input.candidateId),
    };
    return this.request(roomId, actorId, { action: 'submit', loopId, ...input }, () => {
      const row = this.getRow(loopId, roomId);
      if (TERMINAL.has(row.status)) fail(409, 'invalid_signoff_status', 'Loop is terminal');
      check(['open', 'changes_requested'].includes(row.status), 'invalid_signoff_status', `Cannot submit while ${row.status}`);
      const rounds = JSON.parse(row.rounds_json);
      const nextRound = rounds.length + 1;
      if (nextRound > row.max_rounds) fail(422, 'revision_rounds_exhausted', `Revision terms allow ${row.max_rounds} rounds; this would be round ${nextRound}`);
      const now = this.store.now();
      rounds.push({ round: nextRound, submittedAt: new Date(now).toISOString(), submittedBy: actorId, deliverable, review: null });
      this.db.prepare('UPDATE buyer_signoff_loops SET status=?, round=?, rounds_json=?, updated_at=? WHERE loop_id=?')
        .run('submitted', nextRound, JSON.stringify(rounds), now, loopId);
      return this.record(this.getRow(loopId, roomId));
    });
  }

  review(roomId, actorId, loopId, input) {
    const state = this.roomState(roomId);
    shape(input, ['requestId', 'decision'], ['note']);
    check(['begin', 'accept', 'request_changes'].includes(input.decision), 'invalid_signoff', 'decision must be begin, accept, or request_changes');
    const note = input.note == null ? null : text(input.note, 2000, 'note');
    return this.request(roomId, actorId, { action: 'review', loopId, ...input }, () => {
      const row = this.getRow(loopId, roomId);
      if (TERMINAL.has(row.status)) fail(409, 'invalid_signoff_status', 'Loop is terminal');
      // Sign-off is the counterparty's act: only the recorded buyer reviews.
      // (The owner may review only when they ARE the recorded buyer.)
      if (actorId !== row.buyer_id) fail(403, 'signoff_not_buyer', 'Only the recorded buyer may review');
      check(REVIEWABLE.has(row.status), 'invalid_signoff_status', `Cannot review while ${row.status}`);
      const rounds = JSON.parse(row.rounds_json);
      const now = this.store.now();
      const current = rounds[rounds.length - 1];
      current.review = { decision: input.decision, note, by: actorId, at: new Date(now).toISOString() };
      let next = row.status;
      if (input.decision === 'begin') next = 'under_review';
      else if (input.decision === 'accept') next = 'accepted';
      else next = 'changes_requested';
      this.db.prepare('UPDATE buyer_signoff_loops SET status=?, rounds_json=?, updated_at=? WHERE loop_id=?')
        .run(next, JSON.stringify(rounds), now, loopId);
      return this.record(this.getRow(loopId, roomId));
    });
  }

  cancel(roomId, actorId, loopId, input) {
    const state = this.roomState(roomId);
    shape(input, ['requestId', 'reason']);
    return this.request(roomId, actorId, { action: 'cancel', loopId, ...input }, () => {
      const row = this.getRow(loopId, roomId);
      if (TERMINAL.has(row.status)) fail(409, 'invalid_signoff_status', 'Loop is terminal');
      if (actorId !== row.buyer_id && !this.isOwner(state, actorId)) fail(403, 'signoff_not_party', 'Only the buyer or the room owner may cancel');
      const now = this.store.now();
      this.db.prepare('UPDATE buyer_signoff_loops SET status=?, updated_at=? WHERE loop_id=?').run('cancelled', now, loopId);
      return this.record(this.getRow(loopId, roomId));
    });
  }

  get(roomId, loopId) { return this.record(this.getRow(loopId, roomId)); }

  list(roomId, { limit = 20, after = null } = {}) {
    const size = Number(limit);
    check(Number.isInteger(size) && size > 0 && size <= 100, 'invalid_signoff', 'limit must be 1 through 100');
    if (after != null) identifier(after);
    const rows = this.db.prepare('SELECT * FROM buyer_signoff_loops WHERE room_id=? AND loop_id>? ORDER BY loop_id LIMIT ?')
      .all(roomId, after ?? '', size + 1);
    return { loops: rows.slice(0, size).map(row => this.record(row)), nextCursor: rows.length > size ? rows[size - 1].loop_id : null };
  }
}
