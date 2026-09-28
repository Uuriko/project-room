// tests/chat-suggestions.test.js — src/chat-suggestions.js.
// Contract guarded: an "A or B?" question, an explicit "Options:" line or a
// yes/no question under the latest message offers one-tap replies; a request
// that reads like work offers "Make this a task"; the viewer's own message,
// statements, open questions and dismissed messages offer nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { replyChoices, suggestsTask, chatSuggestions, askAgentSuggestion, ASK_AGENT_AFTER_MS } from "../src/chat-suggestions.js";

const msg = (body, extra = {}) => ({ id: "m1", authorId: "claude", body, ...extra });

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

const people = {
  rae: { id: "rae", kind: "human", displayName: "Rae" },
  helper: { id: "helper", kind: "agent", displayName: "Helper", permissions: [] },
  builder: { id: "builder", kind: "agent", displayName: "Builder", permissions: ["accept_work"] },
  gone: { id: "gone", kind: "agent", displayName: "Gone", permissions: ["accept_work"], active: false }
};
const asked = (body, extra = {}) => ({ id: "q1", authorId: "rae", body, createdAt: "2026-09-28T12:00:00.000Z", ...extra });
const later = Date.parse("2026-09-28T12:00:00.000Z") + ASK_AGENT_AFTER_MS;

test("askAgentSuggestion offers a working agent once a person's question waits", () => {
  assert.deepEqual(askAgentSuggestion(asked("Where is the deploy log?"), { members: people, now: later }), { memberId: "builder", name: "Builder" });
  assert.equal(askAgentSuggestion(asked("Where is the deploy log?"), { members: people, now: later - 1 }), null, "not before the wait");
  assert.equal(askAgentSuggestion(asked("Where is the deploy log?"), { members: people, now: later, replyCount: 1 }), null, "a reply answers it");
  assert.equal(askAgentSuggestion(asked("The deploy log is here."), { members: people, now: later }), null, "not a question");
  assert.equal(askAgentSuggestion(asked("@Helper where is the log?"), { members: people, now: later }), null, "an agent is already asked");
  assert.equal(askAgentSuggestion(asked("Where is it?", { authorId: "helper" }), { members: people, now: later }), null, "agents' questions are skipped");
  assert.equal(askAgentSuggestion(asked("Where is it?"), { members: { rae: people.rae, gone: people.gone }, now: later }), null, "no active agent");
  assert.equal(askAgentSuggestion(asked("Where is it?", { createdAt: "bad" }), { members: people, now: later }), null);
});

test("chatSuggestions adds the agent chip only when asked to look", () => {
  const question = asked("Where is the deploy log?");
  assert.equal(chatSuggestions(question, { viewerId: "rae" }), null);
  assert.deepEqual(chatSuggestions(question, { viewerId: "rae", ask: { members: people, now: later } }),
    { messageId: "q1", choices: [], task: false, agent: { memberId: "builder", name: "Builder" } });
  assert.equal(chatSuggestions(question, { viewerId: "rae", ask: { members: people, now: later }, dismissed: new Set(["q1"]) }), null);
});

test("the viewer's own question offers no reply choices (projected messages carry authorId)", () => {
  assert.equal(chatSuggestions({ id: "m2", authorId: "rae", body: "Should we ship?" }, { viewerId: "rae" }), null);
});
