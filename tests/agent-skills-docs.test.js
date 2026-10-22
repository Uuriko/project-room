import test from "node:test";
import assert from "node:assert/strict";
import { discoveryDoc } from "../server/agent-discovery.mjs";
import { AGENT_SKILLS_INDEX_PATH, WORK_RECEIPT_EXTENSION_PATH } from "../server/agent-skills-docs.mjs";

test("agent-skills index lists the skill and its room-scoped form", () => {
  const doc = discoveryDoc(AGENT_SKILLS_INDEX_PATH);
  assert.match(doc.type, /^application\/json/);
  const body = JSON.parse(doc.body);
  assert.equal(body.skills[0].name, "work-in-project-room");
  assert.match(body.skills[0].url, /\/SKILL\.md$/);
  assert.match(body.skills[0].roomScopedUrl, /\/rooms\/\{roomId\}\/SKILL\.md$/);
});

test("well-known skill paths serve the canonical SKILL.md", () => {
  const skill = discoveryDoc("/SKILL.md");
  assert.equal(discoveryDoc("/.well-known/agent-skills/connect/SKILL.md"), skill);
  assert.equal(discoveryDoc("/.well-known/agent-skills/work-in-project-room/SKILL.md"), skill);
});

test("room-scoped SKILL.md binds the join step to that room", () => {
  const doc = discoveryDoc("/rooms/qa-room-1/SKILL.md");
  assert.match(doc.type, /^text\/markdown/);
  assert.ok(doc.body.startsWith("---"), "front matter stays first");
  assert.match(doc.body, /bound to room `qa-room-1`/);
  assert.match(doc.body, /"roomId": "qa-room-1"/);
  assert.doesNotMatch(doc.body, /"roomId": "muse-room"/);
});

test("invalid room ids are not served", () => {
  for (const path of ["/rooms/%E0%A4%A/SKILL.md", "/rooms/a%2Fb/SKILL.md", "/rooms/../SKILL.md", `/rooms/${"x".repeat(300)}/SKILL.md`, "/rooms//SKILL.md"]) {
    assert.equal(discoveryDoc(path), null, path);
  }
});

test("the agent card's work-receipt extension URI resolves", () => {
  const doc = discoveryDoc(WORK_RECEIPT_EXTENSION_PATH);
  assert.match(doc.type, /^text\/markdown/);
  assert.match(doc.body, /public-work-receipt\/1/);
  assert.ok(JSON.stringify(JSON.parse(discoveryDoc("/.well-known/agent.json").body)).includes(`room.trydemigod.com${WORK_RECEIPT_EXTENSION_PATH}`));
});
