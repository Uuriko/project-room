import { agentConnectionFromEnvironment, ConnectionError, connectionDiagnostic } from '../client/agent-connection.mjs';
import { serveClaudeRoomChannel } from '../client/claude-channel.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--host' || args[2] !== '--cadence-seconds' || !process.env.ROOM_AGENT_CONFIG) throw new ConnectionError('usage_error');
  const server = serveClaudeRoomChannel({ connection: agentConnectionFromEnvironment(), hostId: args[1], cadenceSeconds: Number(args[3]),
    input: process.stdin, output: process.stdout, report: value => { console.error(JSON.stringify(value)); process.exitCode = 1; } });
  const stop = () => server.stop();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await server.done;
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
} catch (error) { console.error(JSON.stringify(connectionDiagnostic(error))); process.exitCode = 1; }
