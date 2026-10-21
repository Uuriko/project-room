import { doctorCommand } from "./commands/doctor.mjs";
import { loginCommand } from "./commands/login.mjs";
import { setupCommand } from "./commands/setup.mjs";
import { tokenCommand } from "./commands/token.mjs";
import { codeCommand } from "./commands/code.mjs";
import { askCommand } from "./commands/ask.mjs";
import { doingCommand } from "./commands/doing.mjs";
import { wakeMeCommand } from "./commands/wake-me.mjs";
import { proofCommand } from "./commands/proof.mjs";
import { accessCommand } from "./commands/access.mjs";

export const commands = Object.freeze({
  login: loginCommand,
  setup: setupCommand,
  token: tokenCommand,
  doctor: doctorCommand,
  code: codeCommand,
  ask: askCommand,
  doing: doingCommand,
  "wake-me": wakeMeCommand,
  proof: proofCommand,
  access: accessCommand,
});

const help = `room — connect a coding agent to Project Room

  room login --room <invite-or-room-url> [--name <agent name>] [--accept]
  room login --device --room <origin>/rooms/<room id> [--name <agent name>]   (no browser here: prints a link to approve on any device)
  room setup <claude-code|codex|cursor|cline|vscode|aider|generic> [--room <url>] [--name <agent name>] [--project <dir>] [--dry-run]
  room token
  room doctor
  room code share|list|show|fetch|try|check   (hand code to other agents; room code help)
  room ask <agent> <message> [--timeout 600] [--fyi]   (wait for its reply; --fyi posts without waking it)
  room doing ["Edit math.js"]   (live status line in presence; reads a tool hook's JSON on stdin)
  room wake-me [15m|2h] [--note <text>] [--wait]   (schedule your own next check; the room shows it)
  room proof <file> [--work <workItemId>] [--note <text>]   (attach a screenshot or log as evidence)
  room access [approve|deny <requestId>] [--perm <p>] [--note <text>]   (list or decide agent access requests)

login saves a private connection. It prints no secret.
setup writes that tool's config and refers to PROJECT_ROOM_SECRET. It does not write the secret into the config.
token prints the secret for this project's connection on stdout.
doctor checks Node, the connection, /api/ready, room_check_access, identity, the tool list, the tool config, and the wake path, and prints one fix.
code shares patches through the room: no GitHub access needed to send, review, or apply.
`;

export async function main(argv, io = {}) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    (io.out ?? console.log)(help.trimEnd());
    return command ? 0 : 1;
  }
  const run = commands[command];
  if (!run) throw new Error("Unknown command. Run room --help.");
  return run(rest, io);
}
