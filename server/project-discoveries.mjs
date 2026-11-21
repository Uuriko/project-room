import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/audit-receipts.mjs';
import { validId } from '../src/events.js';
import { scrubString } from './feedback-scrub.mjs';
import { validateWebhookUrl } from './outbound-webhooks.mjs';
import { ServiceError } from './service-error.mjs';

const projectCapacity = 100;
const contributorCapacity = 5;
const fields = ['requestId', 'expectedTermsVersion', 'expectedRevision', 'sourceUrl', 'criterion', 'observation', 'nextAction'];
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const invalid = message => fail(422, 'invalid_project_discovery', message);

// Slash cannot occur in an offer ID, so public task journals cannot collide.
const journalKey = offerId => 'project-discovery/' + offerId;

function enabledOffer(store, offerId, origin) {
  const offer = store.projectOffers.read(offerId);
  const nativeUrl = new URL('/api/project-offers/' + encodeURIComponent(offerId) + '/discoveries', origin).href;
  if (offer.kind !== 'project' || offer.reward.kind !== 'unpaid' || (offer.submissionUrl && offer.submissionUrl !== nativeUrl))
    fail(404, 'discovery_unavailable', 'This project has no native discovery destination');
  const links = store.db.prepare('SELECT private_links FROM project_offers WHERE offer_id=?').get(offerId);
  if (!JSON.parse(links.private_links).reviewerMemberIds?.length)
    fail(404, 'discovery_unavailable', 'This project has no designated reviewers');
  return offer;
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
    const offer = enabledOffer(store, offerId, origin);
    validate(input, offer);
    const key = journalKey(offerId);
    const actor = identity.identityId;
    const intent = canonicalJson({ action: 'file_project_discovery', ...input });
    const prior = store.db.prepare('SELECT input_json,outcome_json FROM public_work_requests WHERE offer_id=? AND actor_id=? AND request_id=?')
      .get(key, actor, input.requestId);
    if (prior) {
      if (prior.input_json !== intent) fail(409, 'request_id_reused', 'Request ID already used with different input');
      return JSON.parse(prior.outcome_json);
    }
    const counts = store.db.prepare('SELECT COUNT(*) AS total, COUNT(CASE WHEN actor_id=? THEN 1 END) AS mine FROM public_work_requests WHERE offer_id=?').get(actor, key);
    if (counts.total >= projectCapacity || counts.mine >= contributorCapacity)
      fail(429, 'discovery_capacity', 'This project has reached its discovery filing limit');
    const receiptId = 'finding-' + createHash('sha256').update(canonicalJson([key, actor, intent])).digest('hex');
    const { sourceUrl, criterion, observation, nextAction } = input;
    const receipt = { status: 'recorded', receiptId, offerId, termsVersion: offer.version, revision: offer.revision,
      finding: { sourceUrl, criterion, observation, nextAction }, recordedAt: new Date(store.now()).toISOString() };
    store.db.prepare('INSERT INTO public_work_requests (offer_id,actor_id,request_id,input_json,outcome_json) VALUES (?,?,?,?,?)')
      .run(key, actor, input.requestId, intent, JSON.stringify(receipt));
    return receipt;
  });
}

export function reviewerProjectDiscoveries(store, roomId, offerId, origin, memberId) {
  return store.readTransaction(() => {
    const row = store.db.prepare('SELECT private_links FROM project_offers WHERE room_id=? AND offer_id=?').get(roomId, offerId);
    if (!row || !JSON.parse(row.private_links).reviewerMemberIds.includes(memberId))
      fail(403, 'discovery_review_denied', 'A designated project reviewer is required');
    enabledOffer(store, offerId, origin);
    const rows = store.db.prepare('SELECT outcome_json FROM public_work_requests WHERE offer_id=? ORDER BY rowid DESC LIMIT ?')
      .all(journalKey(offerId), projectCapacity);
    return { offerId, findings: rows.map(row => JSON.parse(row.outcome_json)) };
  });
}
