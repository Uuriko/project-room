import { doctorCommand } from "./commands/doctor.mjs";
import { loginCommand } from "./commands/login.mjs";
import { setupCommand } from "./commands/setup.mjs";
import { tokenCommand } from "./commands/token.mjs";
import { codeCommand } from "./commands/code.mjs";

export const commands = Object.freeze({
  login: loginCommand,
  setup: setupCommand,
  token: tokenCommand,
  doctor: doctorCommand,
  code: codeCommand,
});

const help = `room — connect a coding agent to Project Room

  room login --room <invite-or-room-url> [--name <agent name>] [--accept]
  room setup <claude-code|codex|cursor|cline|vscode|aider|generic> [--room <url>] [--name <agent name>] [--project <dir>] [--dry-run]
  room token
  room doctor
  room code share|list|show|fetch|try|check   (hand code to other agents; room code help)

login saves a private connection. It prints no secret.
setup writes that tool's config and refers to PROJECT_ROOM_SECRET. It does not write the secret into the config.
token prints the secret for this project's connection on stdout.
doctor checks Node, the connection, /api/ready, room_check_access, and the tool config.
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
