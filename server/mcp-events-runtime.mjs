import { createHash } from 'node:crypto';
import { createMcpEventSubscriptions } from './mcp-event-subscriptions.mjs';
import { authorizeMcpOAuthDescriptor } from './mcp-oauth.mjs';
import { isWorkersRuntime } from './ip-blocklist.mjs';

// A native event subscription is an explicit opt-in independent of desktop
// host registration. Workers deliberately has no automatic egress fallback.
export function createMcpEventsRuntime({ store, accountProvider, inviteProvider, resource, transport, dnsResolvers }) {
  if (!resource || isWorkersRuntime()) return null;
  const authorize = descriptor => !store.wakeQueue?.pauseStatus(descriptor.roomId, descriptor.memberId)
    && !store.agentHeartbeats?.pausedRoomsOf(descriptor.identityId).some(row => row.roomId === descriptor.roomId)
    && authorizeMcpOAuthDescriptor({ store, accountProvider, inviteProvider, resource, descriptor });
  const manager = createMcpEventSubscriptions({ store, authorize, transport, dnsResolvers });
  const emit = ({ roomId, memberId, identityId, messageId, eventId = messageId }) => {
    if (!memberId && identityId) memberId = store.db.prepare('SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId, identityId)?.member_id;
    if (!memberId) return 0;
    return manager.enqueueRequested({ roomId, memberId,
      ...(/^[A-Za-z0-9_-]{1,128}$/.test(messageId ?? '') ? { messageId } : {}),
      eventId: 'mcp_' + createHash('sha256').update(JSON.stringify([roomId, memberId, eventId])).digest('hex') });
  };
  const handler = async (message, { descriptor }) => {
    const result = value => ({ jsonrpc: '2.0', id: message.id, result: value });
    if (!authorize(descriptor)) return { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Event grant denied' } };
    const args = message.params ?? {};
    try {
      if (message.method === 'events/list') {
        if (args.cursor !== undefined && args.cursor !== null) throw Object.assign(new Error('No event catalog pagination'), { code: -32602 });
        return result({ events: [{ name: 'room.requested', delivery: ['webhook'],
          payloadSchema: { type: 'object', properties: { roomId: { type: 'string' }, memberId: { type: 'string' }, messageId: { type: 'string' }, requestId: { type: 'string' } }, required: ['roomId', 'memberId'], additionalProperties: false }, description: 'A permitted mention, direct request, or work transition needs this agent. Fetch current Room state before acting; this notification is only a pointer.',
          inputSchema: { type: 'object', properties: { roomId: { type: 'string', const: descriptor.roomId }, memberId: { type: 'string', const: descriptor.memberId } }, required: ['roomId', 'memberId'], additionalProperties: false } }], ttlMs: 0, cacheScope: 'private' });
      }
      if (message.method === 'events/subscribe') return result(await manager.subscribe({ ...args, principal: descriptor }));
      if (message.method === 'events/unsubscribe') {
        if (typeof args.id !== 'string' || args.id.length > 128) throw Object.assign(new Error('Invalid subscription id'), { code: -32602 });
        return result(manager.unsubscribe({ principal: descriptor, id: args.id }));
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
    } catch (error) { return { jsonrpc: '2.0', id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32603,
      message: Number.isInteger(error.code) ? error.message : 'Event operation failed', ...(error.data ? { data: error.data } : {}) } }; }
  };
  let running = false, stopped = false;
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try { return await manager.drain({ limit: 10 }); } finally { running = false; }
  };
  const timer = setInterval(() => { drain().catch(() => {}); }, 1000);
  timer.unref?.();
  return { handler, emit, drain, stop() { stopped = true; clearInterval(timer); } };
}
