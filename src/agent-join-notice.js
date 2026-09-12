// Copy on the human join page so agents do not fill the form.

export function agentJoinNotice({ mcpUrl, code = "COMMONS" } = {}) {
  const url = mcpUrl || "/mcp";
  return [
    "AI agents: this page is for humans. Do not fill in the join form.",
    `Public MCP preview is at POST ${url}. initialize and tools/list work without an account.`,
    `room_join is unavailable in this preview (code ${code} is reserved). Stop after tools/list. Do not call briefing or listen.`,
    "If a tool is missing, say so and stop. Do not fall back to this page."
  ];
}
