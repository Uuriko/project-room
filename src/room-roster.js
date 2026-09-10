const ACCESS = new Set(["chat", "contribute", "review"]);
const ROUTES = new Set(["packet", "mcp", "direct"]);
const WRITE_FLAGS = new Set(["--write", "--install", "--apply", "--save", "--config", "--config-file"]);

export const ROOM_ROSTER = Object.freeze([
  Object.freeze({
    id: "instinct",
    displayName: "Instinct",
    connectName: "Instinct",
    access: "review",
    route: "packet",
    channel: "iMessage",
    product: "Instinct personal assistant",
    productUrl: "https://instinct.com/",
    contributed: false,
    dialogHint: "Today: Use my AI in the existing iMessage conversation, then Paste AI draft. A Room key is only useful if Instinct can run local tools. No key in Messages.",
    today: "Open a work item → Use my AI → personally send the reviewed packet in the existing Instinct iMessage thread → Paste AI draft. No Room key goes into Messages.",
    later: "If Instinct can run Node 24.19+ or local stdio MCP and reach the approved HTTPS Room, import a private connection and use the same adapter as Grok Build.",
    capabilityQuestion: "Can you run Node 24.19 or newer with a private local configuration, or use a local stdio MCP server? Can your environment reach my approved HTTPS Project Room? Describe your limits and how a user can provide a secret without placing it in chat. Do not read messages, install anything, start work or request credentials yet."
  }),
  Object.freeze({
    id: "muse",
    displayName: "Muse",
    connectName: "Muse",
    access: "chat",
    route: "packet",
    channel: "Muse app or WhatsApp",
    product: "Meta Muse personal AI agent",
    productUrl: "https://muse.ai/",
    contributed: false,
    dialogHint: "Muse has not contributed yet. Today: Use my AI in the Muse app or WhatsApp, then Paste AI draft. No Room key in chat.",
    today: "Open a work item → Use my AI → send the reviewed packet in the Muse app or the existing WhatsApp thread with Muse → Paste AI draft. Muse has not contributed to this Room yet. No Room key goes into chat.",
    later: "Muse Secure VM is an isolated Linux computer with a browser. If it can store a secret outside chat and call the approved HTTPS Room, use the direct Node client there. Public Muse pages did not document MCP, an API, or secret storage. Localhost and Mac paths will not reach that VM.",
    capabilityQuestion: "Can you store a secret outside this chat and make authenticated HTTPS calls to an approved Project Room origin? Can you run Node 24.19+ or a local stdio MCP server on the Muse Secure VM? Describe limits. Do not install anything, start work, or request credentials yet."
  }),
  Object.freeze({
    id: "grok-build",
    displayName: "Grok Build",
    connectName: "Grok Build",
    access: "contribute",
    route: "mcp",
    channel: "this Mac, Grok Build TUI",
    product: "Grok Build local TUI",
    productUrl: "https://docs.x.ai/build/features/mcp-servers",
    contributed: false,
    dialogHint: "After Create access, import the private setup into a new directory, then merge the printed MCP snippet into ~/.grok/config.toml. Do not put the key in a prompt.",
    today: "Owner creates access in the browser, then import the private setup into a new directory and start local stdio MCP with ROOM_AGENT_CONFIG pointing at that directory. First tool call is room_check_access.",
    later: "Same adapter. Do not duplicate a project-room MCP entry. Do not write config until connection.json exists.",
    capabilityQuestion: null
  }),
  Object.freeze({
    id: "grok-bot",
    displayName: "Grok Bot",
    connectName: "Grok Bot",
    access: "contribute",
    route: "direct",
    channel: "Grok Bot computer",
    product: "xAI Grok Bot",
    productUrl: "https://docs.x.ai/grok-bot/computer-and-apps",
    contributed: false,
    dialogHint: "After Create access, import in the Bot’s computer. Bots on the same OS share files and CLI credentials; a separate Room identity does not isolate secrets.",
    today: "Install the Room client in the Bot runtime, import the private setup there, set ROOM_AGENT_CONFIG, then node scripts/agent-inbox.mjs check. Mac localhost does not reach a hosted Bot.",
    later: "Same direct client. Do not reuse Grok Build’s key. Bots share OS secrets even with separate Room names.",
    capabilityQuestion: "Can you run Node 24.19+ in this computer, reach the approved HTTPS Project Room, and read ROOM_AGENT_CONFIG from a private local directory without putting the key in chat? Do not install anything, start work, or request credentials yet."
  })
]);

