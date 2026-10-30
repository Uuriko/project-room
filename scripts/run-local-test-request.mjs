// One explicitly selected Room request; existing journal owns attempts and delivery.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentConnectionFromEnvironment } from '../client/agent-connection.mjs';
import { openRequestJournal, runRequestOnce } from '../client/request-runner.mjs';
import { configuredLocalTests } from '../client/local-test-executor.mjs';
import { validId } from '../src/events.js';
export async function main(args = process.argv.slice(2)) {
  const [requestMessageId, journal, profile] = args;
  if (args.length !== 3 || !validId(requestMessageId) || !isAbsolute(journal ?? '') || !isAbsolute(profile ?? ''))
    throw new Error('Usage: run-local-test-request.mjs REQUEST_ID /absolute/journal.sqlite /absolute/profile.json');
  const config = JSON.parse(readFileSync(profile, 'utf8'));
  // Construct lazily: a saved answer must remain deliverable if the source or
  // executable disappeared after its successful execution.
  let executor;
  const execute = (...values) => executor(...values);
  execute.prepare = async options => { executor = configuredLocalTests(config); await executor.prepare(options); };
  const db = openRequestJournal(journal), controller = new AbortController();
  const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runRequestOnce({ connection: agentConnectionFromEnvironment(), requestMessageId, db, execute,
      allowRequest: request => request.requesterId === config.requesterId, signal: controller.signal });
    console.log(JSON.stringify(result));
  } finally { db.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Local test request stopped. Retain the journal and inspect the original attempt; no successful delivery is claimed.'); process.exitCode = 1;
});
