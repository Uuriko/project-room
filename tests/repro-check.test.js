import test from "node:test";
import assert from "node:assert/strict";
import { REPRO_QUESTION, needsRepro } from "../server/repro-check.mjs";

const hold = [
  { title: "Fix the bug" },
  { title: "Make the room faster", description: "It feels slow when many people talk." },
  { title: "Ship the copy", acceptanceCriteria: [], steps: [], definitionOfDone: "Looks better" },
  { title: "Login is weird", repro: "   ", acceptanceCheck: "", issue: "" },
  { title: "Flaky sometimes", description: "Something fails sometimes", note: "not a specific issue" },
];

const pass = [
  { title: "Reject bad passwords", acceptanceCriteria: ["A wrong password shows the error and does not sign in"] },
  { title: "Send crashes", steps: ["Open the room", "Send a message that contains an emoji"] },
  { title: "Lifecycle flake", failingTest: "tests/room-lifecycle.test.js" },
  { title: "Duplicate wake", issue: "https://github.com/Uuriko/project-room/issues/1160" },
  { title: "Handoff check", acceptanceTest: { checks: [{ kind: "manual_review", description: "CI is green" }] } },
];

test("needsRepro holds five tasks with no check, steps, or failing link and passes five that have one", () => {
  assert.equal(hold.length, 5);
  assert.equal(pass.length, 5);
  for (const task of hold) assert.equal(needsRepro(task), true, JSON.stringify(task));
  for (const task of pass) assert.equal(needsRepro(task), false, JSON.stringify(task));
});

test("needsRepro ignores blank fields and prose, and still sees a buried test or issue link", () => {
  assert.equal(needsRepro(null), true);
  assert.equal(needsRepro("fix it"), true);
  assert.equal(needsRepro({ title: "See #12" }), true);
  assert.equal(needsRepro({ issue: "login is broken" }), true);
  assert.equal(needsRepro({ acceptanceCriteria: ["  "], steps: [{ action: "  " }] }), true);
  assert.equal(needsRepro({ repro: "1. Open the room\n2. Send a message" }), false);
  assert.equal(needsRepro({ issue: "1160" }), false);
  assert.equal(needsRepro({ issue: "#1160" }), false);
  assert.equal(needsRepro({ title: "Broken", description: "Fails in tests/wake-queue.test.js" }), false);
  assert.equal(needsRepro({ description: "See https://github.com/Uuriko/project-room/issues/266 today" }), false);
});

test("the repro question is one question", () => {
  assert.equal(REPRO_QUESTION.includes("?"), true);
  assert.equal(REPRO_QUESTION.indexOf("?"), REPRO_QUESTION.length - 1);
  assert.equal(/\p{Extended_Pictographic}/u.test(REPRO_QUESTION), false);
});
