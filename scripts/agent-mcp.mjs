import { RoomAgentClient } from "../client/room-agent.mjs";
import { agentConnectionFromEnvironment, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";
import { serveRoomMcp } from "../client/mcp-stdio.mjs";

try {
  if (process.argv.length !== 2) throw new ConnectionError("usage_error");
  const config = agentConnectionFromEnvironment();
  if (!config.memberId) throw new ConnectionError("member_required");
  const selectedVersion = process.env.ROOM_AGENT_ATTENTION_VERSION;
  if (selectedVersion !== undefined && (process.env.ROOM_AGENT_ATTENTION_DIR === undefined || !["2", "3"].includes(selectedVersion))) throw new ConnectionError("invalid_config");
  const attention = process.env.ROOM_AGENT_ATTENTION_DIR === undefined ? undefined
    : { directory: process.env.ROOM_AGENT_ATTENTION_DIR, origin: config.origin, version: selectedVersion === "3" ? 3 : 2 };
  const server = serveRoomMcp({ client: new RoomAgentClient(config), roomId: config.roomId, memberId: config.memberId,
    input: process.stdin, output: process.stdout, attention });
  const stop = () => server.stop();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await server.done;
  process.off("SIGINT", stop); process.off("SIGTERM", stop);
} catch (error) { console.error(JSON.stringify(connectionDiagnostic(error))); process.exitCode = 1; }
