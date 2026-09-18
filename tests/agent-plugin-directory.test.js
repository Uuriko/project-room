import test from "node:test";
import assert from "node:assert/strict";
import { createAgentDirectory, DirectoryError } from "../server/agent-directory.mjs";

const fresh = () => {
  let t = 1_700_000_000_000;
  return createAgentDirectory({ clock: () => t });
};
const CARD = {
  name: "Research Agent",
  description: "Summarizes room threads nightly.",
  url: "https://agents.example/research",
  capabilities: ["summarize", "search"],
  skills: ["web-search"],
  version: "1.2.3",
};

test("publish validates and returns a frozen card doc", t => {
  const dir = fresh();
  const doc = dir.publish({ agentId: "research-agent", card: CARD });
  assert.equal(doc.agentId, "research-agent");
  assert.equal(doc.visibility, "public");
  assert.equal(doc.url, "https://agents.example/research");
  assert.deepEqual([...doc.capabilities], ["summarize", "search"]);
  assert.ok(doc.publishedAt > 0 && doc.updatedAt > 0);
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.capabilities));
  assert.deepEqual(dir.get("research-agent"), doc);
});

test("publish rejects bad ids, cards, and visibilities", t => {
  const dir = fresh();
  assert.throws(() => dir.publish({ agentId: "Bad ID", card: CARD }), DirectoryError);
  assert.throws(() => dir.publish({ agentId: "ok", card: CARD, visibility: "secret" }), DirectoryError);
  assert.throws(() => dir.publish({ agentId: "ok", card: { ...CARD, name: "" } }), DirectoryError);
  assert.throws(() => dir.publish({ agentId: "ok", card: { ...CARD, url: "http://x.example" } }), DirectoryError);
  assert.throws(() => dir.publish({ agentId: "ok", card: { ...CARD, capabilities: [] } }), DirectoryError);
  assert.throws(() => dir.publish({ agentId: "ok", card: { ...CARD, version: "1.2" } }), DirectoryError);
  assert.throws(() => dir.publish({ agentId: "ok", card: null }), DirectoryError);
});

test("republish updates; withdraw hides; get throws on missing", t => {
  const dir = fresh();
  dir.publish({ agentId: "rep", card: CARD });
  const updated = dir.publish({ agentId: "rep", card: { ...CARD, version: "1.2.4" } });
  assert.equal(updated.version, "1.2.4");
  assert.equal(updated.publishedAt, dir.get("rep").publishedAt);
  assert.deepEqual(dir.withdraw("rep"), { agentId: "rep", withdrawn: true });
  assert.deepEqual(dir.list(), []);
  assert.throws(() => dir.get("rep"), /no listed card/);
  assert.throws(() => dir.get("missing"), /no listed card/);
  assert.throws(() => dir.withdraw("missing"), DirectoryError);
});

test("list searches by query and filters by capability; visibility policy holds", t => {
  const dir = fresh();
  dir.publish({ agentId: "alpha", card: { ...CARD, name: "Alpha Searcher", capabilities: ["search"] } });
  dir.publish({ agentId: "beta", card: { ...CARD, name: "Beta Summarizer", capabilities: ["summarize"] }, visibility: "room" });
  dir.publish({ agentId: "gamma", card: { ...CARD, name: "Gamma Hidden", capabilities: ["search"] }, visibility: "private" });

  const all = dir.list();
  assert.equal(all.length, 1); // public document only
  assert.equal(all[0].agentId, "alpha");

  const trusted = dir.list({ includeNonPublic: true });
  assert.equal(trusted.length, 3);

  // query matches name+description; room/private cards stay out of the public list
  const q = dir.list({ query: "summarizes" });
  assert.equal(q.length, 1);
  assert.equal(q[0].agentId, "alpha");

  const byCap = dir.list({ capability: "search", includeNonPublic: true });
  assert.deepEqual(byCap.map(a => a.agentId).sort(), ["alpha", "gamma"]);
  assert.throws(() => dir.list({ query: 42 }), DirectoryError);
});

test("buildDocument emits a frozen public directory doc with card URLs", t => {
  const dir = fresh();
  dir.publish({ agentId: "alpha", card: CARD });
  dir.publish({ agentId: "beta", card: CARD, visibility: "private" });
  const doc = dir.buildDocument({ serviceOrigin: "https://room.example" });
  assert.equal(doc.version, "1.0.0");
  assert.equal(doc.origin, "https://room.example");
  assert.ok(doc.generatedAt > 0);
  assert.equal(doc.agents.length, 1);
  assert.equal(doc.agents[0].cardUrl, "https://room.example/api/agents/directory/alpha");
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.agents));
  assert.throws(() => dir.buildDocument({ serviceOrigin: "http://insecure.example" }), DirectoryError);
  assert.throws(() => dir.buildDocument({}), DirectoryError);
});
