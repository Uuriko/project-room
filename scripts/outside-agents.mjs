// Print or post a room message that names an agent who is not a member.
// The message grants no access and mints no identity. Other members read the
// same messages through server/outside-agents.mjs.
import { outsideAgentBody } from "../server/outside-agents.mjs";

const arg = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};
const externalRef = arg("--ref"), displayName = arg("--name"), origin = arg("--origin") ?? "other";
if (!externalRef || !displayName || process.argv.includes("--help")) {
  console.error("node scripts/outside-agents.mjs --ref bus:cursor --name Cursor --origin bus --reach bus:cursor [--note text] [--post]");
  process.exit(process.argv.includes("--help") ? 0 : 1);
}
const body = outsideAgentBody({
  v: 1, kind: "introduce", externalRef, displayName, origin, reach: arg("--reach"), note: arg("--note")
});
if (!process.argv.includes("--post")) {
  process.stdout.write(body);
} else {
  const { RoomAgentClient } = await import("../client/room-agent.mjs");
  const { agentConnectionFromEnvironment } = await import("../client/agent-connection.mjs");
  const result = await new RoomAgentClient(agentConnectionFromEnvironment()).recordOutsideAgent({
    externalRef, displayName, origin, reach: arg("--reach"), note: arg("--note")
  });
  process.stdout.write(JSON.stringify(result));
}
