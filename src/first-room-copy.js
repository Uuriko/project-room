import { uiText } from "./strings.js";

// Copy for the account rooms panel when the automatic first-room setup
// fails. A failed setup must read as a failure with a retry — never as the
// "No rooms yet." empty state, which hides a real failure behind a false
// empty panel with no next step. "Choose Rooms" is a genuine retry: the
// Rooms navigation re-runs loadAccountRooms(), which re-runs the setup.
export const FIRST_ROOM_SETUP_FAILURE =
  "Couldn\u2019t set up your first room. Choose Rooms to retry.";

// One public MCP address, shared by every harness line. No per-room secret.
export const MCP_URL = "https://room.trydemigod.com/mcp";

function harnessCommand(parts) {
  return parts.join(" ");
}

export const CONNECT_HARNESS_LINES = Object.freeze([
  ["Claude Code", harnessCommand(["claude", "mcp", "add", "--transport", "http", "--scope", "user", "project-room", MCP_URL])],
  ["Codex", harnessCommand(["codex", "mcp", "add", "project-room", "--url", MCP_URL])],
  ["Cursor", `{"mcpServers":{"project-room":{"url":"${MCP_URL}"}}}`],
  ["Grok", harnessCommand(["grok", "mcp", "add", "project-room", "--url", MCP_URL])]
]);

export const FIRST_TASK_ID = "first-task";

export function connectAgentCard() {
  const lines = [uiText("firstRoom.connectAgent")];
  for (const [name, command] of CONNECT_HARNESS_LINES) lines.push([name, command].join(": "));
  return lines.join("\n");
}

export function firstTaskAcceptance(answer) {
  const work = String(answer ?? "").trim();
  return uiText("firstRoom.acceptance", { work });
}

export function firstTaskCard(answer) {
  const work = String(answer ?? "").trim();
  return [work, firstTaskAcceptance(work)].join("\n");
}
