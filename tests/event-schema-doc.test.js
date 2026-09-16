// G017: event schema documentation. Pure generator tests.
import test from "node:test";
import assert from "node:assert/strict";
import { schemaToMarkdown, ANALYTICS_EVENT_SCHEMA, SchemaError } from "../server/event-schema-doc.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SchemaError && error.code === code);

test("generates Markdown reference", () => {
  const md = schemaToMarkdown({ schema: ANALYTICS_EVENT_SCHEMA });
  assert.ok(md.includes("# AnalyticsEvent"));
  assert.ok(md.includes("## Fields"));
  assert.ok(md.includes("| `type` | `string` | Yes |"));
  assert.ok(md.includes("## Example"));
  assert.ok(md.includes('"type": "message"'));
});
test("malformed inputs are refused", () => {
  throwsCode(() => schemaToMarkdown({ schema: { name: "", fields: [] } }), "invalid_schema");
  throwsCode(() => schemaToMarkdown({ schema: { name: "x", fields: "nope" } }), "invalid_schema");
});
