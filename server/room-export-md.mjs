// Room export to Markdown (K014). A pure Markdown exporter: convert a
// room (messages, participants, metadata) into a Markdown document.
// Complements the existing HTML exporter (server/room-export-html.mjs).
// The module is pure and dependency-free. Malformed inputs throw
// ExportError. ZIP bundling is a later slice.
class ExportError extends Error { constructor(code, message) { super(message); this.name = "ExportError"; this.code = code; } }
const fail = (code, message) => { throw new ExportError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_export", message); };
// Escape Markdown special characters in plain text.
function escapeMd(text) {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, "\\$1");
}
// Export a room to Markdown.
// room: { roomId, name, createdAt }
// messages: [{ messageId, authorId, authorName, text, createdAt }]
// participants: [{ userId, displayName }]
export function exportToMarkdown({ room, messages, participants }) {
  check(room !== null && typeof room === "object", "room must be an object");
  check(typeof room.name === "string" && room.name.length > 0, "room.name must be non-empty");
  check(Array.isArray(messages), "messages must be an array");
  check(Array.isArray(participants), "participants must be an array");
  const lines = [];
  lines.push(`# ${escapeMd(room.name)}`);
  lines.push("");
  if (room.createdAt) lines.push(`*Exported from room ${escapeMd(room.roomId || "")} — created ${escapeMd(room.createdAt)}*`);
  lines.push("");
  lines.push("## Participants");
  lines.push("");
  for (const p of participants) {
    check(typeof p.displayName === "string", "participant displayName must be a string");
    lines.push(`- ${escapeMd(p.displayName)}`);
  }
  lines.push("");
  lines.push("## Messages");
  lines.push("");
  for (const m of messages) {
    check(typeof m.text === "string", "message text must be a string");
    const author = escapeMd(m.authorName || m.authorId || "unknown");
    const time = m.createdAt ? ` *(${escapeMd(m.createdAt)})*` : "";
    lines.push(`**${author}**${time}: ${escapeMd(m.text)}`);
    lines.push("");
  }
  return lines.join("\n");
}
export { ExportError };
