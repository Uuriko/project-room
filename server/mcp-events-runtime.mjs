import { nativeClaimWakeAllowed } from "./work-claim-events.mjs";
import { mayWake } from './agent-talk-policy.mjs';
import { firstBlockedWakeTarget } from '../src/events.js';
import { nextWorkStep } from '../src/workflow.js';
import { mutedEvent } from './moderation.mjs';
import { requireDiscoveryReviewer } from './project-discoveries.mjs';
import { createMcpEventSubscriptions, discoveryEvent } from './mcp-event-subscriptions.mjs';
import { nativeOutboxEventId } from './mcp-outbox-event-id.mjs';
import { authorizeMcpOAuthDescriptor } from './mcp-oauth.mjs';
import { isWorkersRuntime } from './ip-blocklist.mjs';
import { canonicalNativeMentionPolicyContext } from './native-mention-context.mjs';
import { isCurrentRoom, readCurrentWakePolicyState } from './current-room-repository.mjs';

// Fresh policy for one native event delivery. Exported for direct tests of
// the legacy and normalized room paths.
export function authorizeNativeEvent(store, descriptor, { event, context }) {
  return store.transaction(() => {
    if (context?.kind === 'discovery') {
      if (!descriptor.scopes.includes('work:read') || !descriptor.scopes.includes('rooms:read')
        || store.wakeQueue?.pauseStatus(descriptor.roomId, descriptor.memberId)
        || store.agentHeartbeats?.pausedRoomsOf(descriptor.identityId).some(row => row.roomId === descriptor.roomId)) return false;
      const state = isCurrentRoom(store.db, descriptor.roomId)
        ? readCurrentWakePolicyState(store, descriptor.roomId, [descriptor.memberId])
        : store.room(descriptor.roomId).state;
      const reviewer = state?.members[descriptor.memberId];
      if (reviewer?.kind !== 'agent' || reviewer.active === false || reviewer.notificationPreferences?.work_updates === 'none') return false;
      const { offerId } = event.data.nextRead.arguments;
      try {
        requireDiscoveryReviewer(store, descriptor.roomId, offerId, new URL(descriptor.resource).origin, descriptor.memberId);
        return true;
      } catch (error) {
        if ([403, 404, 422].includes(error.status)) return false;
        throw error;
      }
    }
    if (!context || typeof context.actorId !== 'string' || !['mention', 'squad-mention', 'dm', 'work', 'board'].includes(context.kind)) return false;
    if (store.wakeQueue?.pauseStatus(descriptor.roomId, descriptor.memberId)
      || store.agentHeartbeats?.pausedRoomsOf(descriptor.identityId).some(row => row.roomId === descriptor.roomId)) return false;
    // Normalized rooms refuse the whole-room read; their policy comes from a
    // bounded selected read of exactly the records the checks below use.
    const state = canonicalNativeMentionPolicyContext(store, descriptor, event, context)
      ?? (isCurrentRoom(store.db, descriptor.roomId)
        ? readCurrentWakePolicyState(store, descriptor.roomId, [context.actorId, descriptor.memberId], {
          workItemId: context.kind === 'work' ? context.workItemId : null,
          messageId: ['mention', 'squad-mention', 'dm'].includes(context.kind) ? event?.data?.messageId ?? null : null })
        : store.room(descriptor.roomId).state);
    if (!state) return false;
    const actor = state.members[context.actorId], target = state.members[descriptor.memberId];
    if (!actor || actor.active === false || !target || target.active === false || context.actorId === descriptor.memberId || state.room.archivedAt
      || firstBlockedWakeTarget(state, context.actorId, [descriptor.memberId]) || mutedEvent(state, descriptor.memberId, { actorId: context.actorId })) return false;
    if (context.kind === 'board') return descriptor.scopes.includes('work:read')
      && mayWake(store.db, state, descriptor.roomId, context.actorId, descriptor.memberId)
      && nativeClaimWakeAllowed(store, descriptor.roomId, descriptor.memberId, context.actorId, context.workClaimId, context.claimBasis);
    if (context.kind === 'work') {
      const item = state.workItems[context.workItemId];
      if (!item || item.revision !== context.workRevision || !store.workWakes.permitted(state, item, descriptor.memberId, context.actorId)) return false;
      const next = nextWorkStep(item, store.now(), state.room.ownerId);
      return next.needsAttention && next.memberId === descriptor.memberId;
    }
    return mayWake(store.db, state, descriptor.roomId, context.actorId, descriptor.memberId);
  });
}

