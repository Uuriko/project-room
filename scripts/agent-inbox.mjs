import { RoomAgentClient } from "../client/room-agent.mjs";

const [action = "orient", checkpoint] = process.argv.slice(2);
if (action === "--help") {
  console.log("Read-only agent client: node scripts/agent-inbox.mjs [orient|brief|changes CHECKPOINT]\nSet ROOM_AGENT_ORIGIN, ROOM_AGENT_ROOM, and ROOM_AGENT_TOKEN in the local process environment. Never put a key in a URL or command argument. This client does not start an AI runtime or execute work.");
} else {
  try {
    if (!["orient", "brief", "changes"].includes(action)) throw new Error("Choose orient, brief, or changes CHECKPOINT");
    const client = new RoomAgentClient({
      origin: process.env.ROOM_AGENT_ORIGIN, roomId: process.env.ROOM_AGENT_ROOM, token: process.env.ROOM_AGENT_TOKEN
    });
    const result = action === "orient" ? await client.orient() : action === "brief" ? await client.returnBrief() : await client.changes(Number(checkpoint));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Fixed diagnostic text avoids printing transport internals or environment secrets.
    console.error("Agent read did not complete. Check the configured service, Room, active key, and command. No write was requested.");
    process.exitCode = 1;
  }
}
