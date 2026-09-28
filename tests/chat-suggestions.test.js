// tests/chat-suggestions.test.js — src/chat-suggestions.js.
// Contract guarded: an "A or B?" question, an explicit "Options:" line or a
// yes/no question under the latest message offers one-tap replies; a request
// that reads like work offers "Make this a task"; the viewer's own message,
// statements, open questions and dismissed messages offer nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { replyChoices, suggestsTask, chatSuggestions } from "../src/chat-suggestions.js";

const msg = (body, extra = {}) => ({ id: "m1", actorId: "claude", body, ...extra });

test("reply choices come from explicit options, or-questions and yes/no questions", () => {
  assert.deepEqual(replyChoices(msg("Sure, I can take it. Want it short or detailed?")), ["Short", "Detailed"]);
  assert.deepEqual(replyChoices(msg("Do you prefer tabs, spaces, or both?")), ["Tabs", "Spaces", "Both"]);
  assert.deepEqual(replyChoices(msg("Here is the plan.\nOptions: Ship now | Wait for review")), ["Ship now", "Wait for review"]);
  assert.deepEqual(replyChoices(msg("Should we ship today?")), ["Yes", "No"]);
});

test("statements, open questions, long clauses and asks to the room offer no replies", () => {
  for (const body of ["thanks!", "What time works?", "I think we should use Postgres or SQLite for this whole thing because it is simpler?", "Can someone draft the README intro by Friday?"]) {
    assert.equal(replyChoices(msg(body)), null, body);
  }
});

test("requests that read like work suggest a task, unless work is already linked", () => {
  assert.equal(suggestsTask(msg("Can someone draft the README intro by Friday?")), true);
  assert.equal(suggestsTask(msg("TODO: rotate the staging key")), true);
  assert.equal(suggestsTask(msg("Please fix the login redirect")), true);
  assert.equal(suggestsTask(msg("Please let me know")), false);
  assert.equal(suggestsTask(msg("Can someone fix this?", { workItemId: "w1" })), false);
  assert.equal(suggestsTask(msg("nice work")), false);
});

test("the viewer's own message gets no replies, dismissal hides everything", () => {
  assert.deepEqual(chatSuggestions(msg("Should we ship?"), { viewerId: "rae" }), { messageId: "m1", choices: ["Yes", "No"], task: false });
  assert.equal(chatSuggestions(msg("Should we ship?"), { viewerId: "claude" }), null);
  assert.deepEqual(chatSuggestions(msg("Please fix the login redirect"), { viewerId: "claude", canCreateWork: true }), { messageId: "m1", choices: [], task: true });
  assert.equal(chatSuggestions(msg("Should we ship?"), { viewerId: "rae", dismissed: new Set(["m1"]) }), null);
  assert.equal(chatSuggestions(msg("Should we ship?", { deletedAt: "x" }), { viewerId: "rae" }), null);
});
