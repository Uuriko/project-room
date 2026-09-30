import { renderPublicContributionTerms } from '../src/contribution-brief.js';
// Public offers are owner-authored opt-in terms, not room projection exports.
// Money remains unconfigured; the independent valueless-credit ledger is unchanged.
import { canonicalJson } from '../src/audit-receipts.mjs';
import { validId, roomPolicy } from '../src/events.js';

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const check = (ok, message) => { if (!ok) fail(422, 'invalid_project_offer', message); };
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
const list = (value, required = false) => {
  check(Array.isArray(value) && value.length <= 20 && (!required || value.length > 0), 'Invalid criteria list');
  return value.map(item => text(item, 1000));
};
export const projectOffersSchema = `
CREATE TABLE IF NOT EXISTS project_offers (
  offer_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  version INTEGER NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
  terms TEXT NOT NULL, private_links TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_offer_requests (
  room_id TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  input TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(room_id, request_id)
);`;

function termsOf(value) {
  shape(value, ['kind', 'title', 'summary', 'acceptanceCriteria', 'reward', 'approvalPolicy'], ['exclusions', 'repositoryUrl', 'submissionUrl', 'deadline']);
  check(['task', 'project'].includes(value.kind), 'kind must be task or project');
  shape(value.reward, ['kind'], ['unit', 'amountMinor', 'terms', 'decimals', 'basis']);
  const reward = { kind: value.reward.kind };
  check(['unpaid', 'work_trade', 'cash'].includes(reward.kind), 'Invalid reward kind');
  if (reward.kind === 'unpaid') {
    check(value.reward.unit == null && value.reward.amountMinor == null, 'Unpaid offers have no amount');
  } else {
    check(reward.kind === 'cash' ? ['USD', 'USDC'].includes(value.reward.unit) : value.reward.unit === 'credit', 'Invalid reward unit');
    check(typeof value.reward.amountMinor === 'string' && /^[1-9][0-9]{0,17}$/.test(value.reward.amountMinor), 'Positive integer amountMinor required');
    Object.assign(reward, { unit: value.reward.unit, amountMinor: value.reward.amountMinor,
      decimals: reward.kind === 'work_trade' ? 3 : value.reward.unit === 'USD' ? 2 : 6 });
  }
  if (value.reward.decimals != null) check(value.reward.decimals === reward.decimals, 'Invalid reward decimals');
  if (value.reward.basis != null) { check(['fixed', 'pool'].includes(value.reward.basis), 'Invalid reward basis'); reward.basis = value.reward.basis; }
  if (value.reward.terms != null) reward.terms = text(value.reward.terms, 2000);
  shape(value.approvalPolicy, ['mode']);
  check(['human', 'agent', 'human_with_agent_review'].includes(value.approvalPolicy.mode), 'Invalid approval mode');
  const terms = { kind: value.kind, title: text(value.title, 200), summary: text(value.summary, 4000),
    acceptanceCriteria: list(value.acceptanceCriteria, true), exclusions: list(value.exclusions ?? []),
    reward, approvalPolicy: { mode: value.approvalPolicy.mode } };
  for (const field of ['repositoryUrl', 'submissionUrl']) {
    if (value[field] == null) continue;
    const raw = text(value[field], 2000); let url;
    try { url = new URL(raw); } catch { fail(422, 'invalid_project_offer', 'Invalid public URL'); }
    check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Public URL must be HTTPS without credentials/query/fragment');
    terms[field] = url.href;
  }
  if (value.deadline != null) {
    check(typeof value.deadline === 'string' && Number.isFinite(Date.parse(value.deadline)), 'Invalid deadline');
    terms.deadline = new Date(value.deadline).toISOString();
  }
  return terms;
}

