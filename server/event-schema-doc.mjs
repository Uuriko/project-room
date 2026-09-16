// Event schema documentation (G017). A pure documentation generator:
// given an event schema definition, produce a Markdown reference page.
// The module is pure and dependency-free. Frozen outputs; malformed
// inputs throw SchemaError. Docs site wiring is a later slice.
class SchemaError extends Error { constructor(code, message) { super(message); this.name = "SchemaError"; this.code = code; } }
const fail = (code, message) => { throw new SchemaError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_schema", message); };
// Generate a Markdown reference page for an event schema.
// schema: { name, description, fields: [{ name, type, required, description }] }
export function schemaToMarkdown({ schema }) {
  check(schema !== null && typeof schema === "object", "schema must be an object");
  check(typeof schema.name === "string" && schema.name.length > 0, "schema.name must be non-empty");
  check(Array.isArray(schema.fields), "schema.fields must be an array");
  const lines = [];
  lines.push(`# ${schema.name}`);
  lines.push("");
  if (schema.description) lines.push(schema.description, "");
  lines.push("## Fields");
  lines.push("");
  lines.push("| Field | Type | Required | Description |");
  lines.push("|-------|------|----------|-------------|");
  for (const f of schema.fields) {
    check(typeof f.name === "string" && f.name.length > 0, "field name must be non-empty");
    check(typeof f.type === "string" && f.type.length > 0, "field type must be non-empty");
    const required = f.required ? "Yes" : "No";
    const desc = (f.description || "").replace(/\|/g, "\\|");
    lines.push(`| \`${f.name}\` | \`${f.type}\` | ${required} | ${desc} |`);
  }
  lines.push("");
  lines.push("## Example");
  lines.push("");
  lines.push("```json");
  const example = {};
  for (const f of schema.fields) {
    example[f.name] = f.example !== undefined ? f.example : `<${f.type}>`;
  }
  lines.push(JSON.stringify(example, null, 2));
  lines.push("```");
  return lines.join("\n");
}
// The canonical Project Room analytics event schema.
export const ANALYTICS_EVENT_SCHEMA = Object.freeze({
  name: "AnalyticsEvent",
  description: "A single analytics event in the Project Room growth engine.",
  fields: Object.freeze([
    { name: "type", type: "string", required: true,
      description: "Event type: message, reaction, join, leave, work-item, poll",
      example: "message" },
    { name: "roomId", type: "string", required: true,
      description: "The room where the event occurred", example: "room-123" },
    { name: "timestamp", type: "string", required: true,
      description: "ISO 8601 timestamp", example: "2026-09-16T10:00:00Z" },
    { name: "userId", type: "string", required: false,
      description: "The user who triggered the event", example: "user-456" },
    { name: "metadata", type: "object", required: false,
      description: "Additional event-specific data", example: {} },
  ]),
});
export { SchemaError };
