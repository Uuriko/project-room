import { createHeartbeatActor, translateWith } from './agent-plugin-routes.mjs';
import { heartbeatWithListener } from './agent-listener-contract.mjs';

// One round trip, no execution/ACK. No database transaction spans an await.
export function createAgentDelivery({ store, actor, bearer, body, json, reject, rate }) {
  return async (req, res, { remoteAddress }) => {
    const started = performance.now();
    const timing = { authMs: 0, leaseMs: 0, pollMs: 0, waitMs: 0 };
    const timed = (key, fn) => { const at = performance.now(); try { return fn(); } finally { timing[key] += performance.now() - at; } };
    rate(`agent-delivery:${remoteAddress}`, 120);
    if (!/^(pri_|rak_)/.test(bearer(req) ?? '')) reject(401, 'unauthenticated', 'Agent identity or scoped API key required');
    timed('authMs', () => { actor(req, 'heartbeats:read'); actor(req, 'heartbeats:report'); });
    const data = await body(req);
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
    if (!data || Array.isArray(data) || Object.keys(data).some(k => !['roomId','memberId','hostId','cadenceSeconds','waitMs','cursor'].includes(k))
      || !validId(data.roomId) || !validId(data.memberId) || !validId(data.hostId)
      || !Number.isFinite(data.cadenceSeconds) || data.cadenceSeconds <= 0
      || !Number.isInteger(data.waitMs) || data.waitMs < 0 || data.waitMs > 55000
      || data.cursor != null && (typeof data.cursor !== 'string' || data.cursor.length > 1024))
      reject(422, 'invalid_body', 'Use a pinned room, member, host, cadence and bounded wait');
    const resolve = () => timed('authMs', () => {
      const auth = actor(req, 'heartbeats:read');
      const report = actor(req, 'heartbeats:report');
      if (auth.identityId !== report.identityId || auth.roomId && auth.roomId !== data.roomId)
        reject(403, 'identity_changed', 'Credential binding does not match the delivery room');
      const room = store.authenticate(bearer(req), data.roomId);
      if (room.member.id !== data.memberId || room.member.kind !== 'agent' || room.member.active !== true
        || room.identityId !== auth.identityId) reject(403, 'identity_changed', 'Configured agent does not match current room membership');
      return { auth, connection: { contractVersion: 1, type: 'agent_connection_check', status: 'credential_accepted',
        roomId: data.roomId, memberId: data.memberId, kind: 'agent', permissions: [...room.member.permissions],
        checkedAt: new Date().toISOString(), expiresAt: null, scope: 'room', externalExecution: false } };
    });
    const register = auth => timed('leaseMs', () => heartbeatWithListener(store, auth, {
      hostId: data.hostId, mode: 'wakeable', cadenceSeconds: data.cadenceSeconds, listenerLease: { roomId: data.roomId }
    }, { door: 'delivery' }));
    const first = store.transaction(() => { const current = resolve(); return { ...current, registration: register(current.auth) }; });
    rate(`agent-delivery-poll:${first.auth.identityId}`, 30);
    const respond = (status, connection, listener, page = { pendingWakes: [] }, waitedMs = 0) => json(res, 200, {
      contractVersion: 1, status, hostId: data.hostId, agentId: first.auth.identityId, connection, listener,
      pendingWakes: page.pendingWakes, more: page.more === true, nextCursor: page.nextCursor ?? null,
      waitedMs, timedOut: waitedMs > 0 && !woken && page.pendingWakes.length === 0, acknowledged: false,
      beforeConnection: first.connection, execution: 'not_observed', timing: { ...timing, totalMs: performance.now() - started }
    });
    let woken = false;
    if (!first.registration.listener.acquired) return respond('listener_contended', first.connection, first.registration.listener);
    const hostId = first.registration.host.hostId;
    let finish, gone = false;
    const pending = new Promise(resolve => { finish = resolve; });
    const onClose = () => { gone = true; finish(); };
    res.once('close', onClose);
    const release = store.agentHeartbeats.addWakeWaiter(first.auth.identityId, hostId, { roomId: data.roomId, onWake: () => { woken = true; finish(); } });
    let timer;
    try {
      const poll = () => timed('pollMs', () => store.agentHeartbeats.notePoll({ agentId: first.auth.identityId, roomId: data.roomId, hostId, cursor: data.cursor ?? null }));
      const initial = poll();
      if (!initial.pendingWakes.length && data.waitMs > 0) {
        const at = performance.now(); timer = setTimeout(finish, data.waitMs);
        await pending; timing.waitMs = performance.now() - at;
      }
      if (gone) return;
      const result = store.transaction(() => {
        const current = resolve();
        if (current.auth.identityId !== first.auth.identityId || current.auth.keyId !== first.auth.keyId
          || (current.auth.roomId ?? null) !== (first.auth.roomId ?? null)) reject(403, 'identity_changed', 'Binding changed while waiting');
        const renewed = register(current.auth);
        const held = renewed.listener.acquired && renewed.listener.fencingToken === first.registration.listener.fencingToken;
        return { ...current, listener: renewed.listener, held, page: held ? poll() : { pendingWakes: [] } };
      });
      return respond(result.held ? (result.page.pendingWakes.length ? 'signals_received' : 'wait_completed') : 'listener_contended',
        result.connection, result.listener, result.page, timing.waitMs);
    } finally { clearTimeout(timer); release(); res.removeListener('close', onClose); }
  };
}

function authenticateDelivery(ctx) {
  const actor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  actor(ctx.req, 'heartbeats:report');
  return actor(ctx.req, 'heartbeats:read');
}

async function receiveAgentDelivery(ctx) {
  const actor = createHeartbeatActor({ store: ctx.store, bearer: ctx.bearer, reject: ctx.reject });
  const receive = createAgentDelivery({ store: ctx.store, actor, bearer: ctx.bearer,
    body: async () => typeof ctx.body === 'function' ? ctx.body(ctx.req) : ctx.body, json: ctx.json, reject: ctx.reject, rate: ctx.rate });
  return translateWith(ctx.reject)(receive)(ctx.req, ctx.res, { remoteAddress: ctx.remoteAddress });
}

export const AGENT_DELIVERY_ROUTES = Object.freeze([
  Object.freeze({ id: 'agent-delivery', method: 'POST', path: '/api/agent-wakes/receive',
    auth: 'bearer', capability: null, scope: 'directory',
    authenticate: authenticateDelivery, handler: receiveAgentDelivery,
    parity: 'exempt:Room Host HTTP delivery transport; MCP actions remain the execution surface',
    schema: { body: { type: 'object' }, response: { type: 'object' } }, events: [] }),
]);
