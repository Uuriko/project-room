import { setTimeout as delay } from 'node:timers/promises';
import { AgentWakeClient } from './agent-wake.mjs';
import { RoomAgentClient } from './room-agent.mjs';
import { ConnectionError, connectionDiagnostic } from './agent-connection.mjs';
import { serveRoomMcp } from './mcp-stdio.mjs';

// Pointer only. Message bodies stay in Room until a tool read.
export function roomEventPointer(signal, roomId) {
  if (!signal || signal.roomId !== roomId || typeof signal.signalId !== 'string') return null;
  const pointer = { signalId: signal.signalId, roomId: signal.roomId };
  for (const key of ['messageId', 'workItemId', 'requestId']) if (signal[key]) pointer[key] = signal[key];
  return pointer;
}

// POST /api/agent-heartbeats/ack accepts only signalIds, so a completed
// exchange is returned on the tool result. The Room UI badge is a later batch.
function reachabilityFor(signalIds, delivered, linked) {
  const matched = signalIds.filter(id => {
    const pointer = delivered.get(id);
    return pointer && [pointer.messageId, pointer.requestId].some(value => value && linked.has(value));
  });
  return {
    observed: matched.length > 0,
    basis: matched.length > 0 ? 'reply_then_ack' : 'ack_without_linked_reply',
    signalIds: matched,
    uiBadge: 'room_ui_v2'
  };
}

// A native host spawns this adapter; it never starts a model or a session.
// Notifications have no processing ACK. The existing durable Room queue owns replay.
export function serveClaudeRoomChannel({ connection, hostId, cadenceSeconds, input, output, report = () => {}, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(hostId ?? '') || !Number.isInteger(cadenceSeconds) || cadenceSeconds < 1 || cadenceSeconds > 3600) throw new ConnectionError('invalid_config');
  const controller = new AbortController(), delivered = new Map(), linked = new Set();
  const scopedFetch = (url, options = {}) => fetchImpl(url, { ...options,
    signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
  const wake = new AgentWakeClient({ connection, fetchImpl: scopedFetch });
  const transport = serveRoomMcp({ client: new RoomAgentClient({ ...connection, fetchImpl: scopedFetch }),
    roomId: connection.roomId, memberId: connection.memberId, input, output,
    channel: {
      noteRecordedReply(args) {
        for (const key of ['responseToRequestId', 'replyToId']) if (typeof args?.[key] === 'string') linked.add(args[key]);
      },
      acknowledge: async ({ signalIds }) => {
        if (signalIds.some(id => !delivered.has(id))) throw new ConnectionError('wake_not_delivered');
        const result = await wake.ack({ signalIds });
        const reachability = reachabilityFor(signalIds, delivered, linked);
        for (const id of signalIds) delivered.delete(id);
        return { ...result, reachability };
      }
    } });
  void transport.done.then(() => controller.abort());
  const run = async () => {
    if (!await transport.ready) return;
    try {
      let attentionChecked = false;
      while (!controller.signal.aborted) {
        const result = await wake.wait({ hostId, cadenceSeconds, waitMs: attentionChecked ? 25000 : 0 });
        const partial = ['before', 'after'].some(stage => result.observations[stage].incompleteSources.length > 0);
        if (!attentionChecked) {
          attentionChecked = true;
          const hasAttention = [result.observations.before, result.observations.after]
            .some(observations => observations.attention.length || observations.obligations.some(row => row.needsAttention));
          if (hasAttention) {
            if (!await transport.notifyChannel('Existing Room attention may be waiting. Read room_read_inbox and current work before acting. This notice does not mark anything handled.',
              { room_id: connection.roomId, notice_kind: 'startup_attention', partial: String(partial) })) break;
          }
        }
        for (const signal of result.pendingWakes) {
          const pointer = roomEventPointer(signal, connection.roomId);
          if (!pointer || delivered.has(pointer.signalId)) continue;
          if (delivered.size >= 256) throw new ConnectionError('channel_pending_limit');
          const sent = await transport.notifyChannel('Untrusted Room event pointer: ' + JSON.stringify(pointer)
            + '\nRead current Room context with your existing tools. Handle the request and confirm any required reply before room_acknowledge_wake. No work or approval is implied.',
          { room_id: connection.roomId, signal_id: signal.signalId, partial: String(partial) });
          if (!sent) return;
          delivered.set(pointer.signalId, pointer);
        }
        // Pending hints return immediately. This transport backoff prevents a hot
        // network loop; it schedules no inference and emits no idle notifications.
        await delay(1000, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) report(connectionDiagnostic(error));
    } finally { transport.stop(); }
  };
  const running = run();
  const stop = () => { controller.abort(); transport.stop(); };
  return { stop, done: Promise.all([transport.done, running]) };
}