// A native event subscription is an explicit opt-in independent of desktop
// host registration. Workers deliberately has no automatic egress fallback.
export function createMcpEventsRuntime({ store, accountProvider, inviteProvider, resource, transport, dnsResolvers, externalScheduler = false }) {
  if (!resource || (isWorkersRuntime() && (!transport || !externalScheduler))) return null;
  const authorize = descriptor => authorizeMcpOAuthDescriptor({ store, accountProvider, inviteProvider, resource, descriptor });
  const authorizeEvent = (descriptor, input) => authorizeNativeEvent(store, descriptor, input);
  const manager = createMcpEventSubscriptions({ store, authorize, authorizeEvent, transport, dnsResolvers });
  const emit = ({ roomId, memberId, identityId, messageId, requestId, eventId = messageId, actorId, kind, workItemId, workRevision, workClaimId, claimBasis, nextRead }) => {
    if (!memberId && identityId) memberId = store.db.prepare('SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?').get(roomId, identityId)?.member_id;
    if (!memberId) return 0;
    const hasRequest = /^[A-Za-z0-9_-]{1,128}$/.test(requestId ?? '');
    return manager.enqueueRequested({ roomId, memberId,
      ...(/^[A-Za-z0-9_-]{1,128}$/.test(messageId ?? '') ? { messageId } : {}),
      ...(hasRequest ? { requestId } : {}),
      nextRead: hasRequest ? { tool: 'room_read_request', arguments: { roomId, requestMessageId: requestId, view: 'compact' } } : nextRead,
      context: { actorId, kind, ...(kind === 'work' ? { workItemId, workRevision } : {}), ...(kind === 'board' ? { workClaimId, claimBasis } : {}) },
      eventId: nativeOutboxEventId(roomId, memberId, eventId) });
  };
  const handler = async (message, { descriptor }) => {
    const result = value => ({ jsonrpc: '2.0', id: message.id, result: value });
    if (!authorize(descriptor)) return { jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Event grant denied' } };
    const args = message.params ?? {};
    try {
      if (message.method === 'events/list') {
        if (args.cursor !== undefined && args.cursor !== null) throw Object.assign(new Error('No event catalog pagination'), { code: -32602 });
        const events = [{ name: 'room.requested', delivery: ['webhook'],
          payloadSchema: { type: 'object', properties: { roomId: { type: 'string' }, memberId: { type: 'string' }, messageId: { type: 'string' }, requestId: { type: 'string' },
            nextRead: { type: 'object', properties: { tool: { enum: ['room_read_request', 'room_read_work', 'room_read_result'] },
              arguments: { type: 'object', properties: { roomId: { type: 'string' }, requestMessageId: { type: 'string' },
                workItemId: { type: 'string' }, completionEventId: { type: 'string' }, view: { const: 'compact' },
                brief: { const: true } }, required: ['roomId'], additionalProperties: false } },
              required: ['tool', 'arguments'], additionalProperties: false } }, required: ['roomId', 'memberId'], additionalProperties: false }, description: 'A permitted mention, direct request, or work transition needs this agent. When data.nextRead is present, use its read tool and arguments directly. Review only with the exact action returned by that read. Older hosts can still use data.requestId with room_read_request. Subscriptions cover future events, not earlier requests. On connection or reconnection, call room_list_requests with direction=incoming and status=open in this room and follow every nextRead. Finish each selected room_read_request before responding with its current answerBasis; do not resend saved requests.' + (transport?.configurationPending ? ' Callback delivery is pending operator verification: subscriptions currently return callback_origin_not_allowed; provide only the returned origin to the operator, never the callback path or signing secret.' : ''),
          inputSchema: { type: 'object', properties: { roomId: { type: 'string', const: descriptor.roomId }, memberId: { type: 'string', const: descriptor.memberId } }, required: ['roomId', 'memberId'], additionalProperties: false } }];
        if (descriptor.scopes.includes('work:read') && descriptor.scopes.includes('rooms:read')) events.push({
          name: discoveryEvent, delivery: ['webhook'], inputSchema: events[0].inputSchema,
          description: 'Opt in to private project finding pointers for projects designating you as a reviewer. Follow the supplied exact read.',
          payloadSchema: { type: 'object', additionalProperties: false, required: ['roomId', 'memberId', 'nextRead'],
            properties: {
              roomId: { type: 'string' }, memberId: { type: 'string' },
              nextRead: { type: 'object', additionalProperties: false, required: ['tool', 'arguments'], properties: {
                tool: { const: 'room_read_project_discoveries' },
                arguments: { type: 'object', additionalProperties: false, required: ['roomId', 'offerId', 'at'],
                  properties: { roomId: { type: 'string' }, offerId: { type: 'string' }, at: { type: 'string' } } }
              } }
            } }
        });
        return result({ events, ttlMs: 0, cacheScope: 'private' });
      }
      if (message.method === 'events/subscribe') return result(await manager.subscribe({ ...args, principal: descriptor }));
      if (message.method === 'events/unsubscribe') {
        return result(manager.unsubscribe({ ...args, principal: descriptor }));
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
    } catch (error) {
      const code = Number.isInteger(error.code) ? error.code : -32603;
      if (message.method === 'events/subscribe') {
        const diagnostic = { event: 'room.mcp_event_subscription_rejected', code };
        // Host task services may hide JSON-RPC errors. Log only the origin
        // needed for operator verification, never callback paths or secrets.
        if (code === -32015 && error.data?.reason === 'callback_origin_not_allowed') {
          diagnostic.reason = 'callback_origin_not_allowed';
          try {
            const origin = new URL(error.data.origin);
            if (origin.protocol === 'https:' && origin.origin.length <= 2048) diagnostic.origin = origin.origin;
          } catch { /* Malformed diagnostics must not expose the original value. */ }
        }
        try { console.warn(JSON.stringify(diagnostic)); } catch { /* Diagnostics cannot replace the protocol error. */ }
      }
      return { jsonrpc: '2.0', id: message.id, error: { code,
        message: Number.isInteger(error.code) ? error.message : 'Event operation failed', ...(error.data ? { data: error.data } : {}) } };
    }
  };
  let running = false, stopped = false;
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try { return await manager.drain({ limit: externalScheduler ? 1 : 10 }); } finally { running = false; }
  };
  const timer = externalScheduler ? null : setInterval(() => { drain().catch(() => {}); }, 1000);
  timer?.unref?.();
  return { handler, emit, drain, status: manager.status, stop() { stopped = true; clearInterval(timer); } };
}
