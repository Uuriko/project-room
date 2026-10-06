import {railActor,railFail} from "./trial-task-store.mjs";
// Demigod contracts — the record-only agreement representation.
//
// A contract mints from an ACCEPTED Demigod offer profile and freezes the
// exact accepted terms as a byte-exact snapshot (canonical JSON), so later
// offer edits cannot rewrite the deal. Parties, acceptance flow, completion
// linkage, and termination are all recorded; nothing here moves money.
//
// Acceptance flow: pending → active (worker acknowledges) → completed
// (buyer completes against a trial-task receipt) | terminated (buyer/owner).
// Completion records the trial task id and receipt ref as linkage only — the
// vetting receipt itself is issued by the trial-task lane (#1623); this
// contract cites it, never fabricates it.
import { canonicalJson } from '../src/audit-receipts.mjs';
import { validId } from '../src/events.js';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const check = (ok, code, message) => { if (!ok) fail(422, code, message); };
const shape = (value, required, optional = []) => {
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid_demigod_contract', 'Expected an object');
  check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'invalid_demigod_contract', 'Unexpected or missing fields');
};
const credentialPattern = /\bpri_[A-Za-z0-9_-]+|\bBearer\s+\S+|#join\/|[?&](?:token|auth|secret|key)=/i;
const text = (value, max, what = 'text') => {
  check(typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !credentialPattern.test(value), 'invalid_demigod_contract', `Invalid ${what} or credential-shaped content`);
  return value.trim();
};
const identifier = value => { check(validId(value), 'invalid_demigod_contract', 'Invalid identifier'); return value; };

export const demigodContractsSchema = `
CREATE TABLE IF NOT EXISTS demigod_contracts (
  contract_id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
  offer_profile_id TEXT NOT NULL, offer_revision INTEGER NOT NULL,
  buyer_id TEXT NOT NULL, worker_id TEXT,
  status TEXT NOT NULL, terms_json TEXT NOT NULL, acceptance_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS demigod_contract_requests (
  room_id TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  input TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(room_id, request_id)
);
CREATE INDEX IF NOT EXISTS demigod_contracts_room_created
  ON demigod_contracts(room_id, created_at DESC, contract_id);`;

export const DEMIGOD_CONTRACT_STATUSES = ['pending', 'active', 'completed', 'terminated'];
const TERMINAL = new Set(['completed', 'terminated']);

export class DemigodContracts {
  constructor(store) { this.store = store; this.db = store.db; }

  roomState(roomId, actorId) {
    const { state } = this.store.room(roomId);
    if (state.room.archivedAt) fail(409, 'room_archived', 'Archived rooms cannot manage Demigod contracts');
    return state;
  }