export function rosterById(id) {
  return ROOM_ROSTER.find(row => row.id === id) ?? null;
}

export function rosterSelection(id) {
  const row = rosterById(id);
  if (!row) return null;
  return { name: row.connectName, access: row.access, hint: row.dialogHint, route: row.route };
}

export function suggestedConfigDir(id) {
  const row = rosterById(id);
  if (!row) return null;
  return `/absolute/private/room-agent-${row.id}`;
}

export function rosterNameTaken(members, name) {
  if (!members || typeof name !== "string") return false;
  const needle = name.trim().toLocaleLowerCase();
  if (!needle) return false;
  return Object.values(members).some(member => member?.kind === "agent" && member.active !== false
    && typeof member.displayName === "string" && member.displayName.trim().toLocaleLowerCase() === needle);
}

export function grokBuildToml({ nodePath, adapterPath, configDir }) {
  for (const [name, value] of [["nodePath", nodePath], ["adapterPath", adapterPath], ["configDir", configDir]]) {
    if (typeof value !== "string" || !value.startsWith("/") || value.includes("\n") || value.includes("\0")) {
      throw new Error(`${name} must be an absolute path`);
    }
  }
  if (configDir === nodePath || configDir === adapterPath) throw new Error("configDir must be a private directory, not the adapter");
  if (/(^|\/)\.grok(\/|$)/.test(configDir) || /config\.toml$/i.test(configDir)) throw new Error("configDir must not be a Grok config path");
  if (/token|secret|password/i.test(configDir)) throw new Error("paths must not look like secrets");
  return [
    "[mcp_servers.project-room]",
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(adapterPath)}]`,
    "",
    "[mcp_servers.project-room.env]",
    `ROOM_AGENT_CONFIG = ${tomlString(configDir)}`,
    ""
  ].join("\n");
}

export function mcpJson({ nodePath, adapterPath, configDir }) {
  grokBuildToml({ nodePath, adapterPath, configDir });
  return JSON.stringify({
    mcpServers: {
      "project-room": {
        command: nodePath,
        args: [adapterPath],
        env: { ROOM_AGENT_CONFIG: configDir }
      }
    }
  }, null, 2) + "\n";
}

export function importCommand(configDir) {
  if (typeof configDir !== "string" || !configDir.startsWith("/") || /[\n\0]/.test(configDir)) throw new Error("configDir must be an absolute path");
  return `pbpaste | node scripts/agent-inbox.mjs import ${shellSingle(configDir)}`;
}

export function roomRosterMain(argv, options = {}) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return helpText();
  for (const arg of args) {
    if (WRITE_FLAGS.has(arg) || /config\.toml$/i.test(arg) || arg === "--write-config") {
      throw new Error("refuses to write host config or connection files; print a snippet and merge it yourself");
    }
  }
  const snippet = takeFlag(args, "--snippet");
  const json = takeFlag(args, "--json");
  if (args.length > 1) throw new Error("usage: room-roster [instinct|muse|grok-build|grok-bot] [--snippet]");
  const selected = args[0] ? rosterById(args[0]) : null;
  if (args[0] && !selected) throw new Error("unknown roster id; use instinct, muse, grok-build, or grok-bot");
  const rows = selected ? [selected] : ROOM_ROSTER;
  for (const row of rows) {
    if (!ACCESS.has(row.access) || !ROUTES.has(row.route)) throw new Error("invalid roster row");
  }
  if (json) return JSON.stringify(rows.map(row => publicRow(row, options)), null, 2) + "\n";
  return rows.map(row => formatRow(row, options, snippet || !selected)).join("\n") + (selected ? "" : footer());
}

function publicRow(row, options) {
  const configDir = suggestedConfigDir(row.id);
  const paths = snippetPaths(options, configDir);
  return {
    id: row.id,
    displayName: row.displayName,
    connectName: row.connectName,
    access: row.access,
    route: row.route,
    channel: row.channel,
    product: row.product,
    productUrl: row.productUrl,
    contributed: row.contributed,
    today: row.today,
    later: row.later,
    capabilityQuestion: row.capabilityQuestion,
    importCommand: importCommand(configDir),
    configDir,
    grokToml: row.route === "mcp" ? grokBuildToml(paths) : null,
    mcpJson: row.route === "mcp" ? JSON.parse(mcpJson(paths)) : null
  };
}

function formatRow(row, options, includeSnippet) {
  const configDir = suggestedConfigDir(row.id);
  const lines = [
    `${row.displayName}`,
    `  Connect-agent name: ${row.connectName}`,
    `  Recommended access: ${accessLabel(row.access)}`,
    `  Route today: ${row.route} via ${row.channel}`,
    `  Product: ${row.product} (${row.productUrl})`,
    `  Contributed to this Room yet: ${row.contributed ? "yes" : "no"}`,
    `  Today: ${row.today}`,
    `  Later: ${row.later}`,
    `  Import after Create access: ${importCommand(configDir)}`,
    `  Then: ROOM_AGENT_CONFIG=${configDir} node scripts/agent-inbox.mjs check`
  ];
  if (row.capabilityQuestion) lines.push(`  Capability question (no key): ${row.capabilityQuestion}`);
  if (includeSnippet && row.route === "mcp") {
    lines.push("  Grok Build MCP snippet (stdout only; merge yourself after import):");
    lines.push(indent(grokBuildToml(snippetPaths(options, configDir))));
  }
  if (includeSnippet && row.route === "direct") {
    lines.push("  Direct client in the Bot runtime:");
    lines.push(`    ROOM_AGENT_CONFIG=${configDir} node scripts/agent-inbox.mjs check`);
    lines.push("    Keep the key out of prompts. Do not reuse Grok Build’s directory.");
  }
  if (includeSnippet && row.route === "packet") {
    lines.push("  Packet route: no key required. Add agent is optional attribution until the host can import.");
  }
  return lines.join("\n") + "\n";
}

function snippetPaths(options, configDir) {
  const checkout = options.checkout;
  const nodePath = options.execPath;
  if (typeof checkout !== "string" || !checkout.startsWith("/")) throw new Error("checkout must be an absolute path");
  if (typeof nodePath !== "string" || !nodePath.startsWith("/")) throw new Error("execPath must be an absolute path");
  const adapterPath = `${checkout.replace(/\/$/, "")}/scripts/agent-mcp.mjs`;
  if (configDir === checkout || configDir.startsWith(`${checkout.replace(/\/$/, "")}/`)) {
    throw new Error("configDir must be outside the checkout");
  }
  return { nodePath, adapterPath, configDir };
}

function accessLabel(access) {
  return { chat: "Read & chat", contribute: "Contribute work", review: "Review work" }[access];
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function helpText() {
  return `Named Project Room assistants: Instinct, Muse, Grok Build, Grok Bot.

Prints Add-agent names, recommended access, and the host route.
Does not enroll agents, issue keys, or write ~/.grok/config.toml.

  node scripts/room-roster.mjs
  node scripts/room-roster.mjs muse
  node scripts/room-roster.mjs grok-build --snippet

Owner signs in as the room owner in the browser (member key or account key),
then People & agents → Add agent. The owner session must be bound to
the owner account. Guest links are not agent credentials. Inbox without
joining a room uses ?account=1.
`;
}

function footer() {
  return `Enrollment is owner-browser: a signed-in owner with a bound account. Guest links are not agent credentials.
Never put a key in a prompt, URL, or repository. Clear the clipboard after each import.
`;
}

function tomlString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function shellSingle(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function indent(text) {
  return text.trimEnd().split("\n").map(line => `    ${line}`).join("\n");
}
