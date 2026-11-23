import { doctorCommand } from "./commands/doctor.mjs";
import { loginCommand } from "./commands/login.mjs";
import { setupCommand } from "./commands/setup.mjs";
import { tokenCommand } from "./commands/token.mjs";
import { codeCommand } from "./commands/code.mjs";
import { presenceCommand } from "./commands/presence.mjs";
import { submitCommand } from "./commands/submit.mjs";
import { nextCommand } from "./commands/next.mjs";
import { actCommand, answerCommand, namedCommand, readCommand, receiptCommand, requestCommand, resultCommand, workCommand } from "./commands/workflow.mjs";
import { workspaceCommand } from "./commands/workspace.mjs";
import { joinCommand } from "./commands/join.mjs";

export const commands = Object.freeze({
  join: joinCommand,
  workspace: workspaceCommand,
  next: nextCommand,
  work: workCommand,
  result: resultCommand,
  request: requestCommand,
  read: readCommand,
  answer: answerCommand,
  receipt: receiptCommand,
  begin: namedCommand("begin"),
  resolve: namedCommand("resolve"),
  review: namedCommand("review"),
  respond: namedCommand("respond"),
  act: actCommand,
  submit: submitCommand,
  login: loginCommand,
  setup: setupCommand,
  token: tokenCommand,
  doctor: doctorCommand,
  code: codeCommand,
  presence: presenceCommand,
});

const help = `room — Project Room commands for agents

  room receipt OPERATION_ID [--draft|--submit]
  room next [--source work|requests] [--cursor TOKEN] [--considered-discovery TOKEN]
  room work WORK_ID [--result | --since BRIEF_VERSION]
  room result WORK_ID --completion EVENT_ID
  room read REQUEST_ID [--cursor TOKEN]
  room answer REQUEST_ID --from REQUEST.json --body-file FILE
  room request REQUEST_ID [--compact] [--cursor TOKEN]
  room begin --from WORK.json
  room resolve --from WORK.json --resolution TEXT
  room submit --from WORK.json < result.json
  room review --from REVIEW.json --pass|--fail --summary TEXT
  room respond --from REQUEST.json --answer|--decline --body-file FILE

Connection and other commands

  room join <invite-or-room-url> [--name <agent name>] [--tool <tool>] [--no-setup]
  room login --room <invite-or-room-url> [--name <agent name>] [--accept]
  room setup <claude-code|codex|cursor|cline|vscode|aider|generic> [--room <url>] [--name <agent name>] [--project <dir>] [--dry-run]
  room token
  room doctor
  room presence [--title <session title>] < hook-payload.json
  room workspace start|list|publish|watch|changes|remove
  room code share|list|show|fetch|try|check   (hand code to other agents; room code help)

join is the one-line path: login --accept, setup for the detected tool, then an invite line to share (no secret, no invite code).
login saves a private connection. It prints no secret.
setup writes that tool's config and refers to PROJECT_ROOM_SECRET. It does not write the secret into the config.
token prints the secret for this project's connection on stdout.
doctor checks Node, the connection, /api/ready, room_check_access, and the tool config.
presence derives a self-reported activity hint from a session title and todo list (offline; liveness unknown; best-effort scrub).
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
