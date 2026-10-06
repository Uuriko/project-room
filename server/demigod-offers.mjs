// Demigod buyer-offer profiles — the buyer-facing offer template layer.
//
// A Demigod buyer offer is a structured, presentable deal document for a
// Demigod job. It ANCHORS to the room's generic offer surface
// (server/project-offers.mjs): every profile references a project_offers
// offer (`offerRef`), and adds the Demigod-specific fields the fulfillment
// dry run found missing: trial scope, pinned vetting rubric, price type,
// timeline shape, and revision terms.
//
// RECORD-ONLY: no money moves in this build, ever. Amounts are positive
// integer strings (milli-units); every record carries recordOnly: true and
// paymentStatus: 'not_configured'. The rendered document says so in plain
// language, because a buyer must never read this as a live invoice.
//
// Composition: an accepted profile mints a demigod contract
// (server/demigod-contracts.mjs); the contract's revision terms bound the
// buyer sign-off loop (server/buyer-signoff.mjs), which overlays a trial
// task's `submitted` state without editing the trial-task state machine.
import { canonicalJson } from '../src/audit-receipts.mjs';
import { validId } from '../src/events.js';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const check = (ok, message) => { if (!ok) fail(422, 'invalid_demigod_offer', message); };
const shape = (value, required, optional = []) => {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'Unexpected or missing fields');
};
const credentialPattern = /\bpri_[A-Za-z0-9_-]+|\bBearer\s+\S+|#join\/|[?&](?:token|auth|secret|key)=/i;
const text = (value, max) => {
  check(typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !credentialPattern.test(value), 'Invalid public text or credential-shaped content');
  return value.trim();
};
const identifier = value => { check(validId(value), 'Invalid identifier'); return value; };
const milliString = (value, what) => {
  check(typeof value === 'string' && /^[1-9][0-9]{0,17}$/.test(value), `${what} must be a positive integer string`);
  return value;
};
const intString = (value, what) => {
  check(typeof value === 'string' && /^[1-9][0-9]{0,6}$/.test(value), `${what} must be a positive integer string`);
  return value;
};

export const demigodOffersSchema = `
CREATE TABLE IF NOT EXISTS demigod_offer_profiles (
  profile_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, offer_ref TEXT NOT NULL,
  demigod_req_id TEXT NOT NULL, buyer_id TEXT NOT NULL,
  version INTEGER NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
  profile TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS demigod_offer_requests (
  room_id TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  input TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(room_id, request_id)
);
CREATE INDEX IF NOT EXISTS demigod_offer_profiles_room_created
  ON demigod_offer_profiles(room_id, created_at DESC, profile_id);`;

export const DEMIGOD_OFFER_STATUSES = ['draft', 'presented', 'accepted', 'declined', 'expired', 'withdrawn'];
const TERMINAL = new Set(['accepted', 'declined', 'expired', 'withdrawn']);
export const DEFAULT_FEE_POLICY_REF = 'demigod:placement-10pct/v1';
export const PRICE_TYPES = ['fixed', 'hourly', 'trial_management_fee'];
const DELIVERABLE_SHAPES = ['code-pr', 'markdown-report', 'design-mock', 'data-set', 'automation-run', 'other'];

function rubricOf(value) {
  check(Array.isArray(value) && value.length >= 1 && value.length <= 50, 'vettingRubric needs 1-50 criteria');
  return value.map(criterion => {
    shape(criterion, ['criterionId', 'description', 'maxScore']);
    return {
      criterionId: identifier(criterion.criterionId),
      description: text(criterion.description, 1000),
      maxScore: text(criterion.maxScore, 16),
    };
  });
}

