import { connectRoom } from "../client/agent-setup.mjs";

export async function connectMain(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: node scripts/agent-inbox.mjs join INVITE_OR_ROOM_URL PRIVATE_DIRECTORY [--name NAME] [--accept] [--identity-from SAVED_CONNECTION]\nAn invite code alone also needs ROOM_AGENT_ORIGIN. Preview first; --accept accepts the disclosed grant. Repeat the same command and private directory to resume. Existing identity connections can be imported with --identity-from. Secrets are stored privately, never printed. A bare service URL registers/reuses identity and lists rooms; a room URL requests admission if needed. Connected verifies access and reads, not a running host.");
    return;
  }
  const [target, directory, ...flags] = argv;
  const options = { target, directory, origin: process.env.ROOM_AGENT_ORIGIN };
  const seen = new Set();
  if (!target || !directory) throw new Error("Use join --help for the connection command");
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new Error("Duplicate connection option"); seen.add(flag);
    if (flag === "--accept") options.accept = true;
    else if (["--name", "--identity-from"].includes(flag) && flags[i + 1] && !flags[i + 1].startsWith("--"))
      options[flag === "--name" ? "name" : "identityFrom"] = flags[++i];
    else throw new Error("Unknown connection option; use join --help");
  }
  console.log(JSON.stringify(await connectRoom(options)));
}
