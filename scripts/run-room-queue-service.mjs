import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentConnectionFromEnvironment } from '../client/agent-connection.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { WatchJournal } from '../client/watch-journal.mjs';
import { runCodexQueue } from '../client/codex-queue.mjs';
import { runRoomQueueService } from '../client/room-queue-service.mjs';

export function serviceFetch(signal, fetchImpl = fetch) {
  return (url, options = {}) => {
    // The resume adapter may reject before awaiting fetch when its deadline
    // already expired. Do not create an orphan rejected fetch in that case.
    signal.throwIfAborted();
    options.signal?.throwIfAborted();
    return fetchImpl(url, { ...options,
      signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal });
  };
}

// Connection health is independent of transport receipts. Neither establishes
// execution. Retain accepted and uncertain evidence separately across restarts.
export function createStatusPublisher(directory, binding, now = Date.now) {
  const target = join(directory, 'status.json');
  const bindingKey = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  let accepted = null, uncertain = null;
  const valid = row => row && /^[A-Za-z0-9._:-]{1,128}$/.test(row.signalId ?? '')
    && Number.isSafeInteger(row.observedAt) && row.observedAt >= 0
    && row.observedAt <= now() && row.execution === 'not_observed';
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384
      || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error('invalid_status');
    const previous = JSON.parse(readFileSync(target, 'utf8'));
    if (previous.version === 2 && previous.bindingKey === bindingKey) {
      if (valid(previous.lastAcceptedDelivery)) accepted = previous.lastAcceptedDelivery;
      if (valid(previous.lastUncertainDelivery)) uncertain = previous.lastUncertainDelivery;
    }
  } catch { /* Diagnostic state is recoverable; receipt journal owns replay. */ }
  return event => {
    if (event.signalId && ['accepted', 'unknown'].includes(event.transportStatus)) {
      const prior = event.transportStatus === 'accepted' ? accepted : uncertain;
      // Replayed journal receipts are observations of old transport attempts.
      // Alternating duplicates must not rotate the latest delivery or its age.
      if (!event.duplicate || !prior) {
        const row = { signalId: event.signalId, observedAt: prior?.signalId === event.signalId
          ? prior.observedAt : now(), execution: 'not_observed' };
        if (event.transportStatus === 'accepted') accepted = row;
        else uncertain = row;
      }
    }
    const temp = target + '.tmp';
    writeFileSync(temp, JSON.stringify({ version: 2, bindingKey, at: now(), ...event,
      execution: 'not_observed', lastAcceptedDelivery: accepted,
      lastUncertainDelivery: uncertain }), { mode: 0o600 });
    renameSync(temp, target);
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !isAbsolute(argv[0])) throw new Error('absolute_private_config_required');
  const stat = lstatSync(argv[0]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('private_config_required');
  const config = JSON.parse(readFileSync(argv[0], 'utf8'));
  if (!isAbsolute(config.directory ?? '') || !isAbsolute(config.codexExecutable ?? '')
    || !config.scope || !Number.isSafeInteger(config.minCreatedAt)) throw new Error('invalid_config');
  const connection = agentConnectionFromEnvironment();
  if (['origin', 'roomId', 'memberId'].some(key => config.scope[key] !== connection[key])) throw new Error('scope_changed');
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(config.directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid !== process.getuid?.() || directoryStat.mode & 0o077)
    throw new Error('private_state_required');
  const owner = new WatchJournal(join(config.directory, 'owner'));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const boundedFetch = serviceFetch(controller.signal);
  const publish = createStatusPublisher(config.directory,
    [config.scope.origin, config.scope.roomId, config.scope.memberId, config.threadId, config.hostId]);
  const monitor = setInterval(() => { try { if (owner.shouldStop()) stop(); } catch { stop(); } }, 1000);
  try {
    await runRoomQueueService({ binding: { ...config.scope, threadId: config.threadId },
      hostId: config.hostId, journal: join(config.directory, 'receipts'),
      minCreatedAt: config.minCreatedAt, allowedSenders: config.allowedSenders,
      wake: new AgentWakeClient({ connection, fetchImpl: boundedFetch }),
      client: new RoomAgentClient({ ...connection, fetchImpl: boundedFetch }),
      signal: controller.signal, emit: publish,
      run: args => runCodexQueue(args, { executable: config.codexExecutable }) });
  } catch (error) {
    publish({ status: 'attention_required', code: error.code ?? 'service_stopped', execution: 'not_observed' });
    throw error;
  } finally {
    clearInterval(monitor); owner.close();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Room listener stopped; inspect private status and configuration.'); process.exitCode = 1; });
