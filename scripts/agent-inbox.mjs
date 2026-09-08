import { RoomAgentClient } from "../client/room-agent.mjs";
import { packetMarkdown } from "../src/work-packet.js";
import { validId } from "../src/events.js";

const [action = "orient", checkpoint, ...extra] = process.argv.slice(2);
if (action === "watch") {
  const { watchMain } = await import("./agent-watch.mjs");
  await watchMain(process.argv.slice(3));
} else if (action === "--help") {
  console.log("Read-only agent client: node scripts/agent-inbox.mjs [orient|brief|changes CHECKPOINT|packet WORK_ID|work WORK_ID [--include-source]]\nAssignment watching: node scripts/agent-inbox.mjs watch --help\nSet ROOM_AGENT_ORIGIN, ROOM_AGENT_ROOM, and ROOM_AGENT_TOKEN in the local process environment. Never put a key in a URL or command argument. Work returns authenticated current task context, not a public export; its linked source is opt-in. Packet is a narrower proposal-only export, without source messages. This client does not start an AI runtime or execute work.");
} else {
  try {
    if (!["orient", "brief", "changes", "packet", "work"].includes(action)
      || (["packet", "work"].includes(action) && !validId(checkpoint))
      || (action === "work" ? extra.length > 1 || (extra.length === 1 && extra[0] !== "--include-source")
        : extra.length || (["orient", "brief"].includes(action) && checkpoint !== undefined))) throw new Error("Choose a documented read with exact arguments");
    const client = new RoomAgentClient({
      origin: process.env.ROOM_AGENT_ORIGIN, roomId: process.env.ROOM_AGENT_ROOM, token: process.env.ROOM_AGENT_TOKEN
    });
    const result = action === "work" ? await client.workContext(checkpoint, { includeSource: extra[0] === "--include-source" })
      : action === "packet" ? packetMarkdown(await client.workPacket(checkpoint)) : action === "orient" ? await client.orient() : action === "brief" ? await client.returnBrief() : await client.changes(Number(checkpoint));
    console.log(action === "packet" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    // Fixed diagnostic text avoids printing transport internals or environment secrets.
    console.error("Agent read did not complete. Check the configured service, Room, active key, and command. No write was requested.");
    process.exitCode = 1;
  }
}
