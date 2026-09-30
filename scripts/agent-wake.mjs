import { pathToFileURL } from 'node:url';
import { AgentWakeClient } from '../client/agent-wake.mjs';
import { agentConnectionFromEnvironment, connectionDiagnostic, ConnectionError } from '../client/agent-connection.mjs';
export async function main(args = process.argv.slice(2), { env = process.env, write = console.log, fetchImpl = fetch } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    write('Usage: agent-wake.mjs doctor --host ID | setup --host ID --cadence-seconds N | wait --host ID --cadence-seconds N [--wait-ms N] [--attention-cursor JSON] [--since-version HEX] | ack --host ID --signal ID [--signal ID ...]\nUses the existing private Room connection. Setup registers, not starts a listener or model. Wait reads wake hints and fresh attention; it never acknowledges. Ack only after handling the selected signal.'); return 0;
  }
  try {
    const action = args[0]; if (!['doctor', 'setup', 'wait', 'ack'].includes(action)) throw new ConnectionError('usage_error');
    const options = {}; const allowed = { doctor: ['hostId'], setup: ['hostId', 'cadenceSeconds'], wait: ['hostId', 'cadenceSeconds', 'waitMs', 'attentionCursor', 'sinceVersion'], ack: ['hostId', 'signalIds'] };
    const flags = { '--host': 'hostId', '--cadence-seconds': 'cadenceSeconds', '--wait-ms': 'waitMs', '--attention-cursor': 'attentionCursor', '--since-version': 'sinceVersion', '--signal': 'signalIds' };
    for (let i = 1; i < args.length; i += 2) {
      const key = flags[args[i]], value = args[i + 1];
      if (!key || !allowed[action].includes(key) || value === undefined || key !== 'signalIds' && Object.hasOwn(options, key)) throw new ConnectionError('usage_error');
      if (key === 'signalIds') (options.signalIds ??= []).push(value);
      else if (key === 'attentionCursor') { try { options[key] = JSON.parse(value); } catch { throw new ConnectionError('usage_error'); } }
      else options[key] = ['cadenceSeconds', 'waitMs'].includes(key) ? Number(value) : value;
    }
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.hostId ?? '') || ['setup', 'wait'].includes(action) && options.cadenceSeconds === undefined) throw new ConnectionError('usage_error');
    const client = new AgentWakeClient({ connection: agentConnectionFromEnvironment(env), fetchImpl });
    const result = await client[action](options); write(JSON.stringify(result));
    return result.observations && [result.observations.before, result.observations.after].some(row => row.incompleteSources.length) ? 1 : 0;
  } catch (error) { write(JSON.stringify(connectionDiagnostic(error))); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
