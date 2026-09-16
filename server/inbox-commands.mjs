// Inbox command syntax for agents (A023). Pure parser: command text becomes a
// structured intent. No execution, no store, no network — execution slices
// consume these intents later. Anything that is not a command returns null;
// a malformed command is a contract error, never a guess.
class InboxCommandError extends Error { constructor(code, message) { super(message); this.name = "InboxCommandError"; this.code = code; } }
const fail = (code, message) => { throw new InboxCommandError(code, message); };
const requireCommand = (condition, code = "invalid_inbox_command", message = "malformed inbox command") => { if (!condition) fail(code, message); };

const targetId = value => { requireCommand(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), "invalid_inbox_command", "command target must be a message or thread id"); return value; };
const folderName = value => { requireCommand(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value), "invalid_inbox_command", "folder must be a simple name"); return value; };
const bodyText = value => {
  requireCommand(typeof value === "string" && value.isWellFormed() && value.length > 0 && value.length <= 65536,
    "invalid_inbox_command", "command body must be 1..65536 well-formed characters");
  return value;
};
// Split on whitespace, keeping a quoted tail intact for bodies is the
// caller's job; the parser takes the raw remainder as the body.
const tokenize = text => text.trim().split(/\s+/).filter(Boolean);

// Command handlers: (args, raw) -> intent. Intents are frozen plain data.
const handlers = {
  summarize(args) {
    requireCommand(args.length <= 1, "invalid_inbox_command", "/summarize takes at most one target");
    return Object.freeze({ command: "summarize", target: args.length === 1 ? targetId(args[0]) : null });
  },
  "draft-reply"(args, raw) {
    requireCommand(args.length >= 1, "invalid_inbox_command", "/draft-reply needs a target message");
    const target = targetId(args[0]);
    // The body is everything after the target, whitespace-preserved.
    const body = raw.slice(raw.indexOf(args[0]) + args[0].length).trim();
    return Object.freeze({ command: "draft_reply", target, body: bodyText(body) });
  },
  file(args) {
    requireCommand(args.length >= 1 && args.length <= 2, "invalid_inbox_command", "/file needs a target and optional folder");
    return Object.freeze({ command: "file", target: targetId(args[0]), folder: args.length === 2 ? folderName(args[1]) : null });
  },
  help(args) {
    requireCommand(args.length === 0, "invalid_inbox_command", "/help takes no arguments");
    return Object.freeze({ command: "help", target: null });
  },
};
const catalog = Object.freeze([
  Object.freeze({ name: "summarize", usage: "/summarize [message-id|thread-id]", description: "summarize one message or thread; no target summarizes the current thread" }),
  Object.freeze({ name: "draft-reply", usage: "/draft-reply <message-id> <text>", description: "create a reply draft for the owner to approve; never sends" }),
  Object.freeze({ name: "file", usage: "/file <message-id> [folder]", description: "file a message into a folder" }),
  Object.freeze({ name: "help", usage: "/help", description: "list the inbox commands" }),
]);
export const listInboxCommands = () => catalog;
export const isInboxCommand = text => typeof text === "string" && /^\/[a-z][a-z-]*(\s|$)/.test(text.trimStart());
// Parse one line of agent input. Returns the intent, or null when the text is
// not a command at all. Unknown or malformed commands throw InboxCommandError.
export function parseInboxCommand(text) {
  requireCommand(typeof text === "string" && text.isWellFormed() && text.length <= 65536, "invalid_inbox_command", "command input must be well-formed text");
  const line = text.trim();
  if (!line.startsWith("/")) return null;
  const match = /^\/([a-z][a-z-]*)(\s+(.*))?$/s.exec(line);
  requireCommand(match !== null, "invalid_inbox_command", "command must be /name followed by arguments");
  const handler = handlers[match[1]];
  if (!handler) fail("unknown_inbox_command", `unknown inbox command: /${match[1]}`);
  return handler(tokenize(match[3] ?? ""), match[3] ?? "");
}
export { InboxCommandError };
