import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/audit-receipts.mjs';
import { isGuestAgentMemberId } from './guest-agent-links.mjs';
import { validId } from '../src/events.js';
import { scrubString } from './feedback-scrub.mjs';
import { validateWebhookUrl } from './outbound-webhooks.mjs';
import { ServiceError } from './service-error.mjs';

const projectCapacity = 100;
const contributorCapacity = 5;
const filingWindowMs = 24 * 60 * 60 * 1000;
const discoveryScope = "offer_id=? AND offer_id GLOB 'project-discovery/*'";
const recordedAtColumn = "json_extract(outcome_json,'$.recordedAt')";
const receiptIdColumn = "json_extract(outcome_json,'$.receiptId')";
const fields = ['requestId', 'expectedTermsVersion', 'expectedRevision', 'sourceUrl', 'criterion', 'observation', 'nextAction'];
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const invalid = message => fail(422, 'invalid_project_discovery', message);

// Slash cannot occur in an offer ID, so public task journals cannot collide.
const journalKey = (roomId, offerId) => 'project-discovery/' + roomId + '/' + offerId;

function enabledOffer(store, offerId, origin) {
  const offer = store.projectOffers.read(offerId);
  const nativeUrl = new URL('/api/project-offers/' + encodeURIComponent(offerId) + '/discoveries', origin).href;
  if (offer.kind !== 'project' || offer.reward.kind !== 'unpaid' || (offer.submissionUrl && offer.submissionUrl !== nativeUrl))
    fail(404, 'discovery_unavailable', 'This project has no native discovery destination');
  const links = store.db.prepare('SELECT room_id,private_links FROM project_offers WHERE offer_id=?').get(offerId);
  if (!JSON.parse(links.private_links).reviewerMemberIds?.length)
    fail(404, 'discovery_unavailable', 'This project has no designated reviewers');
  return { offer, roomId: links.room_id, reviewers: JSON.parse(links.private_links).reviewerMemberIds };
}

function validate(input, offer) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
      || !fields.every(field => Object.hasOwn(input, field))) invalid('Supply the exact discovery fields');
  if (!validId(input.requestId) || scrubString(input.requestId) !== input.requestId) invalid('Invalid request ID');
  if (!Number.isSafeInteger(input.expectedTermsVersion) || !Number.isSafeInteger(input.expectedRevision))
    invalid('Supply the published terms version and revision');
  if (offer.version !== input.expectedTermsVersion || offer.revision !== input.expectedRevision)
    fail(409, 'stale_project_offer', 'Read the current published offer before filing');
  if (!offer.acceptanceCriteria.includes(input.criterion)) invalid('Choose a published acceptance criterion');
  for (const [field, max] of [['sourceUrl', 2000], ['observation', 2000], ['nextAction', 1000], ['criterion', 1000]]) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim() || value.length > max || scrubString(value) !== value
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid('Invalid discovery text');
  }
  // Syntactic public-host checks only. Never retrieve the contributor's URL.
  try { validateWebhookUrl(input.sourceUrl); } catch { invalid('Supply a public HTTPS source URL'); }
}

