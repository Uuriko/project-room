// Signed discovery agent card (A2A v1.0 field conventions) served at
// /.well-known/agent-card.json (RC-2026-09-23-105).
import test from "node:test";
import { AGENT_CARD_KEY_ID } from "../deploy/agent-card-key.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  agentCard, agentCardJson, discoveryDoc, aiCatalog, robotsTxt, AGENT_CARD_A2A_PATH, DISCOVERY_PROTOCOL_VERSION,
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

test("card carries the discovery card (A2A v1.0 field conventions) required field set", () => {
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
  assert.equal(card.protocolVersion, DISCOVERY_PROTOCOL_VERSION);
});

test("skills are non-empty with id/name/description/tags", () => {
  const card = agentCard();
  // v0.3 compat: preferredTransport names the transport older readers should use (#A2A-card-audit 2026-09-24).
  assert.equal(card.preferredTransport, "HTTP+JSON");
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

test("capabilities carry the discovery capability flags and security is declared", () => {
  const card = agentCard();
  assert.equal(typeof card.capabilities.streaming, "boolean");
  assert.equal(card.capabilities.pushNotifications, true, "wakeUrl registration is mounted on this tip");
  // A2A v1.0 removed the v0.3 stateTransitionHistory capability (#A2A-card-audit 2026-09-24).
  assert.equal(card.capabilities.stateTransitionHistory, undefined, "v0.3 stateTransitionHistory must be dropped");
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
  assert.equal(card.name, "Uuriko Project Room");
  assert.equal(card.capabilities.pushNotifications, true);
  assert.ok(Array.isArray(card.supportedInterfaces));
  assert.ok(Array.isArray(card.skills) && card.skills.length > 0);
  const twin = await (await fetch(`${origin}/.well-known/agent.json`)).json();
  assert.deepEqual(card, twin, "agent-card.json and agent.json serve identical bytes");
  const doc = discoveryDoc(AGENT_CARD_A2A_PATH);
  assert.deepEqual(JSON.parse(doc.body), card, "served bytes match discoveryDoc");
});

test("root card aliases serve identical bytes to the well-known card", async t => {
  const origin = await serve(t);
  const canonical = await (await fetch(`${origin}${AGENT_CARD_A2A_PATH}`)).json();
  for (const path of ["/agent.json", "/agent.json/", "/agent-card.json", "/agent-card.json/"]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/, path);
    assert.deepEqual(await res.json(), canonical, `${path} matches the card`);
  }
});

test("robots.txt names the AI crawlers explicitly", async t => {
  const origin = await serve(t);
  const res = await fetch(`${origin}/robots.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const body = await res.text();
  for (const bot of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Meta-ExternalAgent"]) {
    assert.match(body, new RegExp(`User-agent: ${bot.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`), bot);
  }
  assert.match(body, /Allow: \//);
  assert.match(body, /Agentmap: https:\/\/room\.trydemigod\.com\/\.well-known\/ard\.json/);
  assert.equal(body, robotsTxt(), "served bytes match robotsTxt()");
});

test("ARD ai-catalog serves at ard.json and ai-catalog.json with the same bytes", async t => {
  const origin = await serve(t);
  const ard = await fetch(`${origin}/.well-known/ard.json`);
  assert.equal(ard.status, 200);
  assert.match(ard.headers.get("content-type") ?? "", /application\/json/);
  const catalog = await ard.json();
  const compat = await (await fetch(`${origin}/.well-known/ai-catalog.json`)).json();
  assert.deepEqual(compat, catalog, "compat path serves identical bytes");
  // ARD entry contract: specVersion, host, entries with identifier/displayName/type and exactly one of url|data.
  assert.ok(typeof catalog.specVersion === "string" && catalog.specVersion.length > 0);
  assert.equal(typeof catalog.host?.displayName, "string");
  assert.ok(Array.isArray(catalog.entries) && catalog.entries.length >= 2);
  for (const entry of catalog.entries) {
    assert.equal(typeof entry.identifier, "string");
    assert.equal(typeof entry.displayName, "string");
    assert.equal(typeof entry.type, "string");
    assert.ok((entry.url ? 1 : 0) + (entry.data ? 1 : 0) === 1, "exactly one of url|data");
    if (entry.representativeQueries) {
      assert.ok(Array.isArray(entry.representativeQueries));
      assert.ok(entry.representativeQueries.length >= 1 && entry.representativeQueries.length <= 5);
    }
  }
  const cardEntry = catalog.entries.find(e => e.type === "application/a2a-agent-card+json");
  assert.ok(cardEntry, "A2A card entry present");
  assert.equal(cardEntry.metadata.signatureKeyId, AGENT_CARD_KEY_ID, "catalog advertises the configured card signing key");
  if (agentCard().keyId) assert.equal(cardEntry.metadata.signatureKeyId, agentCard().keyId);
  assert.equal(cardEntry.url, "https://room.trydemigod.com/.well-known/agent-card.json");
  const mcpEntry = catalog.entries.find(e => e.type === "application/mcp-server-card+json");
  assert.ok(mcpEntry, "MCP entry present");
  assert.equal(mcpEntry.url, "https://www.getdasha.com/room/mcp/server-card");
  assert.deepEqual(catalog, JSON.parse(aiCatalog()), "served bytes match aiCatalog()");
  const doc = discoveryDoc("/.well-known/ard.json");
  assert.equal(doc.body, aiCatalog(), "discoveryDoc body matches aiCatalog()");
});