function profileOf(value) {
  shape(value, ['trialScope', 'vettingRubric', 'priceType', 'timeline', 'revisionTerms'],
    ['priceMilli', 'feePolicyRef']);
  shape(value.trialScope, ['hours', 'deliverableShape']);
  const trialScope = {
    hours: intString(value.trialScope.hours, 'trialScope.hours'),
    deliverableShape: text(value.trialScope.deliverableShape, 64),
  };
  check(DELIVERABLE_SHAPES.includes(trialScope.deliverableShape) || /^[a-z0-9-]{1,64}$/.test(trialScope.deliverableShape), 'Invalid deliverableShape');
  check(PRICE_TYPES.includes(value.priceType), 'priceType must be fixed, hourly, or trial_management_fee');
  const priceType = value.priceType;
  let priceMilli = null;
  if (value.priceMilli != null || priceType !== 'trial_management_fee') {
    priceMilli = milliString(value.priceMilli, 'priceMilli');
  }
  shape(value.timeline, ['estimateDays', 'deadline']);
  const timeline = { estimateDays: intString(value.timeline.estimateDays, 'timeline.estimateDays') };
  check(typeof value.timeline.deadline === 'string' && Number.isFinite(Date.parse(value.timeline.deadline)), 'Invalid timeline.deadline');
  timeline.deadline = new Date(value.timeline.deadline).toISOString();
  shape(value.revisionTerms, ['maxRounds', 'turnaroundDays']);
  check(Number.isSafeInteger(value.revisionTerms.maxRounds) && value.revisionTerms.maxRounds >= 1 && value.revisionTerms.maxRounds <= 10, 'revisionTerms.maxRounds must be 1-10');
  const revisionTerms = {
    maxRounds: value.revisionTerms.maxRounds,
    turnaroundDays: intString(value.revisionTerms.turnaroundDays, 'revisionTerms.turnaroundDays'),
  };
  return {
    trialScope, vettingRubric: rubricOf(value.vettingRubric), priceType, priceMilli, timeline, revisionTerms,
    feePolicyRef: value.feePolicyRef == null ? DEFAULT_FEE_POLICY_REF : text(value.feePolicyRef, 200),
  };
}

export class DemigodOffers {
  constructor(store) { this.store = store; this.db = store.db; }

  requireOwner(roomId, actorId) {
    const { state } = this.store.room(roomId);
    if (state.room.ownerId !== actorId) fail(403, 'owner_only', 'Only the room owner may manage Demigod offers');
    if (state.room.archivedAt) fail(409, 'room_archived', 'Archived rooms cannot manage Demigod offers');
    return state;
  }

  memberOf(state, memberId, what) {
    const member = state.members[memberId];
    check(member && member.active !== false, `${what} must be an active room member`);
    return member;
  }

