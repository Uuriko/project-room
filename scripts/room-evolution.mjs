#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openEvolution, events } from '../client/evolution/store.mjs';
import { installPackage, activate, evaluate, rollback } from '../client/evolution/registry.mjs';
import { prepareFirstJob, verifyFirstJob } from '../client/evolution/onboarding.mjs';
import { watchLocalCapabilities, executionMetrics } from '../client/evolution/scheduler.mjs';
import { runCapabilityHost } from '../client/evolution/host.mjs';
import { watchRoomCapabilities } from '../client/evolution/room-service.mjs';
import { installRepositoryPackage } from '../client/evolution/repository-package.mjs';
import { readAgentConnection } from '../client/agent-connection.mjs';
import { openRoomInteraction, readRoomInteraction } from '../client/evolution/interactions.mjs';
import { publishJobArtifacts } from '../client/evolution/artifacts.mjs';
import { registerDataSource, removeDataSource, listDataSources, scanDataSource } from '../client/evolution/data-inputs.mjs';
import { runRoomCapability } from '../client/evolution/room-bridge.mjs';
import { configure, submit, getJob, runJob, status, readiness, cancel, reconcile, feedback } from '../client/evolution/executor.mjs';

// One owner-private state directory per laptop, shared by all local room clients.
// This CLI is a local authority boundary, not an unauthenticated network API.
export const defaultDirectory = () => join(homedir(), 'Library', 'Application Support', 'Project Room', 'evolution');
export async function command(store, name, args = {}, signal) {
  switch (name) {
    case 'source-scan': return scanDataSource(store, args);
    case 'source-register': return registerDataSource(store, args);
    case 'source-remove': return removeDataSource(store, args.id);
    case 'sources': return listDataSources(store);
    case 'room-host': {
      const connection = readAgentConnection(args.connectionDirectory);
      return runCapabilityHost({ journal: args.journal, connection, expectedScope: args.expectedScope, signal,
        service: ({ signal: hostSignal }) => watchRoomCapabilities(store, { connection, intervalMs: args.intervalMs,
          signal: hostSignal, emit: value => console.log(JSON.stringify(value)) }) });
    }
    case 'room-watch': return watchRoomCapabilities(store, { connection: readAgentConnection(args.connectionDirectory), intervalMs: args.intervalMs, signal, emit: value => console.log(JSON.stringify(value)) });
    case 'room-run': return runRoomCapability(store, { connection: readAgentConnection(args.connectionDirectory), requestMessageId: args.requestMessageId, signal });
    case 'interaction-open': return openRoomInteraction(store, { ...args, connection: readAgentConnection(args.connectionDirectory), signal });
    case 'interaction-read': return readRoomInteraction(store, { ...args, connection: readAgentConnection(args.connectionDirectory), signal });
    case 'room-publish': return publishJobArtifacts(store, { ...args, connection: readAgentConnection(args.connectionDirectory), signal });
    case 'watch': return watchLocalCapabilities(store, { signal, intervalMs: args.intervalMs, emit: value => console.log(JSON.stringify(value)) });
    case 'first-job-prepare': return prepareFirstJob(store, args);
    case 'first-job-verify': return verifyFirstJob(store, args);
    case 'metrics': return executionMetrics(store);
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
    case 'readiness': return readiness(store);
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
    console.log('room-evolution <configure|source-register|source-remove|sources|source-scan|install|install-repository|activate|evaluate|rollback|submit|run|job|status|readiness|metrics|first-job-prepare|first-job-verify|events|cancel|reconcile|feedback|room-run|room-watch|room-host|room-publish|interaction-open|interaction-read|watch> [JSON_FILE]\nROOM_EVOLUTION_DIRECTORY overrides the device-wide private state directory. JSON responses; no shell commands in submitted jobs.'); return;
  }
  const store = openEvolution(process.env.ROOM_EVOLUTION_DIRECTORY ?? defaultDirectory());
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const args = input ? JSON.parse(readFileSync(input, 'utf8')) : {};
    console.log(JSON.stringify(await command(store, name, args, controller.signal)));
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
