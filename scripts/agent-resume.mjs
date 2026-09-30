import { pathToFileURL } from 'node:url';
import { agentConnectionFromEnvironment, connectionDiagnostic, ConnectionError } from '../client/agent-connection.mjs';
import { resumeAgent } from '../client/agent-resume.mjs';

export async function main(args = process.argv.slice(2), { env = process.env, write = console.log, fetchImpl = fetch } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    write('Usage: node scripts/agent-resume.mjs [--since-version HEX] [--attention-cursor JSON]\nReads current obligations and claim references. No acknowledgement or execution. Uses the existing private Room connection.');
    return 0;
  }
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i] === '--since-version' ? 'sinceVersion' : args[i] === '--attention-cursor' ? 'attentionCursor' : null;
      if (!key || args[i + 1] === undefined || Object.hasOwn(options, key)) throw new ConnectionError('usage_error');
      try { options[key] = key === 'attentionCursor' ? JSON.parse(args[i + 1]) : args[i + 1]; }
      catch { throw new ConnectionError('usage_error'); }
    }
    const result = await resumeAgent({ connection: agentConnectionFromEnvironment(env), fetchImpl, ...options });
    write(JSON.stringify(result));
    return result.incompleteSources.length ? 1 : 0;
  } catch (error) { write(JSON.stringify(connectionDiagnostic(error))); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
