import { RoomAgentClient } from "../client/room-agent.mjs";
import { agentConnectionFromEnvironment, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";
import { serveRoomMcp } from "../client/mcp-stdio.mjs";

try {
  if (process.argv.length !== 2) throw new ConnectionError("usage_error");
  const config = agentConnectionFromEnvironment();
  if (!config.memberId) throw new ConnectionError("member_required");
  const server = serveRoomMcp({ client: new RoomAgentClient(config), roomId: config.roomId, memberId: config.memberId, input: process.stdin, output: process.stdout });
  const stop = () => server.stop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await server.done;
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
} catch (error) { console.error(JSON.stringify(connectionDiagnostic(error))); process.exitCode = 1; }
