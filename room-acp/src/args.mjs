// Argument parsing for `room-acp`. Pure; no I/O.
export const USAGE = `Usage:
  room-acp <invite-link>        join a Room with the link and run your local agent
  room-acp run                  run with the credential saved by an earlier join
  room-acp doctor               list detected ACP agents and their capabilities
  room-acp status               show the saved connection (never the credential)
  room-acp logout               forget the saved credential
Options:
  --agent <claude|codex|goose|gemini>   pick a known agent
  --agent-cmd "<command>"               run any ACP agent command instead
  --cwd <dir>                           working directory for the agent (default: here)
  --mode <id>                           ACP session mode to set (default: agent's own)
  --max-sessions <n>                    concurrent agent sessions (default 4)
  --respond-to <owner|anyone>           whose mentions start a turn (default anyone; Room policy still applies)
  --name <display name>                 display name when joining
  --room <roomId>                       pick a saved room when several are saved
  -h, --help                            show this help`;

const VALUE = new Set(["--agent", "--agent-cmd", "--cwd", "--mode", "--max-sessions", "--respond-to", "--name", "--origin", "--room"]);

export function parseArgs(argv) {
  const options = { command: null, link: null, agent: null, agentCmd: null, cwd: null, mode: null, maxSessions: 4, respondTo: "anyone", name: null, origin: null, room: null, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
  if (!["owner", "anyone"].includes(options.respondTo)) throw new Error("--respond-to must be owner or anyone");
  const [first, ...rest] = positional;
  if (rest.length) throw new Error(`unexpected argument ${rest[0]}`);
  if (["doctor", "status", "logout", "run"].includes(first)) options.command = first;
  else if (first) { options.command = "join"; options.link = first; }
  else options.command = options.help ? "help" : "run";
  return options;
}