function validateReview(state, terms, links) {
  const reviewers = links.reviewerMemberIds;
  check(Array.isArray(reviewers) && reviewers.length > 0 && reviewers.length <= 10, 'Reviewers required');
  const members = reviewers.map(id => state.members[identifier(id)]);
  check(members.every(member => member && member.active !== false), 'Reviewers must be active room members');
  const mode = terms.approvalPolicy.mode;
  const human = members.some(member => member.kind === 'human' && member.permissions?.includes('decide'));
  const agent = members.some(member => member.kind === 'agent' && member.permissions?.includes('verify'));
  check(mode === 'human' ? human : mode === 'agent' ? agent : human && agent, 'Reviewers lack the required review/decision standing');
  const work = links.workItemId ? state.workItems[identifier(links.workItemId)] : null;
  if (links.workItemId) check(Boolean(work) && !['completed', 'superseded'].includes(work.state), 'Linked work must be available and non-terminal');
  if (roomPolicy(state).requireOwnerDecision || work?.ownerDecisionRequired) {
    check(mode !== 'agent', 'Room or work policy requires a human decision');
    const decider = work?.humanDecisionMakerId ?? state.room.ownerId;
    check(reviewers.includes(decider) && state.members[decider]?.kind === 'human' && state.members[decider]?.permissions?.includes('decide'), 'Include the designated human decision-maker');
  }
  if (work?.verifierMemberId) {
    const verifier = state.members[work.verifierMemberId];
    check(reviewers.includes(work.verifierMemberId) && verifier?.permissions?.includes('verify'), 'Include the designated work verifier');
    check(!work.independentVerificationRequired || work.verifierMemberId !== work.accountableMemberId, 'Independent reviewer required');
    check(verifier.kind !== 'agent' || mode !== 'human', 'Linked work requires agent review');
  }
}

