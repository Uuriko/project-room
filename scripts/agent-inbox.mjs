import { RoomAgentClient, validWorkSearchQuery } from "../client/room-agent.mjs";
import { packetMarkdown } from "../src/work-packet.js";
import { validId } from "../src/events.js";
import { agentConnectionFromEnvironment, readConnectionInput, saveAgentConnection, connectionDiagnostic, ConnectionError } from "../client/agent-connection.mjs";

const [action = "orient", checkpoint, ...extra] = process.argv.slice(2);
if (action === "reply") {
  const { replyMain } = await import("./agent-replies.mjs");
  await replyMain(process.argv.slice(3));
} else if (action === "watch") {
  const { watchMain } = await import("./agent-watch.mjs");
  await watchMain(process.argv.slice(3));
} else if (action === "--help") {
  console.log(`Agent connection (Node 24.19+):
  node scripts/agent-inbox.mjs connect NEW_PRIVATE_DIRECTORY
  pbpaste | node scripts/agent-inbox.mjs import NEW_PRIVATE_DIRECTORY
  node scripts/agent-inbox.mjs check
  node scripts/agent-inbox.mjs search "phrase" [--needs-me]
  node scripts/agent-inbox.mjs work WORK_ID [--include-source] [--include-offers]
  node scripts/agent-inbox.mjs result WORK_ID [--completion ID | --draft MESSAGE_ID]
  node scripts/agent-inbox.mjs discussion WORK_ID [--since N | --cursor CURSOR] [--limit N]
  node scripts/agent-inbox.mjs [orient|next|brief|changes CHECKPOINT|packet WORK_ID]
Assignment watching: node scripts/agent-inbox.mjs watch --help
Reply requests: node scripts/agent-inbox.mjs reply --help

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
default. Search returns up to 25 compact current-work matches; --needs-me narrows
them to handoffs addressed to you. Refine the query if truncated. No messages or
external evidence files are searched. Next shows current work handoffs addressed to you; it does not start work
or include reply requests. Orient reads broader private room context. A read does not narrow the key's
permissions. See docs/AGENT-CONNECTION.md for scope, recovery and current limits.`);
} else {
  try {
    let discussionOptions, resultOptions = {};
    if (action === "result" && extra.length) {
      if (extra.length !== 2 || !["--completion", "--draft"].includes(extra[0]) || !validId(extra[1])) throw new ConnectionError("usage_error");
      resultOptions = { [extra[0] === "--completion" ? "completionEventId" : "draftMessageId"]: extra[1] };
    }
    if (action === "discussion") {
      discussionOptions = {};
      for (let index = 0; index < extra.length; index += 2) {
        const name = extra[index]?.slice(2), value = extra[index + 1];
        if (!["--since", "--cursor", "--limit"].includes(extra[index]) || value === undefined || Object.hasOwn(discussionOptions, name)
          || (name !== "cursor" && !/^(0|[1-9]\d*)$/.test(value))) throw new ConnectionError("usage_error");
        discussionOptions[name] = name === "cursor" ? value : Number(value);
      }
      const { since, cursor, limit } = discussionOptions;
      if ((since !== undefined && !Number.isSafeInteger(since))
        || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50))
        || (cursor !== undefined && (since !== undefined || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) throw new ConnectionError("usage_error");
    }
    if (!["connect", "import", "check", "orient", "next", "search", "brief", "changes", "packet", "work", "discussion", "result"].includes(action)
      || (["connect", "import"].includes(action) && (!checkpoint || checkpoint.startsWith("--") || process.env.ROOM_AGENT_CONFIG !== undefined))
      || (action === "import" && ["ROOM_AGENT_ORIGIN", "ROOM_AGENT_ROOM", "ROOM_AGENT_MEMBER", "ROOM_AGENT_TOKEN"].some(name => process.env[name] !== undefined))
      || (["packet", "work", "discussion", "result"].includes(action) && !validId(checkpoint))
      || (action === "search" && !validWorkSearchQuery(checkpoint))
      || (["discussion", "result"].includes(action) ? false : action === "work" ? new Set(extra).size !== extra.length || extra.some(flag => !["--include-source", "--include-offers"].includes(flag))
        : action === "search" ? extra.length > 1 || (extra.length === 1 && extra[0] !== "--needs-me")
        : extra.length || (["check", "orient", "next", "brief"].includes(action) && checkpoint !== undefined))
      || (action === "changes" && (!/^\d+$/.test(checkpoint ?? "") || !Number.isSafeInteger(Number(checkpoint))))) throw new ConnectionError("usage_error");
    const config = action === "import" ? await readConnectionInput() : agentConnectionFromEnvironment(), client = new RoomAgentClient(config);
    let result;
    if (["connect", "import", "check"].includes(action)) {
      result = await client.checkConnection();
      if (["connect", "import"].includes(action)) {
        saveAgentConnection(checkpoint, { version: 1, ...config });
        result = { ...result, configurationSaved: true };
      }
    } else result = action === "discussion" ? await client.workDiscussion(checkpoint, discussionOptions)
      : action === "result" ? await client.workResult(checkpoint, resultOptions)
      : action === "work" ? await client.workContext(checkpoint, { includeSource: extra.includes("--include-source"), includeOffers: extra.includes("--include-offers") })
      : action === "next" ? await client.orient({ focus: "needs_me" })
      : action === "search" ? await client.orient({ query: checkpoint, focus: extra[0] === "--needs-me" ? "needs_me" : "all" })
      : action === "packet" ? packetMarkdown(await client.workPacket(checkpoint)) : action === "orient" ? await client.orient() : action === "brief" ? await client.returnBrief() : await client.changes(Number(checkpoint));
    console.log(action === "packet" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    // Fixed diagnostic text avoids printing transport internals or environment secrets.
    console.error(JSON.stringify(connectionDiagnostic(error)));
    process.exitCode = 1;
  }
}
