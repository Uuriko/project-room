import { readRuntimeRoomConnection, runtimeRoomToolNames } from "../client/runtime-room-tools.mjs";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { serveRoomMcp } from "../client/mcp-stdio.mjs";

// Credential bytes stay in the private file and HTTP transport, never argv,
// model context, inherited shell environment or diagnostics.
try {
  if (process.argv.length !== 4) throw new Error("Invalid Room tool invocation");
  const connection = readRuntimeRoomConnection({ directory: process.argv[2], scope: JSON.parse(process.argv[3]) }, process.cwd());
  const server = serveRoomMcp({ client: new RoomAgentClient(connection), roomId: connection.roomId,
    memberId: connection.memberId, input: process.stdin, output: process.stdout, enabledTools: runtimeRoomToolNames });
  const stop = () => server.stop();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  await server.done;
} catch {
  console.error("Room tools unavailable: verify the selected private connection and identity");
  process.exitCode = 1;
}
