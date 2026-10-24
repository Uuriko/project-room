import { setTimeout as delay } from 'node:timers/promises';
import { RoomAgentClient } from '../room-agent.mjs';
import { flushJobArtifacts } from './artifacts.mjs';
import { policy } from './executor.mjs';
import { canonical, digest, event, requireThat } from './store.mjs';
import { parseCapabilityTask, runRoomCapability } from './room-bridge.mjs';

// Project Room events wake ordinary code. No Codex schedule, model loop or
// automatic follow-up request is created. Startup always re-reads standing
// requests: a persisted event cursor is not evidence that a job completed.
export async function watchRoomCapabilities(store, { connection, signal, intervalMs = 15000, emit = () => {}, observeResources }) {
  requireThat(Number.isInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 60000, 'invalid_interval');
  const client = new RoomAgentClient(connection), key = 'watch-' + digest(canonical([connection.origin, connection.roomId, connection.memberId]));
  const saved = store.db.prepare('SELECT value FROM settings WHERE id=?').get(key);
  let checkpoint = saved ? JSON.parse(saved.value) : { after: 0, lastRequest: '' }, unavailable = false;
  const reported = new Map();
  while (!signal?.aborted) {
    let cursor = checkpoint.after, changed = false;
    try {
      const work = await client.agentWork({ signal });
      unavailable = false;
      const requests = work.requests.filter(r => r.status === 'open').sort((a, b) => a.id.localeCompare(b.id));
      const currentIds = new Set(requests.map(r => r.id));
      for (const id of reported.keys()) if (!currentIds.has(id)) reported.delete(id);
      let start = requests.findIndex(r => r.id > checkpoint.lastRequest); if (start < 0) start = 0;
      const selected = requests.slice(start, start + 50);
      for (const request of selected) {
        signal?.throwIfAborted();
        checkpoint.lastRequest = request.id;
        if (Object.hasOwn(work.blockedBy ?? {}, request.id)) continue;
        const context = await client.replyContext(request.id, { limit: 50, signal });
        const opening = context.page.items.find(r => r.message?.id === request.id)?.message;
        try { parseCapabilityTask(opening?.body); } catch { continue; }
        try {
          const result = await runRoomCapability(store, { connection, requestMessageId: request.id, signal, observeResources });
          reported.delete(request.id); emit({ requestMessageId: request.id, ...result });
        } catch (error) {
          if (signal?.aborted) break;
          if (reported.get(request.id) !== error.message) {
            reported.set(request.id, error.message);
            event(store, 'room.request_waiting', request.id, { reason: error.message });
            emit({ requestMessageId: request.id, state: 'waiting', reason: error.message });
          }
        }
      }
      if (policy(store).publishArtifacts === true && !policy(store).paused) {
        for (const delivery of await flushJobArtifacts(store, { connection, signal })) emit({ artifactDelivery: delivery });
      }
      cursor = Number.isSafeInteger(work.evaluatedThrough) ? work.evaluatedThrough : cursor;
      checkpoint = { after: cursor, lastRequest: checkpoint.lastRequest };
      store.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(key, canonical(checkpoint));
    } catch (error) {
      if (!signal?.aborted && !unavailable) { emit({ state: 'connection_unavailable', reason: error.message }); unavailable = true; }
    }
    if (signal?.aborted) break;
    const started = Date.now();
    try { ({ changed } = await client.waitForChange(cursor, { signal, timeoutMs: intervalMs })); } catch { /* Bounded polling catches disconnects and resource changes. */ }
    if (!changed && !signal?.aborted) {
      try { await delay(Math.max(0, intervalMs - (Date.now() - started)), undefined, { signal }); } catch { break; }
    }
  }
}
