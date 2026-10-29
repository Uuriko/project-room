import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { clean, derivePresence, fromHookPayload, normalizeTodos, presenceChanged } from "../client/auto-presence.mjs";
import { MAX_STDIN, presenceCommand } from "../cli/commands/presence.mjs";

test("Claude Code TodoWrite payload becomes one working line with the active form and progress", () => {
  const payload = { tool_name: "TodoWrite", session_title: "Fix merge gate latency", tool_input: { todos: [
    { content: "Measure slot reads", status: "completed", activeForm: "Measuring slot reads" },
    { content: "Trim slot history", status: "in_progress", activeForm: "Trimming slot history" },
    { content: "Open PR", status: "pending", activeForm: "Opening PR" } ] } };
  assert.deepEqual(derivePresence(fromHookPayload(payload)),
    { kind: "activity_hint", status: "active", liveness: "unknown", line: "Fix merge gate latency · Trimming slot history · 1/3", counts: { done: 1, total: 3 } });
});

test("Codex update_plan steps are understood; first pending step is used when none is active", () => {
  const p = derivePresence(fromHookPayload({ arguments: { plan: [{ step: "Read code", status: "completed" }, { step: "Write tests", status: "pending" }] } }));
  assert.equal(p.line, "Write tests · 1/2");
  assert.equal(p.status, "planned", "pending-only is a plan, not evidence of execution");
});

test("all todos done reads idle; nothing at all is idle with no line", () => {
  assert.deepEqual(derivePresence({ todos: [{ text: "a", done: true }] }), { kind: "activity_hint", status: "done", liveness: "unknown", line: "Done 1/1", counts: { done: 1, total: 1 } });
  assert.deepEqual(derivePresence({}), { kind: "activity_hint", status: "none", liveness: "unknown", line: null, counts: { done: 0, total: 0 } });
  assert.equal(derivePresence({ title: "Ship it", todos: [{ content: "x", status: "done" }] }).line, "Ship it · 1/1");
  const titleOnly = derivePresence({ title: "Old completed session" });
  assert.equal(titleOnly.status, "planned", "a title alone never claims current execution");
  assert.equal(titleOnly.liveness, "unknown");
});

test("secrets, invite codes and local paths never reach presence; long text is clipped", () => {
  const line = derivePresence({ title: "Deploy with pri_" + "A".repeat(43), todos: ["edit /Users/potter/src/app.js and RM-ABCDEF123456 then ghp_abcdefghijklmnop"] }).line;
  assert.doesNotMatch(line, /pri_A|RM-ABC|ghp_|\/Users/);
  assert.match(line, /\[redacted\]/);
  assert.match(line, /\[path\]/);
  assert.ok(clean("x".repeat(500)).length <= 120);
  const more = clean("mail jane.doe@example.com token=syntheticcredential read /opt/private/file.txt ok");
  assert.doesNotMatch(more, /jane\.doe|syntheticcredential|\/opt|private\/file/);
  assert.equal(clean("ratio 1/2 and http://x.dev/a stay"), "ratio 1/2 and http://x.dev/a stay");
  assert.equal(clean("a\n\tb"), "a b");
});

test("normalizeTodos accepts strings and mixed shapes and drops empties", () => {
  assert.deepEqual(normalizeTodos(["a", { title: "b", state: "doing" }, { content: "" }, null]),
    [{ text: "a", state: "pending" }, { text: "b", state: "active" }]);
  assert.deepEqual(normalizeTodos("nope"), []);
});

test("presenceChanged only fires on a real change, so hooks cannot loop the room", () => {
  const a = derivePresence({ title: "t", todos: ["x"] });
  assert.equal(presenceChanged(a, derivePresence({ title: "t", todos: ["x"] })), false);
  assert.equal(presenceChanged(a, derivePresence({ title: "t", todos: [{ content: "x", status: "completed" }] })), true);
  assert.equal(presenceChanged(null, a), true);
});

test("room presence reads a hook payload on stdin and prints one JSON line", async () => {
  const lines = [];
  const stdin = Readable.from([JSON.stringify({ tool_input: { todos: [{ content: "Write docs", status: "in_progress" }] } })]);
  assert.equal(await presenceCommand(["--title", "Docs pass"], { stdin, out: l => lines.push(l) }), 0);
  assert.deepEqual(JSON.parse(lines[0]), { kind: "activity_hint", status: "active", liveness: "unknown", line: "Docs pass · Write docs · 0/1", counts: { done: 0, total: 1 } });
  await assert.rejects(presenceCommand([], { stdin: Readable.from(["{bad"]), out: () => {} }), /JSON hook payload/);
  await assert.rejects(presenceCommand([], { stdin: Readable.from(["x".repeat(MAX_STDIN + 1)]), out: () => {} }), /at most/);
});
