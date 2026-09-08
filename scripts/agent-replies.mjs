import { RoomAgentClient } from "../client/room-agent.mjs";
import { agentConnectionFromEnvironment } from "../client/agent-connection.mjs";
import { replyTools, replyRoute, validReplyArguments, replyRefusal } from "../client/reply-actions.mjs";

// One explicit operation using the existing private connection. No watcher,
// credential output, implicit acknowledgement, rerun, rebase or model dispatch.
export async function replyMain(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("node scripts/agent-inbox.mjs reply TOOL < input.json\n" +
      "Supply the tool's JSON arguments on stdin, never credentials. Preserve the exact input and requestId for uncertain writes.\n" +
      replyTools.map(tool => tool.name).join("\n"));
    return;
  }
  try {
    if (argv.length !== 1 || !replyTools.some(tool => tool.name === argv[0])) throw new Error();
    let length = 0; const chunks = [];
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 16384) throw new Error();
      chunks.push(bytes);
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), args = source.trim() ? JSON.parse(source) : {};
    const name = argv[0];
    if (!validReplyArguments(name, args)) throw new Error();
    const config = agentConnectionFromEnvironment();
    if (!config.memberId) throw new Error();
    const client = new RoomAgentClient(config);
    const result = replyRoute(name) ? await client.replyRead(name, args) : await client.replyAction(name, args);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "unconfirmed") process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify(replyRefusal(error))); process.exitCode = 1; }
}
