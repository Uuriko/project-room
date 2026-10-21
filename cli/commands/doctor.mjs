import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECRET_ENV, SERVER_NAME } from "../../server/connect-snippets.mjs";
import { checkAccess, checkReady, loadSecret, mcpRequest } from "../auth.mjs";
import { BEGIN } from "../files.mjs";
import { codexHomeOf, homeOf, loadConnection, readProject } from "../paths.mjs";
import { commandOnPath } from "../which.mjs";

export function nodeSatisfies(version, minimum = "24.19.0") {
  const parse = value => String(value).replace(/^v/, "").split(".").map(part => Number(part));
  const [major, minor, patch] = parse(version);
  const [needMajor, needMinor, needPatch] = parse(minimum);
  if (major !== needMajor) return major > needMajor;
  if (minor !== needMinor) return minor > needMinor;
  return patch >= needPatch;
}

function clinePath(home, platform) {
  if (platform === "darwin") return join(home, "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
  if (platform === "win32") return join(home, "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
  return join(home, ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json");
}

function containsServer(path) {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(`"${SERVER_NAME}"`) || readFileSync(path, "utf8").includes(BEGIN);
}

export function toolConfigReady({ tool, via, project, home, platform, env }) {
  if (!tool || tool === "generic") return true;
  if (tool === "claude-code" && via === "command") return Boolean(commandOnPath("claude", env));
  if (tool === "claude-code") return containsServer(join(project, ".mcp.json"));
  if (tool === "codex") return containsServer(join(codexHomeOf({ ...env, HOME: home }), "config.toml"));
  if (tool === "cursor") return containsServer(join(project, ".cursor", "mcp.json"));
  if (tool === "cline") return containsServer(clinePath(home, platform));
  if (tool === "vscode") return containsServer(join(project, ".vscode", "mcp.json"));
  if (tool === "aider") return containsServer(join(project, ".aider.conf.yml")) && existsSync(join(project, ".project-room", "CONVENTIONS.md"));
  return false;
}

export async function doctorCommand(argv, { env = process.env, cwd = process.cwd(), fetchImpl, platform = process.platform, out = console.log } = {}) {
  if (argv.length) throw new Error("Use room doctor with no arguments.");
  if (!nodeSatisfies(process.version)) {
    out("Install Node.js 24.19 or newer, then run room doctor again.");
    return 1;
  }
  let loaded;
  try { loaded = loadConnection({ project: cwd, env }); }
  catch (error) {
    out(error.message);
    return 1;
  }
  const ready = await checkReady({ origin: loaded.config.origin, fetchImpl });
  if (!ready.ok) {
    out("The room service did not answer /api/ready. Check the service address and try again.");
    return 2;
  }
  const secret = await loadSecret(loaded.name, loaded.config.token, env);
  const access = await checkAccess({ origin: loaded.config.origin, secret, fetchImpl });
  if (access.down) {
    out("The room service did not answer room_check_access. Check the service address and try again.");
    return 2;
  }
  if (!access.ok) {
    out("room login --room <invite-or-room-url> --accept");
    return 1;
  }
  const project = readProject(cwd);
  const tool = project?.tool;
  if (!tool) {
    out("room setup <claude-code|codex|cursor|cline|vscode|aider|generic>");
    return 1;
  }
  if (!toolConfigReady({ tool, via: project.via, project: cwd, home: homeOf(env), platform, env })) {
    out("room setup " + tool);
    return 1;
  }
  const origin = loaded.config.origin, roomId = loaded.config.roomId;
  // Identity: the credential must belong to the saved room.
  const rooms = Array.isArray(access.check?.rooms) ? access.check.rooms : null;
  const membership = rooms && roomId ? rooms.find(row => row.roomId === roomId) : null;
  if (rooms && roomId && !membership) {
    out("This agent identity is not a member of room " + roomId + ". Fix: room login --room <invite-for-that-room> --accept");
    return 1;
  }
  // Tools: the hosted catalog must offer what an agent needs to talk and read.
  const listed = await mcpRequest({ origin, secret, method: "tools/list", fetchImpl });
  const names = new Set((listed?.tools ?? []).map(tool => tool?.name));
  const missing = DOCTOR_REQUIRED_TOOLS.filter(name => !names.has(name));
  if (!listed || missing.length) {
    out((listed ? "The room's tool list is missing " + missing.join(", ") + "." : "The room did not answer tools/list.")
      + " Fix: room setup " + tool + " to refresh the config, then restart " + tool + ".");
    return 1;
  }
  // Wake path: can the room wake this agent? Advisory: a pull-only agent still works.
  const card = membership?.memberId
    ? await mcpRequest({ origin, secret, method: "tools/call", params: { name: "room_member_card", arguments: { roomId, memberId: membership.memberId } }, fetchImpl })
    : null;
  const reach = card?.structuredContent?.reach ?? card?.structuredContent?.card?.reach ?? null;
  const wakeLine = wakePathAdvice(reach);
  out("Node, the saved connection, /api/ready, room_check_access, identity, tools, and the " + tool + " config check out. " + SECRET_ENV + " stays out of the tool config.");
  if (wakeLine) out(wakeLine);
  return 0;
}

export const DOCTOR_REQUIRED_TOOLS = Object.freeze(["room_check_access", "room_post_message"]);

// null when the room can wake the agent; otherwise one line with the fix.
export function wakePathAdvice(reach) {
  if (reach?.wakeMode === "wakeable") return null;
  if (reach?.wakeMode === "pull-only" && reach.lastPollAt) return null;
  return "Wake path: the room has not heard from this agent's listener, so @mentions will wait until it next checks in. Fix: start your agent with the room listener (room setup again if unsure), then run room doctor.";
}
