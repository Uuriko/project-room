// Argument parsing for `room-acp`. Pure; no I/O.
export const USAGE = `Usage:
  room-acp join [<room-url>]    join a Room and run your local agent; the invite is asked for, never typed here
  room-acp <invite-link>        same, with the invite on the command line (visible to other local users and in shell history)
  room-acp import-credential    save an already-issued scoped key without issuing another
  room-acp import-identity      save a scoped connection for your existing identity
  room-acp run                  run with the credential saved by an earlier join
  room-acp doctor               list detected ACP agents and their capabilities
  room-acp doctor --connection  check that each saved connection still works (no model prompt)
  room-acp mcp-config --mcp <claude|codex>  print how to add the saved Room to that MCP host (no secret in it)
  room-acp status               show the saved connection (never the credential)
  room-acp logout               forget the saved credential
Options:
  --agent <claude|codex|goose|gemini>   pick a known agent
  --agent-cmd "<command>"               run any ACP agent command instead
  --cwd <dir>                           working directory for the agent (default: here)
  --mode <id>                           ACP session mode to set (default: agent's own)
  --receiver-policy <respond|disabled|notify-cloud>  explicit receiver role (default respond)
  --observe-stages                     print metadata-only timing events for run/respond (default off)
  --notify-config <file>                private existing-cloud config; required for notify-cloud
  --no-listen                           join and save the connection only; do not start an agent
  --mcp <claude|codex>                  after joining, set up this MCP host (implies --no-listen)
  --connection                          with doctor: check saved connections instead of ACP adapters
  --max-sessions <n>                    concurrent agent sessions (default 4)
  --respond-to <owner|anyone>           whose mentions start a turn (default anyone; Room policy still applies)
  --permission-approver <member-id|none>  explicitly trust a Room human for host tool approvals (default disabled)
  --name <display name>                 display name when joining
  --room <roomId>                       pick a saved room or exact import destination
  --credential-file <file>              private JSON for an already-issued scoped key
  --expected-identity <identity ID>      exact identity to verify during scoped import
  --origin <https://service>             explicit origin for scoped import
  --identity-from <directory>           existing private CLI connection for import-identity
  -h, --help                            show this help

Giving the invite without putting it on the command line (join):
  type or paste it at the hidden prompt, pipe it in (room-acp join <room-url> < invite.txt),
  or set ROOM_ACP_INVITE for this one command (read once; not passed on to the agent it starts).
  The invite is a single-use bearer secret: treat it like a password.`;

const VALUE = new Set(["--notify-config", "--receiver-policy", "--mcp", "--agent", "--agent-cmd", "--cwd", "--mode", "--max-sessions", "--respond-to", "--name", "--origin", "--room", "--permission-approver", "--identity-from", "--credential-file", "--expected-identity"]);

export function parseArgs(argv) {
  const options = { command: null, link: null, agent: null, agentCmd: null, cwd: null, mode: null, maxSessions: 4, receiverPolicy: "respond", respondTo: "anyone", name: null, origin: null, room: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--observe-stages") { options.observeStages = true; continue; }
    if (arg === "--no-listen") { options.noListen = true; continue; }
    if (arg === "--connection") { options.connection = true; continue; }
    if (arg === "-h" || arg === "--help") { options.help = true; continue; }
    if (VALUE.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      options[key] = value;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    positional.push(arg);
  }
  options.maxSessions = Number(options.maxSessions);
  if (!Number.isInteger(options.maxSessions) || options.maxSessions < 1 || options.maxSessions > 32) throw new Error("--max-sessions must be 1..32");
  if (!["respond", "disabled", "notify-cloud"].includes(options.receiverPolicy)) throw new Error("--receiver-policy must be respond, disabled or notify-cloud");
  if (!["owner", "anyone"].includes(options.respondTo)) throw new Error("--respond-to must be owner or anyone");
  if (options.permissionApprover !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(options.permissionApprover)) throw new Error("--permission-approver must be an exact member ID or none");
  const [first, ...rest] = positional;
  // `join [<room-url>]`: the invite itself is read at a prompt, from stdin or
  // from ROOM_ACP_INVITE, so it never has to appear in argv. A bare
  // `room-acp <invite-link>` still works for existing scripts.
  if (first === "join") { options.command = "join"; options.link = rest.shift() ?? null; }
  if (rest.length) throw new Error(`unexpected argument ${rest[0]}`);
  if (first === "join") { /* handled above */ }
  else if (["doctor", "status", "logout", "run", "import-identity", "import-credential", "mcp-config"].includes(first)) options.command = first;
  else if (first) { options.command = "join"; options.link = first; }
  else options.command = options.help ? "help" : "run";
  if (options.mcp !== undefined && !["claude", "codex"].includes(options.mcp)) throw new Error("--mcp must be claude or codex");
  if (options.noListen && options.command !== "join" && !options.help) throw new Error("--no-listen applies only to joining with an invite link");
  if (options.connection && options.command !== "doctor" && !options.help) throw new Error("--connection applies only to doctor");
  if (options.command === "mcp-config" && options.mcp === undefined && !options.help) throw new Error("mcp-config needs --mcp claude or --mcp codex");
  if (options.mcp !== undefined && !["join", "mcp-config"].includes(options.command) && !options.help) throw new Error("--mcp applies only to joining or mcp-config");
  if (options.receiverPolicy !== "respond" && options.command !== "run" && !options.help)
    throw new Error("--receiver-policy disabled or notify-cloud applies only to run; it does not join, import or change saved access");
  if (!options.help && (options.receiverPolicy === "notify-cloud") !== (typeof options.notifyConfig === "string"))
    throw Error("--notify-config is required only with --receiver-policy notify-cloud");
  if (options.observeStages && !options.help && (options.command !== "run" || options.receiverPolicy !== "respond"))
    throw Error("--observe-stages applies only to run with --receiver-policy respond");
  return options;
}
