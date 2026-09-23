// Signed A2A v1.0 Agent Card served at /.well-known/agent-card.json
// (RC-2026-09-23-105).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  agentCard, agentCardJson, discoveryDoc, AGENT_CARD_A2A_PATH, A2A_PROTOCOL_VERSION,
} from "../deploy/agent-discovery.mjs";
import { AGENT_CARD_PUBLIC_KEY, AGENT_CARD_AGENT_ID } from "../deploy/agent-card-key.mjs";
import {
  canonicalCardBytes, generateKeyPair, isValidPublicKey, signCard, verifyCardSignature,
} from "../server/agent-card-signing.mjs";

const FORBIDDEN = /privateKey|ROOM_AGENT_CARD_SIGNING_KEY|\.key("|$)/i;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-agent-card-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("card carries the A2A v1.0 required field set", () => {
  const card = agentCard();
  for (const field of ["name", "description", "version", "supportedInterfaces", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
    assert.ok(card[field] !== undefined && card[field] !== null, `missing required field: ${field}`);
  }
  assert.equal(typeof card.name, "string");
  assert.equal(typeof card.description, "string");
  assert.ok(Array.isArray(card.defaultInputModes) && card.defaultInputModes.length > 0);
  assert.ok(Array.isArray(card.defaultOutputModes) && card.defaultOutputModes.length > 0);
});

test("supportedInterfaces declares versioned bindings", () => {
  const card = agentCard();
  assert.ok(card.supportedInterfaces.length >= 1);
  for (const iface of card.supportedInterfaces) {
    assert.match(iface.url, /^https:\/\//, "interface url must be https");
    assert.equal(typeof iface.protocolBinding, "string");
    assert.equal(typeof iface.protocolVersion, "string");
  }
  const primary = card.supportedInterfaces[0];
  assert.equal(primary.protocolVersion, "1.0");
  assert.equal(primary.protocolVersion, A2A_PROTOCOL_VERSION);
});

test("skills are non-empty with id/name/description/tags", () => {
  const card = agentCard();
  assert.ok(card.skills.length >= 1);
  for (const skill of card.skills) {
    assert.equal(typeof skill.id, "string");
    assert.equal(typeof skill.name, "string");
    assert.equal(typeof skill.description, "string");
    assert.ok(Array.isArray(skill.tags), `skill ${skill.id} missing tags`);
  }
  const ids = card.skills.map(s => s.id);
  assert.ok(ids.includes("guest-agent-link"), "card advertises the guest-link flow");
  assert.ok(ids.includes("claims-board"), "card advertises the claims board");
});

test("capabilities carry the A2A protocol flags and security is declared", () => {
  const card = agentCard();
  assert.equal(typeof card.capabilities.streaming, "boolean");
  assert.equal(typeof card.capabilities.pushNotifications, "boolean");
  assert.equal(typeof card.capabilities.stateTransitionHistory, "boolean");
  assert.ok(card.securitySchemes.digestAuth, "digestAuth scheme declared");
  assert.ok(card.securitySchemes.guestLinkAuth, "guestLinkAuth scheme declared");
  assert.ok(card.securitySchemes.bearerAuth, "bearerAuth scheme declared");
  assert.ok(Array.isArray(card.securityRequirements) && card.securityRequirements.length > 0);
});

test("card advertises the guest-link GX- flow and the claims board", () => {
  const card = agentCard();
  const guest = card.skills.find(s => s.id === "guest-agent-link");
  assert.match(guest.description, /GX-/);
  assert.match(guest.description, /Ed25519/);
  assert.match(card.description, /guest-link/i);
  assert.match(card.description, /266/);
});

test("signature round-trips with the house Ed25519 standard", () => {
  const { publicKey, privateKey } = generateKeyPair();
  assert.ok(isValidPublicKey(publicKey));
  const card = agentCard();
  const agentId = "test-room";
  const signature = signCard({ agentId, card, privateKey });
  assert.equal(typeof signature, "string");
  assert.ok(verifyCardSignature({ agentId, card, publicKey, signature }), "fresh signature verifies");
  assert.equal(verifyCardSignature({ agentId: "other-room", card, publicKey, signature }), false, "agentId binding enforced");
  assert.equal(verifyCardSignature({ agentId, card: { ...card, name: "Evil Room" }, publicKey, signature }), false, "tampered card rejected");
  assert.equal(verifyCardSignature({ agentId, card, publicKey, signature: "AAAA" }), false, "malformed signature rejected");
});

test("pinned public key is a valid Ed25519 key and the card leaks no secrets", () => {
  assert.ok(isValidPublicKey(AGENT_CARD_PUBLIC_KEY), "pinned key must be a valid Ed25519 public key");
  assert.equal(FORBIDDEN.test(agentCardJson()), false, "card must never carry private key material");
});

test("unsigned default: committed tree serves the card with no signature envelope", () => {
  // deploy/agent-card-signed.mjs ships the null default; the deploy flow
  // re-signs it (dirty worktree state, reverted after deploy).
  const card = agentCard();
  assert.equal(card.cardSignature ?? null, null);
  assert.equal(card.publicKey ?? null, null);
});

test("canonical bytes are stable for the served card shape", () => {
  const card = agentCard();
  const a = canonicalCardBytes({ agentId: AGENT_CARD_AGENT_ID, card });
  const b = canonicalCardBytes({ agentId: AGENT_CARD_AGENT_ID, card: JSON.parse(JSON.stringify(card)) });
  assert.deepEqual(a, b, "canonical bytes must survive a JSON round-trip (what verifiers recompute)");
});

test("funnel serves the signed-shape card at the well-known path", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}${AGENT_CARD_A2A_PATH}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const card = await res.json();
  assert.equal(card.name, "Project Room");
  assert.ok(Array.isArray(card.supportedInterfaces));
  assert.ok(Array.isArray(card.skills) && card.skills.length > 0);
  const twin = await (await fetch(`${origin}/.well-known/agent.json`)).json();
  assert.deepEqual(card, twin, "agent-card.json and agent.json serve identical bytes");
  const doc = discoveryDoc(AGENT_CARD_A2A_PATH);
  assert.deepEqual(JSON.parse(doc.body), card, "served bytes match discoveryDoc");
});
