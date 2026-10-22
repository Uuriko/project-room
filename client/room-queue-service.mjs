import { setTimeout as sleep } from 'node:timers/promises';
import { queueRoomPointer, validateQueueBinding } from './codex-queue.mjs';
import { roomEventPointer } from './claude-channel.mjs';
import { isTransientWakeError, wakeRetryDelayMs } from './wake-retry.mjs';

// The service transports pointers. It never executes Room-provided commands or
// ACKs a notification on transport acceptance. Existing receipts own replay.
export async function runRoomQueueService({ binding, hostId, journal, wake, client,
  allowedSenders, run, signal, emit = () => {}, wait = sleep, maxPages = 10,
  maxDispatches = 4, minCreatedAt = 0 }) {
  validateQueueBinding(binding);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(hostId ?? '') || !Array.isArray(allowedSenders)
    || !allowedSenders.length || allowedSenders.some(id => typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(id))
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100
    || !Number.isSafeInteger(maxDispatches) || maxDispatches < 1 || maxDispatches > 20
    || !Number.isSafeInteger(minCreatedAt) || minCreatedAt < 0 || !signal)
    throw new Error('invalid_service_config');
  const senders = new Set(allowedSenders);
  // Suppression only: never use this cache to authorize new work. The durable
  // journal remains authoritative across restart and eviction.
  const seenReceipts = new Map();
  let failures = 0, started = false, cursor = null;
  const pause = ms => wait(ms, undefined, { signal });
  const eligible = async pointer => {
    if (!pointer.messageId) return false;
    const result = await client.messageThread(pointer.messageId);
    const source = result?.thread;
    if (result?.roomId !== binding.roomId || source?.id !== pointer.messageId || source.deletedAt
      || !senders.has(source.authorId) || source.authorId === binding.memberId
      || source.toMemberId !== binding.memberId) return false;
    if (source.requestKind === 'reply') {
      const context = await client.replyContext(source.id);
      if (context?.request?.status !== 'open' || context.request.recipientId !== binding.memberId) return false;
    }
    return true;
  };
  emit({ status: 'connecting', execution: 'not_observed' });
  try {
    while (!signal.aborted) {
      let pages = 0, dispatched = 0, replaySkipped = 0, pollMs = 0, contended = false;
      const cycleStarted = performance.now();
      try {
        do {
          const pollStarted = performance.now();
          const page = await wake.wait({ hostId, cadenceSeconds: 60, deliveryOnly: true,
            waitMs: started && cursor === null ? 25000 : 0, cursor });
          pollMs += performance.now() - pollStarted;
          if (signal.aborted) break;
          started = true;
          if (page.status === 'listener_contended') {
            contended = true;
            emit({ status: 'contended', execution: 'not_observed' }); break;
          }
          if (!Array.isArray(page.pendingWakes)) throw new Error('invalid_wake_page');
          emit({ status: 'listening', execution: 'not_observed' });
          let pageComplete = true;
          for (const entry of page.pendingWakes) {
            if (signal.aborted || dispatched >= maxDispatches) { pageComplete = false; break; }
            // Explicit installation boundary prevents old room chatter flooding
            // an existing session. Older work stays pending for manual review.
            if (!Number.isFinite(entry.createdAt) || entry.createdAt < minCreatedAt) continue;
            const pointer = roomEventPointer(entry, binding.roomId);
            if (!pointer) continue;
            const fingerprint = JSON.stringify(pointer);
            if (seenReceipts.get(pointer.signalId) === fingerprint) { replaySkipped++; continue; }
            if (!await eligible(pointer)) continue;
            const receipt = await queueRoomPointer({ binding, pointer, journal,
              authorize: async () => { await client.checkConnection(); return !signal.aborted; },
              run: async args => {
                const current = await wake.wait({ hostId, cadenceSeconds: 60, waitMs: 0, cursor, deliveryOnly: true });
                if (signal.aborted || current.status === 'listener_contended'
                  || !current.pendingWakes.some(row => JSON.stringify(roomEventPointer(row, binding.roomId)) === JSON.stringify(pointer))
                  || !await eligible(pointer)) return 'unknown';
                return run(args);
              } });
            seenReceipts.set(pointer.signalId, fingerprint);
            if (seenReceipts.size > 2048) seenReceipts.delete(seenReceipts.keys().next().value);
            if (!receipt.duplicate) dispatched++;
            emit({ ...receipt, transportStatus: receipt.status,
                status: receipt.status === 'accepted' ? 'queued' : 'attention_required',
                signalId: pointer.signalId });
          }
          if (page.more && !page.nextCursor) throw new Error('wake_pagination_unavailable');
          // Carry bounded pagination across cycles. If dispatch exhausted the
          // budget mid-page, replay that page through durable receipt dedupe.
          if (pageComplete) cursor = page.nextCursor ?? null;
          pages++;
        } while (cursor && pages < maxPages && dispatched < maxDispatches && !signal.aborted);
        failures = 0;
        emit({ status: contended ? 'contended' : 'listening', execution: 'not_observed', metrics: {
          cycleMs: performance.now() - cycleStarted, pollMs, pages, dispatched,
          replaySkipped, cachedReceipts: seenReceipts.size } });
        // A bounded backlog batch yields the event loop, not a full second.
        // Idle/backoff pacing stays intact to avoid hammering pending wakes.
        if (!signal.aborted) await pause(cursor ? 0 : 2000);
      } catch (error) {
        if (signal.aborted) break;
        if (!isTransientWakeError(error)) throw error;
        const retryMs = wakeRetryDelayMs(failures++, error);
        emit({ status: 'retrying', retryMs, execution: 'not_observed' });
        try { await pause(retryMs); } catch (pauseError) {
          if (!signal.aborted) throw pauseError;
        }
      }
    }
  } finally {
    emit({ status: 'stopped', execution: 'not_observed' });
  }
}
