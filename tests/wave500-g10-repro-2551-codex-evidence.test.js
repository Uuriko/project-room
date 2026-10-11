// WAVE-500 guild 10 slice 32/50 — FAIL-FIRST REPROS for PR #2551's area
// (scripts/codex-evidence-summary.mjs, offline Codex evidence inspector).
// TEST-ONLY: each test below FAILS on current main (red first). No fix;
// Dot's lane owns the file (first-claim-wins). Repro of the advisory note
// from the post-merge review of #2551: items.failed/items.declined sticky
// flags are derived from item.status for EVERY item type, not just the
// status-carrying tool types (mcp_tool_call, command_execution, file_change,
// collab_tool_call), and the terminal-conflict comparison honors a status
// field the item contract does not define.
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCodexEvidence } from "../scripts/codex-evidence-summary.mjs";

const usage = { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
const start = { type: "turn.started" };
const done = { type: "turn.completed", usage };
const evidence = (events, overrides = {}) => JSON.stringify({ host: "codex", code: 0, signal: null,
  timedOut: false, outputLimited: false, stdout: events.map(e => JSON.stringify(e)).join("\n"), ...overrides });
const summarize = (events, overrides) => summarizeCodexEvidence(evidence(events, overrides));

// Item types with NO status in the pinned contract (statusTypes covers only
// mcp_tool_call, command_execution, file_change, collab_tool_call).
const nonStatusItem = (type, status) => {
  const base = { id: "x", type, status };
  switch (type) {
    case "agent_message": case "reasoning": return { ...base, text: "t" };
    case "todo_list": return { ...base, items: [{ text: "t", completed: true }] };
    case "error": return { ...base, message: "m" };
    case "web_search": return { ...base, query: "q" };
    default: throw new Error("unexpected type " + type);
  }
};

test("stray status:'failed' on non-status item types must not inflate items.failed", () => {
  for (const type of ["agent_message", "reasoning", "todo_list", "error", "web_search"]) {
    const result = summarize([start, { type: "item.completed", item: nonStatusItem(type, "failed") }, done]);
    assert.equal(result.items.failed, 0, `stray status on ${type} inflated items.failed`);
  }
});

test("stray status:'declined' on non-status item types must not inflate items.declined", () => {
  for (const type of ["agent_message", "reasoning", "web_search"]) {
    const result = summarize([start, { type: "item.completed", item: nonStatusItem(type, "declined") }, done]);
    assert.equal(result.items.declined, 0, `stray status on ${type} inflated items.declined`);
  }
});

test("duplicate terminal differing only in out-of-contract status must not damage completion", () => {
  const result = summarize([start,
    { type: "item.completed", item: { id: "x", type: "agent_message", text: "a" } },
    { type: "item.completed", item: { id: "x", type: "agent_message", text: "a", status: "completed" } },
    done]);
  assert.ok(!result.warnings.includes("item_terminal_conflict"),
    `spurious conflict on ignored field: ${JSON.stringify(result.warnings)}`);
  assert.equal(result.turn.disposition, "completed");
});

test("file_change with empty change.path is rejected like other empty identifiers", () => {
  const result = summarize([start,
    { type: "item.completed", item: { id: "f", type: "file_change",
      changes: [{ path: "", kind: "update" }], status: "completed" } },
    done]);
  assert.equal(result.turn.disposition, "incomplete");
  assert.ok(result.warnings.includes("malformed_record"));
});
