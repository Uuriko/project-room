#!/usr/bin/env node
import { readAgentConnection } from '../client/agent-connection.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { dispatchIntervalOnce } from '../client/interval-dispatcher.mjs';

// Explicit one-shot tick. No timer installation, provider calls or process launch.
const [mode, connectionDirectory, directory, automationId, ...extra] = process.argv.slice(2);
try {
  if (mode !== '--once' || !connectionDirectory || !directory || !automationId || extra.length) throw new Error('usage');
  const connection = readAgentConnection(connectionDirectory), client = new RoomAgentClient(connection);
  const signal = AbortSignal.timeout(15000);
  await client.checkConnection({ signal });
  const result = await dispatchIntervalOnce({ directory, client, identity: connection, automationId, signal });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (['unconfirmed', 'refused'].includes(result.status)) process.exitCode = 2;
} catch {
  // Do not expose connection tokens, paths, prompts or raw transport diagnostics.
  process.stderr.write('Interval dispatch not confirmed. Keep the journal and inspect configuration/access. Usage: room-interval --once CONNECTION_DIRECTORY PRIVATE_JOURNAL_DIRECTORY AUTOMATION_ID\n');
  process.exitCode = 1;
}
