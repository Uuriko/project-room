import { connectRoom } from "../client/agent-setup.mjs";
import { pathToFileURL } from "node:url";

// Usage mistakes throw UsageError: same messages as before (the
// agent-inbox.mjs join path reports them inside its JSON envelope), while a
// direct run of this script maps them to stderr usage + exit 2.
class UsageError extends Error {}

export function usage() {
  return [
    "usage: node scripts/connect-room.mjs INVITE_OR_ROOM_URL PRIVATE_DIRECTORY [--name NAME] [--accept] [--identity-from SAVED_CONNECTION]",
    "   (or: node scripts/agent-inbox.mjs join INVITE_OR_ROOM_URL PRIVATE_DIRECTORY [--name NAME] [--accept] [--identity-from SAVED_CONNECTION])",
    "",
    "An invite code alone also needs ROOM_AGENT_ORIGIN. Preview first; --accept accepts the disclosed grant. Repeat the same command and private directory to resume. Existing identity connections can be imported with --identity-from. Secrets are stored privately, never printed. A bare service URL registers/reuses identity and lists rooms; a room URL requests admission if needed. Connected verifies access and reads, not a running host.",
  ].join("\n");
}

export async function connectMain(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(usage());
    return;
  }
  const [target, directory, ...flags] = argv;
  const options = { target, directory, origin: process.env.ROOM_AGENT_ORIGIN };
  const seen = new Set();
  if (!target || !directory) throw new UsageError("Use join --help for the connection command");
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new UsageError("Duplicate connection option"); seen.add(flag);
    if (flag === "--accept") options.accept = true;
    else if (["--name", "--identity-from"].includes(flag) && flags[i + 1] && !flags[i + 1].startsWith("--"))
      options[flag === "--name" ? "name" : "identityFrom"] = flags[++i];
    else throw new UsageError("Unknown connection option; use join --help");
  }
  console.log(JSON.stringify(await connectRoom(options)));
}

const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    await connectMain(process.argv.slice(2));
  } catch (error) {
    // A typo'd flag must never fall through to a live connection attempt:
    // usage mistakes are usage errors (exit 2); runtime failures exit 1.
    if (error instanceof UsageError) {
      console.error(usage());
      console.error(`\nconnect-room: ${error.message}`);
      process.exit(2);
    }
    console.error(`connect-room: ${error.message}`);
    process.exit(1);
  }
}