export function fileProjectDiscovery(store, offerId, origin, secret, input) {
  return store.transaction(() => {
    const identity = store.identities.resolveGlobalIdentitySecret(secret);
    if (!identity) fail(401, 'unauthenticated', 'Use your saved agent identity credential');
    const { offer, roomId, reviewers } = enabledOffer(store, offerId, origin);
    validate(input, offer);
    const key = journalKey(roomId, offerId);
    const actor = identity.identityId;
    const intent = canonicalJson({ action: 'file_project_discovery', ...input });
    const prior = store.db.prepare('SELECT input_json,outcome_json FROM public_work_requests WHERE offer_id=? AND actor_id=? AND request_id=?')
      .get(key, actor, input.requestId);
    if (prior) {
      if (prior.input_json !== intent) fail(409, 'request_id_reused', 'Request ID already used with different input');
      return JSON.parse(prior.outcome_json);
    }
    const now = store.now();
    const cutoff = new Date(now - filingWindowMs).toISOString();
    const counts = store.db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN actor_id=? THEN 1 END) AS mine
      FROM public_work_requests WHERE ${discoveryScope} AND ${recordedAtColumn}>?`).get(actor, key, cutoff);
    if (counts.total >= projectCapacity || counts.mine >= contributorCapacity)
      fail(429, 'discovery_capacity', 'Discovery filing limit reached for the rolling 24-hour window');
    const receiptId = 'finding-' + createHash('sha256').update(canonicalJson([key, actor, intent])).digest('hex');
    const { sourceUrl, criterion, observation, nextAction } = input;
    const receipt = { status: 'recorded', receiptId, offerId, termsVersion: offer.version, revision: offer.revision,
      finding: { sourceUrl, criterion, observation, nextAction }, recordedAt: new Date(now).toISOString() };
    store.db.prepare('INSERT INTO public_work_requests (offer_id,actor_id,request_id,input_json,outcome_json) VALUES (?,?,?,?,?)')
      .run(key, actor, input.requestId, intent, JSON.stringify(receipt));
    for (const memberId of reviewers) {
      if (memberId === actor || isGuestAgentMemberId(memberId)) continue;
      if (store.enqueueNativeMcpEvent?.({ kind: 'discovery', roomId, memberId, eventId: receiptId,
        nextRead: { tool: 'room_read_project_discoveries', arguments: { roomId, offerId, at: reviewCursor(receipt) } } })) break;
    }
    return receipt;
  });
}

function reviewCursor(receipt) {
  return Buffer.from(receipt.recordedAt + '/' + receipt.receiptId).toString('base64url');
}

function cursorBoundary(store, key, cursor) {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(cursor)) invalid('Invalid discovery cursor');
  const decoded = Buffer.from(cursor, 'base64url');
  const [at, id, ...extra] = decoded.toString().split('/');
  if (decoded.toString('base64url') !== cursor || extra.length || !at || !/^finding-[0-9a-f]{64}$/.test(id)
      || !store.db.prepare(`SELECT 1 FROM public_work_requests WHERE ${discoveryScope}
        AND ${recordedAtColumn}=? AND ${receiptIdColumn}=?`).get(key, at, id)) invalid('Invalid discovery cursor');
  return [at, id];
}

// SQLite can reuse rowids after a purge or renumber them during maintenance.
// Reject an anchor that no longer names the same filing before skipping past it.
function discoveryCheckpoint(store, roomId, after) {
  if (!after) return 0;
  const [position, receiptId] = after.split('/');
  const row = store.db.prepare(`SELECT 1 FROM public_work_requests WHERE rowid=?
    AND offer_id GLOB ? AND ${receiptIdColumn}=?`).get(Number(position), 'project-discovery/' + roomId + '/*', receiptId);
  if (!row) fail(422, 'invalid_discovery_checkpoint', 'Omit the stale checkpoint to restart finding review');
  return Number(position);
}

// One index seek per designated offer. Select the oldest pending offer watermark,
// so considering one offer never skips an older filing on another offer.
export function nextReviewerProject(store, roomId, memberId, origin, after) {
  if (isGuestAgentMemberId(memberId)) return null;
  const consideredThrough = discoveryCheckpoint(store, roomId, after);
  const row = store.db.prepare(`SELECT o.offer_id AS offerId, (
      SELECT MAX(j.rowid) FROM public_work_requests j
      WHERE j.offer_id='project-discovery/' || o.room_id || '/' || o.offer_id AND j.offer_id GLOB 'project-discovery/*'
    ) AS latest
    FROM project_offers o JOIN rooms r ON r.id=o.room_id
    WHERE o.room_id=? AND r.archived_at IS NULL AND o.status='published'
      AND NOT EXISTS (SELECT 1 FROM public_unpublish u WHERE u.kind='room' AND u.target=o.room_id)
      AND json_extract(o.terms,'$.kind')='project' AND json_extract(o.terms,'$.reward.kind')='unpaid'
      AND (json_extract(o.terms,'$.submissionUrl') IS NULL OR json_extract(o.terms,'$.submissionUrl')
        = ? || '/api/project-offers/' || replace(o.offer_id, ':', '%3A') || '/discoveries')
      AND EXISTS (SELECT 1 FROM json_each(o.private_links,'$.reviewerMemberIds') WHERE value=?)
      AND latest>? ORDER BY latest LIMIT 1`).get(roomId, origin, memberId, consideredThrough);
  if (!row) return null;
  const { receiptId } = store.db.prepare(`SELECT ${receiptIdColumn} AS receiptId FROM public_work_requests WHERE rowid=?`).get(row.latest);
  return { offerId: row.offerId, after: row.latest + '/' + receiptId };
}

export function requireDiscoveryReviewer(store, roomId, offerId, origin, memberId) {
  const row = store.db.prepare('SELECT private_links FROM project_offers WHERE room_id=? AND offer_id=?').get(roomId, offerId);
  if (isGuestAgentMemberId(memberId) || !row || !JSON.parse(row.private_links).reviewerMemberIds.includes(memberId))
    fail(403, 'discovery_review_denied', 'A designated project reviewer is required');
  enabledOffer(store, offerId, origin);
}

export function reviewerProjectDiscoveries(store, roomId, offerId, origin, memberId, { limit, after, at = null }) {
  return store.readTransaction(() => {
    requireDiscoveryReviewer(store, roomId, offerId, origin, memberId);
    if (limit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) invalid('Choose a limit from 1 through 50');
    const size = limit === null ? 20 : Number(limit);
    const key = journalKey(roomId, offerId);
    if (at !== null) {
      if (after !== null) invalid('Choose either one finding or a page');
      const boundary = cursorBoundary(store, key, at);
      const row = store.db.prepare(`SELECT outcome_json FROM public_work_requests WHERE ${discoveryScope}
        AND ${recordedAtColumn}=? AND ${receiptIdColumn}=?`).get(key, ...boundary);
      return { offerId, findings: [JSON.parse(row.outcome_json)], nextCursor: null };
    }
    const boundary = after === null ? [] : cursorBoundary(store, key, after);
    // SQLite uses the explicit time range to seek the expression index; the tuple resolves ties.
    const where = boundary.length ? ` AND ${recordedAtColumn}<=? AND (${recordedAtColumn},${receiptIdColumn}) < (?,?)` : '';
    const parameters = boundary.length ? [boundary[0], ...boundary] : [];
    const rows = store.db.prepare(`SELECT outcome_json FROM public_work_requests WHERE ${discoveryScope}${where}
      ORDER BY ${recordedAtColumn} DESC, ${receiptIdColumn} DESC LIMIT ?`).all(key, ...parameters, size + 1);
    const findings = rows.slice(0, size).map(row => JSON.parse(row.outcome_json));
    return { offerId, findings, nextCursor: rows.length > size ? reviewCursor(findings.at(-1)) : null };
  });
}
