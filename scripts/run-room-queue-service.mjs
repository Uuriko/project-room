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
  const publish = event => {
    const target = join(config.directory, 'status.json'), temp = target + '.tmp';
    writeFileSync(temp, JSON.stringify({ version: 1, at: Date.now(), ...event }), { mode: 0o600 });
    renameSync(temp, target);
  };
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
