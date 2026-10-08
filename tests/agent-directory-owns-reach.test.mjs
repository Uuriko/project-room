import test from "node:test";
import assert from "node:assert/strict";
import { createAgentDirectory, DirectoryError } from "../server/agent-directory.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

// plan-dir-card: card docs carry owns[] (areas/lanes, host-supplied from
// live claim data) and reach{} (wake mode, bond status, host — host-supplied
// from live wake + bond data, never fabricated), plus a provenance marker
// (seeded vs self-published) so seeded cards are distinguishable.
//
// Authoring gate (repo test-audit skill):
// 1. Observable contract: cardDoc exposes validated owns/reach/provenance;
//    reach/owns are null when the host supplies nothing; seed() inserts an
//    unsigned owner-seeded card and never overwrites a live card.
// 2. Credible regression: a refactor drops the new fields, fabricates reach
//    for agents with no wake/bond data, or lets a seed clobber a
//    self-published card.
// 3. Existing coverage: tests/agent-plugin-directory.test.js owns
//    publish/get/list/withdraw/trust/presence — nothing here covers
//    owns/reach/provenance/seed, so this file is the primary owner.
// 4. No production seams: reach/owns ride the existing host-function
//    injection (same as trust/presence); seed() is the real path the
//    owner-only seed endpoint calls.

const CARD = {
  name: "Reach Agent",
  description: "Carries owns and reach.",
  url: "https://agents.example/reach",
  capabilities: ["summarize"],
  version: "1.0.0",
};

const publishSigned = (dir, { agentId, card = CARD, visibility, keyPair = generateKeyPair() } = {}) => {
  const signature = signCard({ agentId, card, privateKey: keyPair.privateKey });
  return dir.publish({ agentId, card, visibility, publicKey: keyPair.publicKey, signature });
};

test("reach() and owns() attach validated host data to the card doc", () => {
  const dir = createAgentDirectory({
    reach: agentId => agentId === "reach-agent"
      ? { wakeMode: "wakeable", lastPollAt: 1_700_000_000_001, pendingUnacked: 2, bondStatus: "active", host: "host-1" }
      : null,
    owns: agentId => agentId === "reach-agent" ? ["qa", "plan"] : null,
  });
  const doc = publishSigned(dir, { agentId: "reach-agent" });
  assert.deepEqual(doc.reach, {
    wakeMode: "wakeable", lastPollAt: 1_700_000_000_001, pendingUnacked: 2, bondStatus: "active", host: "host-1",
  });
  assert.deepEqual([...doc.owns], ["qa", "plan"]);
  assert.ok(Object.isFrozen(doc.reach) && Object.isFrozen(doc.owns));
  // Agents the host knows nothing about read as null — never fabricated.
  const other = publishSigned(dir, { agentId: "other-agent" });
  assert.equal(other.reach, null);
  assert.equal(other.owns, null);
});

test("reach/owns default to null when the host supplies no functions", () => {
  const dir = createAgentDirectory();
  const doc = publishSigned(dir, { agentId: "plain-agent" });
  assert.equal(doc.reach, null);
  assert.equal(doc.owns, null);
});

test("reach validation rejects bad shapes; owns validation rejects bad arrays", () => {
  const badReach = record => createAgentDirectory({ reach: () => record });
  const badOwns = value => createAgentDirectory({ owns: () => value });
  for (const record of [
    { wakeMode: "telepathy", lastPollAt: null, pendingUnacked: 0, bondStatus: "none", host: null },
    { wakeMode: "wakeable", lastPollAt: -5, pendingUnacked: 0, bondStatus: "none", host: null },
    { wakeMode: "wakeable", lastPollAt: null, pendingUnacked: -1, bondStatus: "none", host: null },
    { wakeMode: "wakeable", lastPollAt: null, pendingUnacked: 1.5, bondStatus: "none", host: null },
    { wakeMode: "wakeable", lastPollAt: null, pendingUnacked: 0, bondStatus: "married", host: null },
    { wakeMode: "wakeable", lastPollAt: null, pendingUnacked: 0, bondStatus: "none", host: 42 },
    "not-an-object",
    [],                // arrays are not records — must throw, not normalize
    ["wakeable"],
  ]) {
    const dir = badReach(record);
    assert.throws(() => publishSigned(dir, { agentId: "bad-reach" }), DirectoryError, JSON.stringify(record));
  }
  for (const value of [["ok", ""], ["ok", 42], "not-an-array", [null]]) {
    const dir = badOwns(value);
    assert.throws(() => publishSigned(dir, { agentId: "bad-owns" }), DirectoryError, JSON.stringify(value));
  }
  // Partial reach records are fine: unknown fields stay null, never guessed.
  const dir = createAgentDirectory({
    reach: () => ({ wakeMode: null, lastPollAt: null, pendingUnacked: 0, bondStatus: "none", host: null }),
  });
  const doc = publishSigned(dir, { agentId: "partial" });
  assert.equal(doc.reach.wakeMode, null);
  assert.equal(doc.reach.host, null);
});

test("publish marks provenance self; seed marks provenance seeded", () => {
  const dir = createAgentDirectory();
  const selfDoc = publishSigned(dir, { agentId: "self-agent" });
  assert.equal(selfDoc.provenance, "self");
  const seeded = dir.seed({ agentId: "seeded-agent", card: CARD });
  assert.equal(seeded.provenance, "seeded");
  assert.equal(seeded.publicKey, null);
  assert.equal(seeded.signature, null);
  assert.equal(seeded.visibility, "room");
  assert.ok(Object.isFrozen(seeded));
});

test("seed refuses to overwrite a live card and validates its input", () => {
  const dir = createAgentDirectory();
  publishSigned(dir, { agentId: "taken" });
  assert.throws(() => dir.seed({ agentId: "taken", card: CARD }), DirectoryError);
  assert.throws(() => dir.seed({ agentId: "Bad ID", card: CARD }), DirectoryError);
  assert.throws(() => dir.seed({ agentId: "nope", card: { ...CARD, capabilities: [] } }), DirectoryError);
  // A withdrawn card may be reseeded.
  dir.withdraw("taken");
  const reseeded = dir.seed({ agentId: "taken", card: CARD });
  assert.equal(reseeded.provenance, "seeded");
});

test("a signed publish over a seeded card flips provenance to self", () => {
  const dir = createAgentDirectory();
  const seeded = dir.seed({ agentId: "flip-agent", card: CARD });
  assert.equal(seeded.provenance, "seeded");
  const keyPair = generateKeyPair();
  const signature = signCard({ agentId: "flip-agent", card: CARD, privateKey: keyPair.privateKey });
  const doc = dir.publish({ agentId: "flip-agent", card: CARD, publicKey: keyPair.publicKey, signature });
  assert.equal(doc.provenance, "self");
  assert.ok(doc.signature);
});

test("owns and reach survive list() and buildDocument()", () => {
  const dir = createAgentDirectory({
    reach: () => ({ wakeMode: "pull-only", lastPollAt: null, pendingUnacked: 0, bondStatus: "pending", host: null }),
    owns: () => ["sweep"],
  });
  publishSigned(dir, { agentId: "listed" });
  const [listed] = dir.list();
  assert.deepEqual([...listed.owns], ["sweep"]);
  assert.equal(listed.reach.wakeMode, "pull-only");
  assert.equal(listed.reach.bondStatus, "pending");
  const doc = dir.buildDocument({ serviceOrigin: "https://room.example" });
  assert.equal(doc.agents[0].owns[0], "sweep");
  assert.equal(doc.agents[0].reach.wakeMode, "pull-only");
  assert.equal(doc.agents[0].provenance, "self");
});