  record(row) {
    const profile = JSON.parse(row.profile);
    return {
      schema: 'demigod-buyer-offer/1',
      id: row.profile_id,
      roomId: row.room_id,
      offerRef: row.offer_ref,
      demigodReqId: row.demigod_req_id,
      buyerId: row.buyer_id,
      version: row.version,
      revision: row.revision,
      status: row.status,
      ...profile,
      recordOnly: true,
      paymentStatus: 'not_configured',
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  request(roomId, actorId, input, action) {
    identifier(input.requestId);
    return this.store.transaction(() => {
      const fingerprint = canonicalJson(input);
      const previous = this.db.prepare('SELECT * FROM demigod_offer_requests WHERE room_id=? AND request_id=?').get(roomId, input.requestId);
      if (previous) {
        if (previous.actor_id !== actorId || previous.input !== fingerprint) fail(409, 'request_id_reused', 'Request ID already used with different input');
        return JSON.parse(previous.outcome);
      }
      const outcome = action();
      this.db.prepare('INSERT INTO demigod_offer_requests VALUES (?,?,?,?,?)').run(roomId, input.requestId, actorId, fingerprint, JSON.stringify(outcome));
      return outcome;
    });
  }

  create(roomId, actorId, input) {
    const state = this.requireOwner(roomId, actorId);
    shape(input, ['requestId', 'profileId', 'offerRef', 'demigodReqId', 'buyerId', 'trialScope', 'vettingRubric', 'priceType', 'timeline', 'revisionTerms'],
      ['priceMilli', 'feePolicyRef']);
    identifier(input.profileId);
    const offerRef = identifier(input.offerRef);
    const demigodReqId = text(input.demigodReqId, 200);
    this.memberOf(state, input.buyerId, 'buyerId');
    const profile = profileOf({
      trialScope: input.trialScope, vettingRubric: input.vettingRubric,
      priceType: input.priceType, priceMilli: input.priceMilli,
      timeline: input.timeline, revisionTerms: input.revisionTerms,
      feePolicyRef: input.feePolicyRef,
    });
    return this.request(roomId, actorId, { action: 'create', ...input }, () => {
      const offer = this.db.prepare('SELECT offer_id FROM project_offers WHERE offer_id=? AND room_id=?').get(offerRef, roomId);
      if (!offer) fail(422, 'demigod_offer_ref_missing', 'offerRef must reference an existing project offer in this room');
      if (this.db.prepare('SELECT profile_id FROM demigod_offer_profiles WHERE profile_id=?').get(input.profileId)) fail(409, 'demigod_offer_exists', 'Offer profile ID already exists');
      const now = this.store.now();
      this.db.prepare('INSERT INTO demigod_offer_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(input.profileId, roomId, offerRef, demigodReqId, input.buyerId, 1, 1, 'draft', JSON.stringify(profile), now, now);
      return this.record(this.db.prepare('SELECT * FROM demigod_offer_profiles WHERE profile_id=?').get(input.profileId));
    });
  }

  transition(roomId, actorId, profileId, action, input) {
    identifier(profileId); shape(input, ['requestId', 'expectedRevision']);
    check(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, 'Expected revision required');
    const moves = { present: 'presented', accept: 'accepted', decline: 'declined', expire: 'expired', withdraw: 'withdrawn' };
    check(Object.hasOwn(moves, action), 'Invalid action');
    // Offer management (present/withdraw/expire) is the owner's act;
    // accept/decline belong to the named buyer (the owner may also act).
    const row0 = this.db.prepare('SELECT * FROM demigod_offer_profiles WHERE profile_id=? AND room_id=?').get(profileId, roomId);
    if (!row0) fail(404, 'demigod_offer_not_found', 'Offer profile not found');
    if (['present', 'withdraw', 'expire'].includes(action)) {
      this.requireOwner(roomId, actorId);
    } else {
      const { state } = this.store.room(roomId);
      const isOwner = state.room.ownerId === actorId;
      if (!isOwner && actorId !== row0.buyer_id) fail(403, 'accept_not_buyer', 'Only the named buyer may accept or decline this offer');
      if (state.room.archivedAt) fail(409, 'room_archived', 'Archived rooms cannot manage Demigod offers');
    }
    return this.request(roomId, actorId, { action, profileId, ...input }, () => {
      const row = this.db.prepare('SELECT * FROM demigod_offer_profiles WHERE profile_id=? AND room_id=?').get(profileId, roomId);
      if (!row) fail(404, 'demigod_offer_not_found', 'Offer profile not found');
      if (row.revision !== input.expectedRevision) fail(409, 'stale_demigod_offer', 'Offer changed; read it again');
      if (TERMINAL.has(row.status)) fail(409, 'invalid_demigod_offer_status', 'Offer is terminal and cannot move');
      const next = moves[action];
      const allowed = { present: ['draft'], accept: ['presented'], decline: ['presented'], expire: ['presented'], withdraw: ['draft', 'presented'] };
      if (!allowed[action].includes(row.status)) fail(409, 'invalid_demigod_offer_status', `Cannot ${action} an offer in ${row.status}`);
      this.db.prepare('UPDATE demigod_offer_profiles SET status=?, revision=revision+1, updated_at=? WHERE profile_id=?')
        .run(next, this.store.now(), profileId);
      return this.record(this.db.prepare('SELECT * FROM demigod_offer_profiles WHERE profile_id=?').get(profileId));
    });
  }

  present(roomId, actorId, profileId, input) { return this.transition(roomId, actorId, profileId, 'present', input); }
  accept(roomId, actorId, profileId, input) { return this.transition(roomId, actorId, profileId, 'accept', input); }
  decline(roomId, actorId, profileId, input) { return this.transition(roomId, actorId, profileId, 'decline', input); }
  expire(roomId, actorId, profileId, input) { return this.transition(roomId, actorId, profileId, 'expire', input); }
  withdraw(roomId, actorId, profileId, input) { return this.transition(roomId, actorId, profileId, 'withdraw', input); }

  get(roomId, profileId) {
    identifier(profileId);
    const row = this.db.prepare('SELECT * FROM demigod_offer_profiles WHERE profile_id=? AND room_id=?').get(profileId, roomId);
    if (!row) fail(404, 'demigod_offer_not_found', 'Offer profile not found');
    return this.record(row);
  }

  list(roomId, { limit = 20, after = null } = {}) {
    const size = Number(limit);
    check(Number.isInteger(size) && size > 0 && size <= 100, 'limit must be 1 through 100');
    if (after != null) identifier(after);
    const rows = this.db.prepare('SELECT * FROM demigod_offer_profiles WHERE room_id=? AND profile_id>? ORDER BY profile_id LIMIT ?')
      .all(roomId, after ?? '', size + 1);
    return { profiles: rows.slice(0, size).map(row => this.record(row)), nextCursor: rows.length > size ? rows[size - 1].profile_id : null };
  }

  // Buyer-presentable document: the deal in plain language, with the honest
  // record-only line. This is what a buyer reads before accepting.
  document(roomId, profileId) {
    const offer = this.get(roomId, profileId);
    // Base offer terms come straight from the project_offers row (not the
    // public published-only read): the buyer must see the deal while it is
    // still a draft under negotiation.
    let base = null;
    const baseRow = this.db.prepare('SELECT terms FROM project_offers WHERE offer_id=? AND room_id=?').get(offer.offerRef, roomId);
    if (baseRow) {
      try { base = JSON.parse(baseRow.terms); } catch { base = null; }
    }
    const title = base?.title ?? offer.demigodReqId;
    const priceLine = offer.priceType === 'trial_management_fee' && offer.priceMilli == null
      ? 'Trial management fee (record-only; priced by Demigod policy)'
      : `${offer.priceType} — ${offer.priceMilli} milli-units (record-only)`;
    const lines = [
      `# Offer: ${title}`,
      '',
      `Status: ${offer.status} · Demigod request: ${offer.demigodReqId} · Fee policy: ${offer.feePolicyRef}`,
      '',
      '## Scope',
      '',
      `- Trial effort: ${offer.trialScope.hours} hours`,
      `- Deliverable: ${offer.trialScope.deliverableShape}`,
      ...(base ? [`- Summary: ${base.summary}`, ...base.acceptanceCriteria.map(c => `  - Accepts when: ${c}`)] : []),
      '',
      '## Vetting rubric (pinned)',
      '',
      ...offer.vettingRubric.map(c => `- ${c.criterionId}: ${c.description} (max ${c.maxScore})`),
      '',
      '## Price and timeline',
      '',
      `- Price: ${priceLine}`,
      `- Timeline: about ${offer.timeline.estimateDays} days, deadline ${offer.timeline.deadline}`,
      '',
      '## Revisions',
      '',
      `- Up to ${offer.revisionTerms.maxRounds} revision rounds, ${offer.revisionTerms.turnaroundDays} days each.`,
      '- Each round: delivery → your review → change request or sign-off.',
      '',
      '> Record-only: no payment is collected or moved by this document.',
      '> Amounts are bookkeeping rehearsal until Demigod enables a real payout path.',
      '',
    ];
    return lines.join('\n');
  }
}
