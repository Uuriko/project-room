// room join: the one-line, agent-first join (reason-take-4).
// One sentence pasted into any agent ("Join my Project Room: run room join <url> and follow what it prints")
// connects that agent, wires its tool config, and ends by printing an invite line it can pass on.
// Nothing printed here carries the identity secret, an invite code, or a share token: the invite
// line points at the room's public page, never at the invitation that was used to get in.
import { loginCommand } from "./login.mjs";
import { setupCommand, SETUP_TOOLS, preflightSetup } from "./setup.mjs";

const TOOL_HINTS = Object.freeze([
  ["CLAUDECODE", "claude-code"],
  ["CODEX_HOME", "codex"],
  ["CODEX_SANDBOX", "codex"],
  ["CURSOR_AGENT", "cursor"],
  ["CURSOR_TRACE_ID", "cursor"],
  ["GEMINI_CLI", "gemini"],
  ["GROK_HOME", "grok"],
  ["OPENCODE", "opencode"],
  ["COPILOT_CLI", "copilot"],
]);

export function detectTool(env = process.env) {
  for (const [key, tool] of TOOL_HINTS) if (env[key] && SETUP_TOOLS.includes(tool)) return tool;
  return "generic";
}

export function roomPageUrl(origin, roomId) {
  const base = new URL(origin);
  return `${base.origin}/r/${encodeURIComponent(roomId)}`;
}

export function oneLinePrompt(url) {
  return `Join my Project Room: run \`npx -y github:Uuriko/project-room join ${url}\` and follow what it prints.`;
}

const SECRETISH = /pri_[A-Za-z0-9_-]{8,}|RM-[A-Z0-9]{6,}|[?#&](?:code|token|invite|share|t)=[^\s&#]+/g;
export function scrub(text) {
  return String(text).replace(SECRETISH, "[redacted]");
}

// Display text from the service is data: strip control characters and bound it.
const clean = value => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 120);
export function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// choose_room: list the caller's rooms and the opted-in public directory as choices.
// Never auto-select (even one room) and never run setup. Links use the same-origin
// #room/<id> route: a listing is not a public page opt-in, so not /r/<id>.
export function chooseRoomLines(result, target, { name, flags = {} } = {}) {
  let origin;
  try { origin = new URL(target).origin; } catch { origin = null; }
  const link = roomId => origin ? `${origin}/#room/${encodeURIComponent(roomId).replace(/%3A/gi, ":")}` : roomId;
  const rerun = roomId => ["room join", shellQuote(link(roomId)), "--name", shellQuote(name),
    ...(flags.tool ? ["--tool", shellQuote(flags.tool)] : []), ...(flags.project ? ["--project", shellQuote(flags.project)] : []),
    ...(flags.setup === false ? ["--no-setup"] : [])].join(" ");
  const seen = new Set();
  const unique = rooms => (Array.isArray(rooms) ? rooms : []).filter(room => {
    if (!ROOM_ID.test(String(room?.roomId ?? "")) || seen.has(room.roomId)) return false;
    seen.add(room.roomId); return true;
  });
  const mine = unique(result.memberships), listed = unique(result.directory?.rooms);
  const more = Boolean(result.directory?.nextCursor), directoryKnown = Array.isArray(result.directory?.rooms);
  const lines = ["Not joined yet (choose_room): pick a room and run join again with its link."];
  // Labels are untrusted text: print them on their own line and the command
  // alone below, so copying the command never copies label text.
  const label = text => `  ${clean(text)}`;
  if (!Array.isArray(result.memberships)) lines.push("Your rooms could not be read; retry login.");
  else if (mine.length) {
    lines.push("Your rooms:");
    for (const room of mine) {
      if (room.archivedAt) { lines.push(label(`${room.title || room.roomId} (archived; no join command)`)); continue; }
      lines.push(label(room.title || room.roomId), `    ${rerun(room.roomId)}`);
    }
  }
  if (!directoryKnown) lines.push("The public room directory is unavailable right now; retry later.");
  else if (listed.length) {
    lines.push("Public rooms — request access:");
    for (const room of listed) lines.push(label(`${room.title || room.roomId}${room.purpose ? ` — ${room.purpose}` : ""}`), `    ${rerun(room.roomId)}`);
  }
  if (more) lines.push("There are more public rooms; see GET /api/public/rooms/directory and follow its nextCursor.");
  else if (Array.isArray(result.memberships) && directoryKnown && !mine.length && !listed.length)
    lines.push("You have no rooms yet and no public rooms are listed. Ask the room owner for an invite or room link.");
  return lines;
}

function parse(argv) {
  const flags = { setup: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-setup") { flags.setup = false; continue; }
    if (arg === "--name" || arg === "--tool" || arg === "--project") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[arg.slice(2)] = value;
      continue;
    }
    rest.push(arg);
  }
  if (rest.length !== 1) throw new Error("Use room join <invite-or-room-url> [--name <agent name>] [--tool <tool>] [--no-setup].");
  if (flags.tool && !SETUP_TOOLS.includes(flags.tool)) throw new Error("Unknown tool. Use one of: " + SETUP_TOOLS.join(", "));
  return { target: rest[0], flags };
}

export async function joinCommand(argv, io = {}) {
  const { env = process.env, out = console.log, login = loginCommand, setup = setupCommand } = io;
  const { target, flags } = parse(argv);
  const name = flags.name ?? "Room agent";
  const tool = flags.tool ?? detectTool(env);
  if (flags.setup) preflightSetup(tool, { env });
  let joined = null;
  const loginArgs = ["--room", target, "--name", name, "--accept"];
  const code = await login(loginArgs, { ...io, out: line => { try { joined = JSON.parse(line); } catch { joined = null; } } });
  if (joined?.status === "choose_room") {
    for (const line of chooseRoomLines(joined, target, { name, flags })) out(scrub(line));
    return 1;
  }
  if (code !== 0 || joined?.status !== "connected") {
    const status = joined?.status ?? "failed";
    out(scrub(`Not joined yet (${status}). ${joined?.next ?? "Check the room URL or ask for a fresh invite."}`));
    return 1;
  }
  out(`Joined room ${joined.roomId} as ${name}.`);
  if (flags.setup) {
    const setupArgs = [tool, "--name", name, ...(flags.project ? ["--project", flags.project] : [])];
    const lines = [];
    let setupCode;
    try { setupCode = await setup(setupArgs, { ...io, out: line => lines.push(String(line)), err: line => lines.push(String(line)) }); }
    catch (error) { lines.push(String(error?.message ?? error)); setupCode = 1; }
    for (const line of lines) out(scrub(line));
    if (setupCode !== 0) out(`Tool setup for ${tool} did not finish; the room connection is saved. Retry with room setup ${tool}.`);
  }
  const url = roomPageUrl(joined.origin, joined.roomId);
  out("Invite line (share this; it holds no secret or invite code):");
  out(oneLinePrompt(url));
  return 0;
}
