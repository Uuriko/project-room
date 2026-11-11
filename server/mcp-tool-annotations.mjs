// Store-listing annotations for every listed MCP tool (OpenAI Apps / Claude
// connector directory / Cursor review expect title, readOnlyHint and
// destructiveHint on each tool). Existing hints win; gaps are filled from the
// tool name. Read-only tools are never destructive.
const READ = /^(room_|public_work_|bond_|webhook_|heartbeat_|inbox_|wake_)?(read|list|get|check|needs|wait|search|recommend|map|my_review|mcp_snippet|join_packet|kit|door|status|preview)/;
const READ_ANY = /_(read|list|get|status|preview|search|recommend|needs_me|check_access|kits?|packet|prompt|snippet)(_|$)/;
const DESTRUCTIVE = /(^|_)(revoke|discard|delete|remove|clear|unsubscribe|release|cancel|close|leave|reject|decline|archive|disband|kick|ban|purge|supersede|finish|withdraw)(_|$)/;

export function toolTitle(name) {
  return String(name ?? "").replace(/^room_/, "").split(/[_.]+/).filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
}

export function inferReadOnly(name) {
  const n = String(name ?? "");
  return READ.test(n) || READ_ANY.test(n);
}

export function withToolAnnotations(tool) {
  if (!tool || typeof tool !== "object" || typeof tool.name !== "string") return tool;
  const given = tool.annotations ?? {};
  const readOnlyHint = typeof given.readOnlyHint === "boolean" ? given.readOnlyHint : inferReadOnly(tool.name);
  const destructiveHint = readOnlyHint ? false
    : given.destructiveHint === true || DESTRUCTIVE.test(tool.name);
  return { ...tool, annotations: { ...given, title: given.title ?? tool.title ?? toolTitle(tool.name), readOnlyHint, destructiveHint } };
}