  record(row) {
    return {
      schema: 'demigod-contract/1',
      id: row.contract_id,
      roomId: row.room_id,
      offerProfileId: row.offer_profile_id,
      offerRevision: row.offer_revision,
      parties: { buyerId: row.buyer_id, workerId: row.worker_id },
      status: row.status,
      termsSnapshot: JSON.parse(row.terms_json),
      acceptance: JSON.parse(row.acceptance_json),
      completion: row.status === 'completed' ? JSON.parse(row.acceptance_json).completion ?? null : null,
      termination: row.status === 'terminated' ? JSON.parse(row.acceptance_json).termination ?? null : null,
      recordOnly: true,
      paymentStatus: 'not_configured',
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  request(roomId, actorId, input, action) {
    railActor(this.store, roomId, actorId, {writing:true});
    identifier(input.requestId);
    return this.store.transaction(() => {
      const fingerprint = canonicalJson(input);
      const previous = this.db.prepare('SELECT * FROM demigod_contract_requests WHERE room_id=? AND request_id=?').get(roomId, input.requestId);
      if (previous) {
        if (previous.actor_id !== actorId || previous.input !== fingerprint) fail(409, 'request_id_reused', 'Request ID already used with different input');
        return JSON.parse(previous.outcome);
      }
      const outcome = action();
      this.db.prepare('INSERT INTO demigod_contract_requests VALUES (?,?,?,?,?)').run(roomId, input.requestId, actorId, fingerprint, JSON.stringify(outcome));
      return outcome;
    });
  }

  getRow(contractId, roomId) {
    identifier(contractId);
    const row = this.db.prepare('SELECT * FROM demigod_contracts WHERE contract_id=? AND room_id=?').get(contractId, roomId);
    if (!row) fail(404, 'demigod_contract_not_found', 'Contract not found');
    return row;
  }

  // Mint a contract from an accepted offer. The caller must name the exact
  // accepted revision — accepting terms the room changed after the buyer
  // read them is a 409.
  create(roomId, actorId, input) {
    const state = this.roomState(roomId, actorId);
    shape(input, ['requestId', 'contractId', 'offerProfileId', 'expectedRevision'], ['workerId']);
    identifier(input.contractId);
    const offerProfileId = identifier(input.offerProfileId);
    check(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, 'invalid_demigod_contract', 'Expected revision required');
    const workerId = input.workerId == null ? null : identifier(input.workerId);
    if (workerId && (!state.members[workerId] || state.members[workerId].active === false || workerId === state.room.ownerId || workerId === state.members[actorId]?.id)) railFail(422,"invalid_contract_worker","Worker must be a distinct active member");
    return this.request(roomId, actorId, { action: 'create', ...input }, () => {
      const offer = this.db.prepare('SELECT * FROM demigod_offer_profiles WHERE profile_id=? AND room_id=?').get(offerProfileId, roomId);
      if (!offer) fail(404, 'demigod_offer_not_found', 'Offer profile not found');
      if(workerId===offer.buyer_id)railFail(422,'invalid_contract_worker','Worker and buyer must differ');
      if (offer.status !== 'accepted') fail(409, 'invalid_demigod_offer_status', 'Contracts mint only from accepted offers');
      if (offer.revision !== input.expectedRevision) fail(409, 'stale_demigod_offer', 'Offer changed; read it again');
      const isOwner = state.room.ownerId === actorId;
      if (!isOwner && actorId !== offer.buyer_id) fail(403, 'contract_not_party', 'Only the buyer or the room owner may mint this contract');
      if (this.db.prepare('SELECT contract_id FROM demigod_contracts WHERE contract_id=?').get(input.contractId)) fail(409, 'demigod_contract_exists', 'Contract ID already exists');
      // Byte-exact snapshot of the accepted terms: canonical JSON of the
      // full offer record, so the deal is frozen at acceptance.
      const termsSnapshot = JSON.parse(canonicalJson(this.store.demigodOffers.record(offer)));
      const now = this.store.now();
      const acceptance = { acceptedBy: actorId, acceptedAt: new Date(now).toISOString(), method: 'room-command' };
      this.db.prepare('INSERT INTO demigod_contracts VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(input.contractId, roomId, offerProfileId, offer.revision, offer.buyer_id, workerId,
          'pending', JSON.stringify(termsSnapshot), JSON.stringify(acceptance), now, now);
      return this.record(this.getRow(input.contractId, roomId));
    });
  }

  transition(roomId, actorId, contractId, action, input) {
    const state = this.roomState(roomId, actorId);
    return this.request(roomId, actorId, { action, contractId, ...input }, () => {
      const row = this.getRow(contractId, roomId);
      if (TERMINAL.has(row.status)) fail(409, 'invalid_demigod_contract_status', 'Contract is terminal and cannot move');
      const isOwner = state.room.ownerId === actorId;
      const isBuyer = actorId === row.buyer_id;
      const isWorker = row.worker_id != null && actorId === row.worker_id;
      const acceptance = JSON.parse(row.acceptance_json);
      const now = this.store.now();
      let next = row.status;
      if (action === 'acknowledge') {
        check(row.status === 'pending', 'invalid_demigod_contract_status', 'Only pending contracts can be acknowledged');
        check(isWorker || (isOwner && row.worker_id == null), 'invalid_demigod_contract', 'Only the named worker may acknowledge');
        acceptance.workerAcknowledgedAt = new Date(now).toISOString();
        next = 'active';
      } else if (action === 'complete') {
        check(row.status === 'active', 'invalid_demigod_contract_status', 'Only active contracts can complete');
        check(isBuyer || isOwner, 'invalid_demigod_contract', 'Only the buyer or owner may complete');
        shape(input, ['requestId', 'trialTaskId', 'receiptRef']);
        const trial = this.store.trialTasks.verified(roomId, input.trialTaskId, input.receiptRef);
        const terms = JSON.parse(row.terms_json);
        if (trial.candidateId !== row.worker_id || trial.buyerId !== row.buyer_id || trial.demigodReqId !== terms.demigodReqId || trial.trialScope.hoursMax !== terms.trialScope.hours || trial.trialScope.deliverableShape !== terms.trialScope.deliverableShape) railFail(422,'contract_trial_mismatch','Verified trial must bind contract parties and terms');
        const points=terms.vettingRubric.map(c=>{ if(!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(c.maxScore)) railFail(422,'invalid_contract_rubric','Numeric pinned score weights required'); return BigInt(c.maxScore.split('.')[0])*100n+BigInt((c.maxScore.split('.')[1]??'').padEnd(2,'0')); });
        const total=points.reduce((a,b)=>a+b,0n);
        const pinned=terms.vettingRubric.map((c,i)=>({criterion:c.criterionId,weightBps: total>0n?(points[i]*10000n/total).toString():'0'}));
        if(canonicalJson(pinned)!==canonicalJson(trial.vettingRubric))railFail(422,'contract_rubric_mismatch','Trial must bind pinned rubric weights');
        const loop = this.db.prepare('SELECT 1 FROM buyer_signoff_loops WHERE room_id=? AND trial_task_id=? AND contract_id=? AND status=?').get(roomId,trial.id,contractId,'accepted');
        if(!loop) railFail(422,'contract_signoff_required','Accepted contract-linked delivery required');
        acceptance.completion = {
          trialTaskId: identifier(input.trialTaskId),
          receiptRef: text(input.receiptRef, 2000, 'receiptRef'),
          completedBy: actorId,
          completedAt: new Date(now).toISOString(),
          recordOnly: true,
        };
        next = 'completed';
      } else if (action === 'terminate') {
        check(isBuyer || isOwner, 'invalid_demigod_contract', 'Only the buyer or owner may terminate');
        shape(input, ['requestId', 'reason']);
        acceptance.termination = {
          reason: text(input.reason, 1000, 'reason'),
          terminatedBy: actorId,
          terminatedAt: new Date(now).toISOString(),
        };
        next = 'terminated';
      } else {
        fail(422, 'invalid_demigod_contract', 'Invalid action');
      }
      this.db.prepare('UPDATE demigod_contracts SET status=?, acceptance_json=?, updated_at=? WHERE contract_id=?')
        .run(next, JSON.stringify(acceptance), now, contractId);
      return this.record(this.getRow(contractId, roomId));
    });
  }

  acknowledge(roomId, actorId, contractId, input) { shape(input, ['requestId']); return this.transition(roomId, actorId, contractId, 'acknowledge', input); }
  complete(roomId, actorId, contractId, input) { return this.transition(roomId, actorId, contractId, 'complete', input); }
  terminate(roomId, actorId, contractId, input) { return this.transition(roomId, actorId, contractId, 'terminate', input); }

  get(roomId, contractId) { return this.record(this.getRow(contractId, roomId)); }

  list(roomId, { limit = 20, after = null } = {}) {
    const size = Number(limit);
    check(Number.isInteger(size) && size > 0 && size <= 100, 'invalid_demigod_contract', 'limit must be 1 through 100');
    if (after != null) identifier(after);
    const rows = this.db.prepare('SELECT * FROM demigod_contracts WHERE room_id=? AND contract_id>? ORDER BY contract_id LIMIT ?')
      .all(roomId, after ?? '', size + 1);
    return { contracts: rows.slice(0, size).map(row => this.record(row)), nextCursor: rows.length > size ? rows[size - 1].contract_id : null };
  }
}
