
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentDirectory, toA2ACard } from "../server/agent-directory.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

// plan-dir-card, parent research input (multi-agent-orchestration technique
// #7): shape directory cards on the A2A v1.0 Agent Card spec — signed cards,
// skills, auth, endpoints — so outside agents can discover lanes without
// custom integration. Interop/discoverability ONLY: internal lane comms stay
// on the room event log + claims board. Out of scope (not built): auctions,
// staking/slashing, EigenTrust.
//
// Authoring gate:
// 1. Contract: toA2ACard(doc, origin) returns an A2A-v1.0-shaped projection
//    (name/description/url/version, A2A skill objects, protocol capabilities,
//    securitySchemes, supportedInterfaces, x-project-room extension). The
//    house Ed25519 signature is exposed honestly via x-project-room — never
//    faked as JWS signatures[] (we hold no private key to mint JWS).
// 2. Credible regression: a refactor drops the projection, fabricates a
//    signatures[] array, or claims A2A JSON-RPC support the room does not
//    have.
// 3. Existing coverage: none covers the A2A shape; this file owns it.
// 4. No production seams: toA2ACard is a pure function over the card doc.

const CARD = {
  name: "A2A Lane",
  description: "A lane card for A2A discovery.",
  url: "https://agents.example/a2a-lane",
  capabilities: ["code-review", "triage"],
  skills: ["web-search"],
  version: "2.0.0",
};

const publishSigned = (dir, { agentId, card = CARD, visibility } = {}) => {
  const keyPair = generateKeyPair();
  const signature = signCard({ agentId, card, privateKey: keyPair.privateKey });
  return dir.publish({ agentId, card, visibility, publicKey: keyPair.publicKey, signature });
};

const docOf = (agentId = "a2a-lane") => {
  const dir = createAgentDirectory({
    owns: () => ["qa"],
    reach: () => ({ wakeMode: "wakeable", lastPollAt: 1_700_000_000_001, pendingUnacked: 0, bondStatus: "active", host: "h1" }),
  });
  return publishSigned(dir, { agentId });
};

test("toA2ACard maps identity fields and derives A2A skill objects", () => {
  const a2a = toA2ACard(docOf(), "https://room.example");
  assert.equal(a2a.name, "A2A Lane");
  assert.equal(a2a.description, "A lane card for A2A discovery.");
  assert.equal(a2a.url, "https://agents.example/a2a-lane");
  assert.equal(a2a.version, "2.0.0");
  const ids = a2a.skills.map(s => s.id);
  assert.ok(ids.includes("capability-code-review"));
  assert.ok(ids.includes("skill-web-search"));
  assert.ok(ids.includes("lane-qa"));
  for (const skill of a2a.skills) {
    assert.ok(typeof skill.id === "string" && typeof skill.name === "string");
    assert.ok(typeof skill.description === "string");
    assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0);
    assert.deepEqual(skill.inputModes, ["text/plain"]);
    assert.deepEqual(skill.outputModes, ["text/plain"]);
  }
  // No duplicate skill ids across capabilities/skills/owns.
  assert.equal(new Set(ids).size, ids.length);
});

test("toA2ACard is honest about protocol: no A2A JSON-RPC claims, no faked signatures", () => {
  const a2a = toA2ACard(docOf(), "https://room.example");
  // Protocol capabilities are explicit false — we claim no A2A endpoint
  // features for the agent.
  assert.deepEqual(a2a.capabilities, {
    streaming: false, pushNotifications: false, stateTransitionHistory: false,
  });
  // signatures[] is absent: the house Ed25519 signature is not JWS and must
  // not be presented as such.
  assert.ok(!("signatures" in a2a));
  const sig = a2a["x-project-room"].signature;
  assert.equal(sig.algorithm, "Ed25519");
  assert.ok(typeof sig.publicKey === "string" && typeof sig.signature === "string");
  assert.match(a2a["x-project-room"].note, /discoverability/i);
});

test("toA2ACard carries auth and endpoints; interfaces need an origin", () => {
  const withOrigin = toA2ACard(docOf(), "https://room.example");
  assert.equal(withOrigin.securitySchemes.roomCredential.type, "http");
  assert.equal(withOrigin.securitySchemes.roomCredential.scheme, "bearer");
  const bindings = withOrigin.supportedInterfaces.map(i => i.protocolBinding);
  assert.ok(bindings.includes("HTTP+JSON") && bindings.includes("MCP"));
  assert.ok(withOrigin.supportedInterfaces.every(i => i.url.startsWith("https://room.example")));

  const noOrigin = toA2ACard(docOf(), null);
  assert.ok(!("supportedInterfaces" in noOrigin));
  assert.equal(noOrigin.url, "https://agents.example/a2a-lane");
});

test("toA2ACard falls back to the directory card URL when the card has none", () => {
  const dir = createAgentDirectory();
  const doc = publishSigned(dir, { agentId: "no-url", card: { ...CARD, url: null } });
  const a2a = toA2ACard(doc, "https://room.example");
  assert.equal(a2a.url, "https://room.example/api/agents/directory/no-url");
  assert.equal(toA2ACard(doc, null).url, null);
});

test("x-project-room extension carries provenance, owns, reach, and the card link", () => {
  const a2a = toA2ACard(docOf(), "https://room.example");
  const x = a2a["x-project-room"];
  assert.equal(x.agentId, "a2a-lane");
  assert.equal(x.provenance, "self");
  assert.deepEqual([...x.owns], ["qa"]);
  assert.equal(x.reach.wakeMode, "wakeable");
  assert.equal(x.directory, "https://room.example/api/agent-directory");
});

test("buildDocument attaches the A2A projection per agent", () => {
  const dir = createAgentDirectory();
  publishSigned(dir, { agentId: "a2a-lane" });
  const doc = dir.buildDocument({ serviceOrigin: "https://room.example" });
  const a2a = doc.agents[0].a2a;
  assert.equal(a2a.name, "A2A Lane");
  assert.ok(Array.isArray(a2a.skills) && a2a.skills.length > 0);
  assert.ok(!("signatures" in a2a));
});
