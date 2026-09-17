// K014: room export to Markdown. Pure exporter tests.
import test from "node:test";
import assert from "node:assert/strict";
import { exportToMarkdown, ExportError } from "../server/room-export-md.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ExportError && error.code === code);

test("exports room to Markdown", () => {
  const md = exportToMarkdown({
    room: { roomId: "r1", name: "Sprint Planning", createdAt: "2026-09-01" },
    messages: [
      { messageId: "m1", authorId: "ada", authorName: "Ada", text: "Hello *world*", createdAt: "10:00" },
      { messageId: "m2", authorId: "bob", authorName: "Bob", text: "Hi!", createdAt: "10:01" },
    ],
    participants: [{ userId: "ada", displayName: "Ada" }, { userId: "bob", displayName: "Bob" }],
  });
  assert.ok(md.includes("# Sprint Planning"));
  assert.ok(md.includes("## Participants"));
  assert.ok(md.includes("- Ada"));
  assert.ok(md.includes("## Messages"));
  assert.ok(md.includes("\\*world\\*")); // escaped
  assert.ok(md.includes("**Ada**"));
});
test("malformed inputs are refused", () => {
  throwsCode(() => exportToMarkdown({ room: { name: "" }, messages: [], participants: [] }),
    "invalid_export");
  throwsCode(() => exportToMarkdown({ room: { name: "x" }, messages: "nope", participants: [] }),
    "invalid_export");
});
