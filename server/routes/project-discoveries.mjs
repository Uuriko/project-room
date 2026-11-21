import { validId } from '../../src/events.js';
import { isGuestAgentMemberId } from '../guest-agent-links.mjs';
import { fileProjectDiscovery, reviewerProjectDiscoveries } from '../project-discoveries.mjs';
import { authorizeRoomRead } from './room-window.mjs';

async function fileFinding(ctx) {
  const { store, req, params, url } = ctx;
  if (url.search) ctx.reject(422, 'invalid_project_discovery', 'No query parameters accepted');
  ctx.rate('public-work-write:' + ctx.remoteAddress, 60);
  const secret = ctx.bearer(req);
  const identity = store.identities.resolveGlobalIdentitySecret(secret);
  if (!identity) ctx.reject(401, 'unauthenticated', 'Use your saved agent identity credential');
  store.publicWorkClaims.enforceIdentityRateLimit(identity.identityId);
  const data = await ctx.body(req, { limit: 65536 });
  if (!validId(params.offerId)) ctx.reject(404, 'not_found', 'Not found');
  return ctx.json(ctx.res, 200, fileProjectDiscovery(store, params.offerId, ctx.expectedOrigin(), secret, data));
}

function listFindings(ctx) {
  const { auth, roomId } = authorizeRoomRead(ctx);
  if (isGuestAgentMemberId(auth.member.id)) ctx.reject(403, 'owner_only', 'Guests cannot manage project offers');
  const query = ctx.url.searchParams;
  if ([...query.keys()].some(key => !['auth', 'limit', 'after', 'at'].includes(key) || query.getAll(key).length !== 1)
      || (query.has('auth') && !['room', 'account'].includes(query.get('auth'))))
    ctx.reject(422, 'invalid_project_discovery', 'Unsupported review query');
  const { offerId } = ctx.params;
  if (!validId(offerId)) ctx.reject(404, 'not_found', 'Not found');
  const page = reviewerProjectDiscoveries(ctx.store, roomId, offerId, ctx.expectedOrigin(), auth.member.id,
    { limit: query.get('limit'), after: query.get('after'), at: query.get('at') });
  return ctx.json(ctx.res, 200, page, ctx.req.method === 'HEAD');
}

const params = names => ({ type: 'object', required: names,
  properties: Object.fromEntries(names.map(name => [name, { type: 'string' }])) });

export const PROJECT_DISCOVERY_ROUTES = [
  { id: 'project-discovery-file', method: 'POST', path: '/api/project-offers/{offerId}/discoveries',
    auth: 'bearer', capability: null, scope: 'public', handler: fileFinding, bodyLimit: 65536,
    parity: 'exempt:outside contributors use the published REST filing action',
    publication: 'open:identity-authenticated filing returns only the contributor’s own finding',
    schema: { params: params(['offerId']), response: { type: 'object' } }, events: [] },
  ...['GET', 'HEAD'].map(method => ({
    id: 'project-discovery-review-' + method.toLowerCase(), method,
    path: '/api/rooms/{roomId}/project-offers/{offerId}/discoveries', auth: 'room', capability: null,
    scope: 'room', handler: listFindings, parity: 'exempt:designated reviewers retrieve private filings through the Room REST API',
    schema: { params: params(['roomId', 'offerId']), response: { type: 'object' } }, events: [],
  })),
];
