// Connect-your-agent table for docs pages and the room CLI.
// The connect sheet UI and llms.txt import this module; they do not copy it.
// Snippets name the env var. They never contain an identity secret.
import { ROOM_ORIGIN } from "../deploy/agent-discovery.mjs";

export const SECRET_ENV = "PROJECT_ROOM_SECRET";
export const SERVER_NAME = "project-room";
export const HOSTED_MCP_URL = `${ROOM_ORIGIN}/mcp`;

export const WORK_LOOP = Object.freeze([
  "Claim the task on the room Board and name the files you will edit.",
  "Edit those files. Room refuses a second claim on a file someone already holds, and names who holds it.",
  "Post progress on the claim when the work changes.",
  "Close the claim with the pull request link so the room can record the receipt.",
]);

export const AIDER_CONVENTIONS = `# Project Room

This repo is shared by a small team. Each person runs their own coding agents.

Before you edit, claim the task on the room Board and name the files you will touch. Room refuses an overlapping claim and names who holds it.

Post progress on that claim. When you are blocked, ask the human in the room.

When you finish, close the claim with your pull request link.
`;

export function envHeader() {
  return "Bearer ${env:" + SECRET_ENV + "}";
}

export function claudeHeaderValue() {
  return "Bearer ${" + SECRET_ENV + "}";
}

export function cursorInstallLink(url = HOSTED_MCP_URL) {
  const config = { url, headers: { Authorization: envHeader() } };
  const config64 = Buffer.from(JSON.stringify(config)).toString("base64url");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${config64}`;
}

export function vscodeInstallLink(url = HOSTED_MCP_URL) {
  const config = { name: SERVER_NAME, type: "http", url, headers: { Authorization: envHeader() } };
  return "vscode:mcp/install?" + encodeURIComponent(JSON.stringify(config));
}

const page = (id, label, command, snippet) => Object.freeze({
  id,
  label,
  command,
  docsPath: `/docs/agents/${id}`,
  htmlFile: `docs/agents/${id}.html`,
  example: `examples/integrations/${id}/README.md`,
  snippet,
});

export const connectSnippets = Object.freeze([
  page("claude-code", "Claude Code", "room setup claude-code", url => ({
    mcpServers: { [SERVER_NAME]: { type: "http", url, headers: { Authorization: claudeHeaderValue() } } },
  })),
  page("codex", "Codex", "room setup codex", url => (
    `[mcp_servers.${SERVER_NAME}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = ${JSON.stringify(SECRET_ENV)}\n`
  )),
  page("cursor", "Cursor", "room setup cursor", url => ({
    mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: envHeader() } } },
  })),
  page("cline", "Cline", "room setup cline", url => ({
    mcpServers: { [SERVER_NAME]: { type: "streamableHttp", url, headers: { Authorization: envHeader() } } },
  })),
  page("vscode", "VS Code", "room setup vscode", url => ({
    servers: { [SERVER_NAME]: { type: "http", url, headers: { Authorization: envHeader() } } },
  })),
  page("aider", "Aider", "room setup aider", () => (
    "read:\n  - .project-room/CONVENTIONS.md\n"
  )),
  page("openai-agents-sdk", "OpenAI Agents SDK", "room login --room <invite-or-room-url>", url => (
    "from agents.mcp import MCPServerStreamableHttp\n"
    + "import os\n"
    + "room = MCPServerStreamableHttp(\n"
    + "    name=" + JSON.stringify(SERVER_NAME) + ",\n"
    + "    params={\"url\": " + JSON.stringify(url) + ", \"headers\": {\"Authorization\": \"Bearer \" + os.environ[" + JSON.stringify(SECRET_ENV) + "]}},\n"
    + ")\n"
  )),
  page("langgraph", "LangGraph", "room login --room <invite-or-room-url>", url => (
    "from langchain_mcp_adapters.client import MultiServerMCPClient\n"
    + "import os\n"
    + "client = MultiServerMCPClient({\n"
    + "    " + JSON.stringify(SERVER_NAME) + ": {\n"
    + "        \"url\": " + JSON.stringify(url) + ",\n"
    + "        \"transport\": \"streamable_http\",\n"
    + "        \"headers\": {\"Authorization\": \"Bearer \" + os.environ[" + JSON.stringify(SECRET_ENV) + "]},\n"
    + "    }\n"
    + "})\n"
  )),
  page("crewai", "CrewAI", "room login --room <invite-or-room-url>", url => (
    "from crewai.mcp import MCPServerHTTP\n"
    + "import os\n"
    + "server = MCPServerHTTP(\n"
    + "    url=" + JSON.stringify(url) + ",\n"
    + "    headers={\"Authorization\": \"Bearer \" + os.environ[" + JSON.stringify(SECRET_ENV) + "]},\n"
    + "    streamable=True,\n"
    + ")\n"
  )),
]);

export function snippetById(id) {
  return connectSnippets.find(tool => tool.id === id) ?? null;
}

export function installLinkFor(id, url = HOSTED_MCP_URL) {
  if (id === "cursor") return cursorInstallLink(url);
  if (id === "vscode") return vscodeInstallLink(url);
  return null;
}

export function agentDocRoutes() {
  return [
    ["/docs/agents", "docs/agents/index.html"],
    ...connectSnippets.map(tool => [tool.docsPath, tool.htmlFile]),
  ];
}

export function renderedSnippet(tool, url = HOSTED_MCP_URL) {
  const value = tool.snippet(url);
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
}
