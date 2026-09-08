import { RoomAgentClient } from "../client/room-agent.mjs";
import { packetMarkdown } from "../src/work-packet.js";
import { validId } from "../src/events.js";
import { agentConnectionFromEnvironment, readConnectionInput, saveAgentConnection, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";

const [action = "orient", checkpoint, ...extra] = process.argv.slice(2);
if (action === "watch") {
  const { watchMain } = await import("./agent-watch.mjs");
  await watchMain(process.argv.slice(3));
} else if (action === "--help") {
  console.log(`Agent connection (Node 24.19+):
  node scripts/agent-inbox.mjs connect NEW_PRIVATE_DIRECTORY
  pbpaste | node scripts/agent-inbox.mjs import NEW_PRIVATE_DIRECTORY
  node scripts/agent-inbox.mjs check
  node scripts/agent-inbox.mjs work WORK_ID [--include-source]
  node scripts/agent-inbox.mjs [orient|brief|changes CHECKPOINT|packet WORK_ID]
Assignment watching: node scripts/agent-inbox.mjs watch --help

Connect checks access, then saves a new private connection; never overwrites or
issues a key. Supply ROOM_AGENT_ORIGIN, ROOM_AGENT_ROOM, ROOM_AGENT_MEMBER and
ROOM_AGENT_TOKEN through the approved process environment/secret manager first.
After saving, clear those four variables and set ROOM_AGENT_CONFIG to that directory.
Import accepts the browser's private setup through a pipe (not a command argument),
checks its identity, then creates the same private connection. Existing credential
environment variables must be cleared first. Clear your clipboard afterward.
Check/read/watch reuse the saved connection. Never mix the two sources.
Legacy reads without a saved connection still accept the original three variables;
expected agent identity is enforced when ROOM_AGENT_MEMBER is supplied.
Never put a key in a prompt, URL or command argument. No AI or work is started.
Check reads identity metadata only; work reads one task with source excluded by
default. Orient reads broader private room context. A read does not narrow the key's
permissions. See docs/AGENT-CONNECTION.md for scope, recovery and current limits.`);
} else {
  try {
    if (!["connect", "import", "check", "orient", "brief", "changes", "packet", "work"].includes(action)
      || (["connect", "import"].includes(action) && (!checkpoint || checkpoint.startsWith("--") || process.env.ROOM_AGENT_CONFIG !== undefined))
      || (action === "import" && ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"].some(name => process.env[name] !== undefined))
      || (["packet", "work"].includes(action) && !validId(checkpoint))
      || (action === "work" ? extra.length > 1 || (extra.length === 1 && extra[0] !== "--include-source")
        : extra.length || (["check", "orient", "brief"].includes(action) && checkpoint !== undefined))
      || (action === "changes" && (!/^\d+$/.test(checkpoint ?? "") || !Number.isSafeInteger(Number(checkpoint))))) throw new ConnectionError("usage_error");
    const config = action === "import" ? await readConnectionInput() : agentConnectionFromEnvironment(), client = new RoomAgentClient(config);
    let result;
    if (["connect", "import", "check"].includes(action)) {
      result = await client.checkConnection();
      if (["connect", "import"].includes(action)) {
        saveAgentConnection(checkpoint, { version: 1, ...config });
        result = { ...result, configurationSaved: true };
      }
    } else result = action === "work" ? await client.workContext(checkpoint, { includeSource: extra[0] === "--include-source" })
      : action === "packet" ? packetMarkdown(await client.workPacket(checkpoint)) : action === "orient" ? await client.orient() : action === "brief" ? await client.returnBrief() : await client.changes(Number(checkpoint));
    console.log(action === "packet" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    // Fixed diagnostic text avoids printing transport internals or environment secrets.
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 1;
  }
}
