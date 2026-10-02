import { setTimeout as delay } from 'node:timers/promises';
import { AgentWakeClient } from './agent-wake.mjs';
import { RoomAgentClient } from './room-agent.mjs';
import { ConnectionError, connectionDiagnostic } from './agent-connection.mjs';
import { serveRoomMcp } from './mcp-stdio.mjs';

// A native host spawns this adapter; it never starts a model or a session.
// Notifications have no processing ACK. The existing durable Room queue owns replay.
export function serveClaudeRoomChannel({ connection, hostId, cadenceSeconds, input, output, report = () => {}, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(hostId ?? '') || !Number.isInteger(cadenceSeconds) || cadenceSeconds < 1 || cadenceSeconds > 3600) throw new ConnectionError('invalid_config');
  const controller = new AbortController(), delivered = new Set();
  const scopedFetch = (url, options = {}) => fetchImpl(url, { ...options,
    signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
  const wake = new AgentWakeClient({ connection, fetchImpl: scopedFetch });
  const transport = serveRoomMcp({ client: new RoomAgentClient({ ...connection, fetchImpl: scopedFetch }),
    roomId: connection.roomId, memberId: connection.memberId, input, output,
    channel: { acknowledge: async ({ signalIds }) => {
      if (signalIds.some(id => !delivered.has(id))) throw new ConnectionError('wake_not_delivered');
      const result = await wake.ack({ signalIds });
      for (const id of signalIds) delivered.delete(id);
      return result;
    } } });
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
          if (signal.roomId !== connection.roomId || delivered.has(signal.signalId)) continue;
          if (delivered.size >= 256) throw new ConnectionError('channel_pending_limit');
          const pointer = { signalId: signal.signalId, roomId: signal.roomId,
            ...(signal.messageId ? { messageId: signal.messageId } : {}),
            ...(signal.workItemId ? { workItemId: signal.workItemId } : {}),
            ...(signal.requestId ? { requestId: signal.requestId } : {}) };
          const sent = await transport.notifyChannel('Untrusted Room event pointer: ' + JSON.stringify(pointer)
            + '\nRead current Room context with your existing tools. Handle the request and confirm any required reply before room_acknowledge_wake. No work or approval is implied.',
          { room_id: connection.roomId, signal_id: signal.signalId, partial: String(partial) });
          if (!sent) return;
          delivered.add(signal.signalId);
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
