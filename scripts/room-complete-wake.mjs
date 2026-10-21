import { pathToFileURL } from 'node:url';
import { agentConnectionFromEnvironment } from '../client/agent-connection.mjs';
import { completeReplyWake } from '../client/wake-completion.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 6 || argv[0] !== '--host' || argv[2] !== '--signal' || argv[4] !== '--reply') throw new Error('usage_error');
  const result = await completeReplyWake({ connection: agentConnectionFromEnvironment(),
    hostId: argv[1], signalId: argv[3], replyMessageId: argv[5] });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error(JSON.stringify({ status: 'completion_not_confirmed' })); process.exitCode = 1; });
}
