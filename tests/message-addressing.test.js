import test from "node:test";
import assert from "node:assert/strict";
import { resolveMentionTargetsInText } from "../server/mention-lifecycle.mjs";

const members = {
  potter: { displayName: "Potter", kind: "human", accountableHumanId: "potter" },
  dasha: { displayName: "Dasha", kind: "human", accountableHumanId: "dasha" },
  grok: { displayName: "Grok", kind: "agent", accountableHumanId: "potter" },
  codex: { displayName: "Codex", kind: "agent", accountableHumanId: "potter" },
  dcodex: { displayName: "Codex Two", kind: "agent", accountableHumanId: "dasha" },
  jill: { displayName: "Jill", kind: "agent", accountableHumanId: "dasha" },
  gone: { displayName: "Gone", kind: "agent", accountableHumanId: "potter", active: false },
};
const repos = { grok: "Uuriko/project-room", jill: "Uuriko/project-room", codex: "Uuriko/other" };
const resolve = (text, sender = "potter") => resolveMentionTargetsInText(members, {}, text, sender, { repos });

test("person/agent addresses one agent of that person", () => {
  assert.deepEqual(resolve("@Potter/Codex check this", "dasha"), ["codex"]);
  assert.deepEqual(resolve("@dasha/codex two ok"), ["dcodex"]);
  assert.deepEqual(resolve("@Potter/Jill hi"), []);
});

test("bare unique agent name still works", () => {
  assert.deepEqual(resolve("@Grok go"), ["grok"]);
  assert.deepEqual(resolve("@Jill go"), ["jill"]);
});

test("person/* addresses every active agent of that person", () => {
  assert.deepEqual(resolve("@Potter/* standup", "dasha"), ["grok", "codex"]);
  assert.deepEqual(resolve("@Dasha/* standup"), ["dcodex", "jill"]);
});

test("person/* skips the sender", () => {
  assert.deepEqual(resolve("@Potter/* standup", "grok"), ["codex"]);
});

test("repo:<name> addresses agents in that repo by full or short name", () => {
  assert.deepEqual(resolve("@repo:project-room rebase"), ["grok", "jill"]);
  assert.deepEqual(resolve("@repo:Uuriko/project-room rebase", "grok"), ["jill"]);
  assert.deepEqual(resolve("@repo:nothing hi"), []);
});

test("* addresses everyone active except the sender", () => {
  assert.deepEqual(resolve("@* heads up"), ["dasha", "grok", "codex", "dcodex", "jill"]);
});

test("email addresses, silent mentions and squads are unchanged", () => {
  assert.deepEqual(resolve("mail potter@x.com"), []);
  assert.deepEqual(resolve("@_Potter/* quiet"), []);
  assert.deepEqual(resolve("@squad/core hi"), []);
});

test("no repos map means repo addresses reach nobody", () => {
  assert.deepEqual(resolveMentionTargetsInText(members, {}, "@repo:project-room x", "potter"), []);
});
