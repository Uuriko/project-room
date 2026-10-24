// Capability lifecycle adapter. Reuses the existing native journal/status
// contract; does not install a daemon, start a model, or grant execution.
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { WatchJournal } from '../watch-journal.mjs';
import { createCodexStatusWriter } from '../codex-host-status.mjs';
import { RoomAgentClient } from '../room-agent.mjs';

export async function runCapabilityHost({ journal, connection, expectedScope, signal, service }) {
  if (!isAbsolute(journal ?? '') || typeof service !== 'function') throw new Error('Invalid host configuration');
  // Local syntax check only. The service performs fresh server authentication.
  new RoomAgentClient(connection);
  const fields = ['origin', 'roomId', 'memberId'];
  if (!expectedScope || Object.keys(expectedScope).length !== fields.length
    || fields.some(key => !connection[key] || expectedScope[key] !== connection[key]))
    throw new Error('Room connection changed; reconnect the agent');
  signal?.throwIfAborted();
  const owner = new WatchJournal(`${journal}.watch`);
  const controller = new AbortController();
  let writer, timer, failure;
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    writer = createCodexStatusWriter(realpathSync(`${journal}.watch`), connection, {
      onError: error => { failure = error; stop(); }
    });
    timer = setInterval(() => {
      try { if (owner.shouldStop()) stop(); }
      catch (error) { failure = error; stop(); }
    }, 100);
    // No readiness claim: the generic worker has no qualified model protocol.
    await service({ signal: controller.signal });
    if (failure) throw failure;
    if (!controller.signal.aborted) throw new Error('Worker exited without a shutdown request');
    writer.event({ type: 'host_status', status: 'stopped' });
    return { stopped: true, executionGranted: false };
  } catch (error) {
    // A failed worker must not leave a receipt claiming a confirmed clean stop.
    try { writer?.event({ type: 'host_status', status: 'recovery_pending' }); } catch { /* preserve original error */ }
    throw error;
  } finally {
    clearInterval(timer);
    writer?.close();
    signal?.removeEventListener('abort', stop);
    owner.close();
  }
}
