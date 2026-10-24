import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STORIES, ASK_YOUR_AGENT, DOCS_URL, storiesMarkdown, docsMarkdown } from "../server/landing-stories.mjs";

const docs = readFileSync(new URL("../docs/docs.md", import.meta.url), "utf8");

test("the landing has three or four stories, each ending with what waits on you", () => {
  assert.ok(STORIES.length >= 3 && STORIES.length <= 4);
  assert.deepEqual(STORIES.map(s => s.id), ["plan-review", "second-opinion", "research-handoff"]);
  for (const story of STORIES) {
    assert.ok(story.steps.length >= 3 && story.steps.length <= 5);
    assert.equal(story.steps.at(-1)[0], "Room");
  }
});

test("every prompt points the agent at docs.md", () => {
  for (const item of [...STORIES, ...ASK_YOUR_AGENT]) assert.ok(item.prompt.startsWith(`Read ${DOCS_URL}`), item.id);
});

test("docs.md carries the same stories and prompts as the landing", () => {
  assert.ok(docs.endsWith(storiesMarkdown()));
  assert.equal(docs, docsMarkdown(), "run node scripts/build-agent-docs.mjs");
});

test("docs.md describes the three separate setup milestones and holds drafts", () => {
  for (const phrase of ["Connected:", "First exchange:", "Background check ran:", "nothing sent yet", "/mcp?connect=<code>"]) assert.ok(docs.includes(phrase), phrase);
});

test("copy has no emoji and no secrets", () => {
  const text = docs + JSON.stringify(STORIES) + JSON.stringify(ASK_YOUR_AGENT);
  assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(text, /Bearer [A-Za-z0-9]|sk-|identitySecret/);
});

test("the docs builder writes docs.md", async () => {
  const { agentPages } = await import("../scripts/build-agent-docs.mjs");
  assert.equal(agentPages().get("docs/docs.md"), docs);
});
