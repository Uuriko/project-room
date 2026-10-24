// Fresh membership observation, independent of room history and work queues.
export function readAgentConnection(ctx) {
  const roomId = ctx.params.roomId;
  const selected = ctx.roomCredentials(ctx.req, ctx.url);
  const fence = selected.mode === 'account' ? ctx.accountBinding(ctx.req) : ctx.expectedBinding(ctx.req);
  const value = ctx.store.readTransaction(() => {
    const auth = ctx.roomAuth(selected, roomId, fence);
    if (selected.bearer && auth.credentialScope !== 'room') ctx.reject(403, 'access_denied', 'Bearer account sessions are not accepted');
    if (!selected.bearer && auth.kind !== 'session') ctx.reject(401, 'unauthenticated', 'Browser session required');
    ctx.rate(`read:${auth.credentialHash}`, 600);
    if (auth.kind === 'api-key' && !(auth.apiKeyScopes ?? []).some(scope => scope === 'rooms:read' || scope === 'rooms:*'))
      ctx.reject(403, 'insufficient_scope', 'API key lacks the rooms:read scope');
    if ([...ctx.url.searchParams.keys()].some(key => key !== 'auth') || ctx.url.searchParams.getAll('auth').length > 1)
      ctx.reject(422, 'invalid_request', 'This read does not accept filters');
    const member = auth.member;
    return { contractVersion: 1, roomId, viewerId: member.id,
      member: { id: member.id, kind: member.kind, active: member.active, revision: member.revision,
        permissions: [...member.permissions], delegatedAdmin: member.delegatedAdmin === true },
      ownerId: ctx.store.room(roomId).state.room.ownerId, executionGranted: false };
  });
  return ctx.json(ctx.res, 200, value);
}
export const AGENT_CONNECTION_ROUTES = Object.freeze([
  Object.freeze({ id: 'agent-connection', method: 'GET', path: '/api/rooms/{roomId}/agent-connection',
    parity: 'exempt:HTTP current membership observation; no execution authority',
    auth: 'room', capability: null, scope: 'room', handler: readAgentConnection,
    schema: { params: { type: 'object', required: ['roomId'], properties: { roomId: { type: 'string' } } },
      response: { type: 'object' } }, events: [] })
]);
