#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openEvolution, events, requireThat } from '../client/evolution/store.mjs';
import { installPackage, activate, evaluate, rollback } from '../client/evolution/registry.mjs';
import { installRepositoryPackage } from '../client/evolution/repository-package.mjs';
import { readAgentConnection } from '../client/agent-connection.mjs';
import { runRoomCapability } from '../client/evolution/room-bridge.mjs';
import { configure, submit, getJob, runJob, status, cancel, reconcile, feedback } from '../client/evolution/executor.mjs';

// One owner-private state directory per laptop, shared by all local room clients.
// This CLI is a local authority boundary, not an unauthenticated network API.
export const defaultDirectory = () => join(homedir(), 'Library', 'Application Support', 'Project Room', 'evolution');
export async function command(store, name, args = {}, signal) {
  switch (name) {
    case 'room-run': return runRoomCapability(store, { connection: readAgentConnection(args.connectionDirectory), requestMessageId: args.requestMessageId, signal });
    case 'configure': return configure(store, args);
    case 'install-repository': return installRepositoryPackage(store, args);
    case 'install': return installPackage(store, args.root, args.manifest);
    case 'activate': return activate(store, args);
    case 'rollback': return rollback(store, args);
    case 'evaluate': return evaluate(store, args);
    case 'submit': return submit(store, args);
    case 'run': return runJob(store, args.jobId, { signal });
    case 'job': return getJob(store, args.jobId);
    case 'status': return status(store);
    case 'events': return events(store, args.after ?? 0, args.limit ?? 100);
    case 'cancel': return cancel(store, args.jobId);
    case 'reconcile': return reconcile(store, args.jobId, args);
    case 'feedback': return feedback(store, args.jobId, args);
    default: throw new Error('unknown_command');
  }
}
async function main() {
  const [name, input] = process.argv.slice(2);
  if (!name || name === '--help') {
    console.log('room-evolution <configure|install|install-repository|activate|evaluate|rollback|submit|run|job|status|events|cancel|reconcile|feedback|room-run|watch> [JSON_FILE]\nROOM_EVOLUTION_DIRECTORY overrides the device-wide private state directory. JSON responses; no shell commands in submitted jobs.'); return;
  }
  const store = openEvolution(process.env.ROOM_EVOLUTION_DIRECTORY ?? defaultDirectory());
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const args = input ? JSON.parse(readFileSync(input, 'utf8')) : {};
    if (name === 'watch') {
      const intervalMs = args.intervalMs ?? 1000; requireThat(Number.isInteger(intervalMs) && intervalMs >= 200 && intervalMs <= 60000, 'invalid_interval');
      while (!controller.signal.aborted) {
        const queued = store.db.prepare("SELECT id FROM jobs WHERE state='queued' ORDER BY rowid LIMIT 50").all();
        for (const job of queued) {
          if (controller.signal.aborted) break;
          const result = await runJob(store, job.id, { signal: controller.signal });
          if (result.claimed) console.log(JSON.stringify({ jobId: job.id, state: result.job.state, pin: result.job.pin }));
        }
        try { await delay(intervalMs, undefined, { signal: controller.signal }); } catch { break; }
      }
    } else console.log(JSON.stringify(await command(store, name, args, controller.signal)));
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