export class ProjectOffers {
  constructor(store) { this.store = store; this.db = store.db; }
  requireOwner(roomId, actorId) {
    const { state } = this.store.room(roomId);
    if (state.room.ownerId !== actorId) fail(403, 'owner_only', 'Only the room owner may manage project offers');
    if (state.room.archivedAt) fail(409, 'room_archived', 'Archived rooms cannot publish offers');
    return state;
  }
  record(row, privateView = false) {
    const terms = termsOf(JSON.parse(row.terms));
    const result = { schema: 'project-room-offer/1', id: row.offer_id, version: row.version,
      revision: row.revision, status: row.status, ...terms,
      fundingStatus: terms.reward.kind === 'unpaid' ? 'not_applicable' : terms.reward.kind === 'work_trade' ? 'ledger_only' : 'not_configured',
      paymentStatus: terms.reward.kind === 'unpaid' ? 'not_applicable' : terms.reward.kind === 'work_trade' ? 'ledger_only' : 'not_configured',
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
    if (privateView) Object.assign(result, { roomId: row.room_id, ...JSON.parse(row.private_links) });
    return result;
  }
  request(roomId, actorId, input, action) {
    identifier(input.requestId);
    return this.store.transaction(() => {
      this.requireOwner(roomId, actorId);
      const fingerprint = canonicalJson(input);
      const previous = this.db.prepare('SELECT * FROM project_offer_requests WHERE room_id=? AND request_id=?').get(roomId, input.requestId);
      if (previous) {
        if (previous.actor_id !== actorId || previous.input !== fingerprint) fail(409, 'request_id_reused', 'Request ID already used with different input');
        return JSON.parse(previous.outcome);
      }
      const outcome = action();
      this.db.prepare('INSERT INTO project_offer_requests VALUES (?,?,?,?,?)').run(roomId, input.requestId, actorId, fingerprint, JSON.stringify(outcome));
      return outcome;
    });
  }
  create(roomId, actorId, input) {
    const state = this.requireOwner(roomId, actorId);
    shape(input, ['requestId', 'offerId', 'terms', 'reviewerMemberIds'], ['workItemId']);
    identifier(input.offerId);
    const terms = termsOf(input.terms);
    validateReview(state, terms, input);
    const reviewers = [...new Set(input.reviewerMemberIds)];
    return this.request(roomId, actorId, { action: 'create', ...input }, () => {
      validateReview(this.requireOwner(roomId, actorId), terms, input);
      if (this.db.prepare('SELECT offer_id FROM project_offers WHERE offer_id=?').get(input.offerId)) fail(409, 'offer_exists', 'Offer ID already exists');
      if (this.db.prepare('SELECT count(*) AS n FROM project_offers WHERE room_id=?').get(roomId).n >= 100) fail(409, 'offer_limit', 'This room has reached its offer limit');
      const now = this.store.now();
      this.db.prepare('INSERT INTO project_offers VALUES (?,?,?,?,?,?,?,?,?,?)').run(input.offerId, roomId, actorId, 1, 1, 'draft', JSON.stringify(terms), JSON.stringify({ reviewerMemberIds: reviewers, workItemId: input.workItemId ?? null }), now, now);
      return this.record(this.db.prepare('SELECT * FROM project_offers WHERE offer_id=?').get(input.offerId), true);
    });
  }
  transition(roomId, actorId, offerId, action, input) {
    this.requireOwner(roomId, actorId);
    identifier(offerId); shape(input, ['requestId', 'expectedRevision']);
    check(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, 'Expected revision required');
    check(['publish', 'withdraw'].includes(action), 'Invalid action');
    return this.request(roomId, actorId, { action, offerId, ...input }, () => {
      const row = this.db.prepare('SELECT * FROM project_offers WHERE offer_id=? AND room_id=?').get(offerId, roomId);
      if (!row) fail(404, 'offer_not_found', 'Offer not found');
      if (row.revision !== input.expectedRevision) fail(409, 'stale_offer', 'Offer changed; read it again');
      if (row.status !== (action === 'publish' ? 'draft' : 'published')) fail(409, 'invalid_offer_status', 'Offer cannot make this transition');
      if (action === 'publish') {
        const terms = JSON.parse(row.terms);
        check(Boolean(terms.repositoryUrl || terms.submissionUrl), 'Publishing requires a public repository or submission URL');
        const links = JSON.parse(row.private_links);
        validateReview(this.requireOwner(roomId, actorId), JSON.parse(row.terms), links);
      }
      this.db.prepare('UPDATE project_offers SET status=?, revision=revision+1, updated_at=? WHERE offer_id=?').run(action === 'publish' ? 'published' : 'withdrawn', this.store.now(), offerId);
      return this.record(this.db.prepare('SELECT * FROM project_offers WHERE offer_id=?').get(offerId), true);
    });
  }
  ownerList(roomId, actorId) {
    this.requireOwner(roomId, actorId);
    return { offers: this.db.prepare('SELECT * FROM project_offers WHERE room_id=? ORDER BY created_at DESC, offer_id LIMIT 100').all(roomId).map(row => this.record(row, true)) };
  }
  publicRows() {
    return this.db.prepare("SELECT o.* FROM project_offers o JOIN rooms r ON r.id=o.room_id WHERE o.status='published' AND r.archived_at IS NULL ORDER BY o.created_at DESC,o.offer_id LIMIT 100").all();
  }
  list({ limit = 20, after = null } = {}) {
    const size = Number(limit);
    check(Number.isInteger(size) && size > 0 && size <= 100, 'limit must be 1 through 100');
    if (after != null) identifier(after);
    const rows = this.db.prepare("SELECT o.* FROM project_offers o JOIN rooms r ON r.id=o.room_id WHERE o.status='published' AND r.archived_at IS NULL AND o.offer_id>? ORDER BY o.offer_id LIMIT ?").all(after ?? '', size + 1);
    return { offers: rows.slice(0, size).map(row => this.record(row)), nextCursor: rows.length > size ? rows[size - 1].offer_id : null };
  }
  read(id) {
    identifier(id);
    const row = this.db.prepare("SELECT o.* FROM project_offers o JOIN rooms r ON r.id=o.room_id WHERE o.offer_id=? AND o.status='published' AND r.archived_at IS NULL").get(id);
    if (!row) fail(404, 'offer_not_found', 'Offer not found');
    return this.record(row);
  }
  brief(id) {
    return renderPublicContributionTerms(this.read(id), { skill: true }) + '\n';
  }
}
