// One authorized read boundary for agent pickup. This is an observation, never
// a reservation or permission to execute. Reuse the existing request semantics.
export function readAgentWork(ctx) {
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
    const { requests, evaluatedThrough } = ctx.store.replyRequests.list(selected.token, roomId,
      { direction: 'incoming', status: 'open', expectedSessionBinding: fence });
    const knownRuns = requests.length ? ctx.store.requestRuns.list(selected.token, roomId, fence).runs : {};
    const runs = Object.fromEntries(requests.filter(request => Object.hasOwn(knownRuns, request.id)).map(request => [request.id, knownRuns[request.id]]));
    const member = auth.member;
    return { contractVersion: 1, roomId, viewerId: member.id,
      member: { id: member.id, kind: member.kind, active: member.active, revision: member.revision,
        permissions: [...member.permissions], delegatedAdmin: member.delegatedAdmin === true },
      ownerId: ctx.store.room(roomId).state.room.ownerId, evaluatedThrough,
      observedAt: ctx.store.now(), requests, runs, executionGranted: false };
  });
  // Never silently omit work to fit a response. A future paginated protocol
  // must bind continuation to this principal and its authorization state.
  if (Buffer.byteLength(JSON.stringify(value)) > 262144)
    ctx.reject(422, 'reply_list_too_large', 'Use the separate request reads for this queue');
  return ctx.json(ctx.res, 200, value);
}

export const AGENT_WORK_ROUTES = Object.freeze([
  Object.freeze({ id: 'agent-work', method: 'GET', path: '/api/rooms/{roomId}/agent-work',
    parity: 'exempt:HTTP agent pickup observation; execution remains on existing request commands',
    auth: 'room', capability: null, scope: 'room', handler: readAgentWork,
    schema: { params: { type: 'object', required: ['roomId'], properties: { roomId: { type: 'string' } } },
      response: { type: 'object' } }, events: [] })
]);
