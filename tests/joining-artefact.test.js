// Per-instance joining artefact (organism Step 1, joining half): a fresh
// instance auto-publishes a Poppy-shaped joining file and an A2A-style
// instance agent card that name the instance's OWN origin and never the
// hosted service origin; the card is JWS-signed when the instance has a
// configured signing key, and explicitly marked unsigned when it has not.
//
// The hosted discovery documents (llms.txt, agent.json, the pinned-key
// agent-card.json) are another slice's surface and are not asserted here.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ROOM_ORIGIN } from "../server/agent-discovery.mjs";
import {
  JOINING_PATH, INSTANCE_AGENT_CARD_PATH, INSTANCE_JWKS_PATH,
  joiningDocument, instanceAgentCard, instanceJwks, resolveJoiningSigner,
  generateKeyPair, verifyCardJws, UNSIGNED_JOINING_CARD_REASON,
} from "../server/joining-artefact.mjs";

const OWN = "https://room.selfhost.example";
const HOSTED_MARKERS = ["room.trydemigod.com", "trydemigod.com", "getdasha.com"];

function assertOwnOriginOnly(text, label) {
  assert.ok(text.includes(OWN), `${label} names the instance origin`);
  for (const marker of HOSTED_MARKERS) {
    assert.equal(text.includes(marker), false, `${label} must not name hosted marker ${marker}`);
  }
}

test("joining document: Poppy field set, own origin only, self-contained join walk", () => {
  const doc = joiningDocument({ origin: OWN });
  const text = JSON.stringify(doc);
  assertOwnOriginOnly(text, "joining document");
  assert.equal(doc.issuer, OWN);
  // The field set: issuer, sign-in types, scopes, channels, revocation.
  const signInIds = doc.sign_in_types.map(entry => entry.id);
  for (const id of ["identity-mint", "agent-room-create", "invite-redeem", "access-request", "guest-agent-link", "enrolled-key", "account"]) {
    assert.ok(signInIds.includes(id), `sign-in type ${id} present`);
  }
  assert.deepEqual(doc.scopes.invite_profiles, ["chat", "contribute", "review", "collaborate"]);
  assert.equal(doc.channels.mcp.url, `${OWN}/mcp`);
  assert.equal(doc.channels.http.url, OWN);
  assert.equal(doc.channels.a2a.url, `${OWN}/a2a`);
  assert.match(doc.revocation.summary, /revocable/);
  assert.equal(doc.agent_card, `${OWN}${INSTANCE_AGENT_CARD_PATH}`);
  assert.equal(doc.jwks, `${OWN}${INSTANCE_JWKS_PATH}`);
  // The walk an agent follows from this file alone.
  assert.deepEqual(doc.join_steps.map(step => step.action),
    ["mcp_initialize", "identity_mint", "room_create", "verify_membership"]);
  assert.equal(doc.join_steps[0].url, `${OWN}/mcp`);
  assert.equal(doc.join_steps[1].body.params.name, "room_identity_mint");
  assert.equal(doc.join_steps[2].url, `${OWN}/api/agent-rooms`);
  assert.deepEqual(Object.keys(doc.join_steps[2].body).sort(), ["purpose", "title"], "room create requires title and purpose");
  assert.equal(doc.join_steps[3].url, `${OWN}/api/rooms/{roomId}/activation-pack`);
  // No signer configured in this call: the signing block says so, honestly.
  assert.equal(doc.signing.status, "unsigned");
  assert.equal(doc.signing.reason, UNSIGNED_JOINING_CARD_REASON);
});

test("instance card: unsigned is explicit when no key is configured", () => {
  const card = instanceAgentCard({ origin: OWN });
  const text = JSON.stringify(card);
  assertOwnOriginOnly(text, "instance card");
  assert.equal(card.url, OWN);
  assert.equal(card.signed, false);
  assert.equal(card.unsignedReason, UNSIGNED_JOINING_CARD_REASON);
  assert.equal(card.signatures, undefined);
  assert.deepEqual(instanceJwks({ signer: null }), { keys: [] });
});

test("instance card: JWS signature verifies against the instance JWKS key", () => {
  const pair = generateKeyPair();
  const signer = { privateKey: pair.privateKey, publicKey: pair.publicKey, keyId: "test-instance-key-1" };
  const card = instanceAgentCard({ origin: OWN, signer });
  assert.equal(card.signatures.length, 1);
  assert.equal(card.keyId, "test-instance-key-1");
  assert.equal(verifyCardJws({ card, publicKey: pair.publicKey, jws: card.signatures[0] }), true, "fresh JWS verifies");
  assert.equal(verifyCardJws({ card: { ...card, name: "Evil Room" }, publicKey: pair.publicKey, jws: card.signatures[0] }), false, "tampered card rejected");
  const jwks = instanceJwks({ signer });
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].kid, "test-instance-key-1");
  assert.equal(jwks.keys[0].kty, "OKP");
  // The JWKS x value is the same key material the signature verifies with.
  const xAsBase64 = Buffer.from(jwks.keys[0].x, "base64url").toString("base64");
  assert.equal(xAsBase64, pair.publicKey);
  const doc = joiningDocument({ origin: OWN, signer });
  assert.equal(doc.signing.status, "signed");
  assert.equal(doc.signing.keyId, "test-instance-key-1");
});

test("signer resolution: env seed derives its public key; invalid seed throws; absent is null", () => {
  const pair = generateKeyPair();
  const signer = resolveJoiningSigner({ ROOM_JOINING_CARD_SIGNING_KEY: pair.privateKey });
  assert.equal(signer.publicKey, pair.publicKey);
  assert.equal(signer.privateKey, pair.privateKey);
  assert.equal(resolveJoiningSigner({}), null);
  assert.throws(() => resolveJoiningSigner({ ROOM_JOINING_CARD_SIGNING_KEY: "AAAA" }), /32-byte Ed25519 seed/);
});

async function start(t, origin) {
  const directory = mkdtempSync(join(tmpdir(), "joining-artefact-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("gallery-room"));
  const server = createRoomServer({ store, origin });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const port = server.address().port;
  const host = new URL(origin).host;
  const send = path => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { host, accept: "application/json" } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  return { send };
}

test("served: a fresh instance publishes all three documents at its own origin", async t => {
  // No ROOM_JOINING_CARD_* env is set in this process, so the served card is
  // the honest unsigned form; signed serving is unit-proven above and
  // end-to-end proven in the lane report's disposable-instance walk.
  const { send } = await start(t, OWN);
  for (const path of [JOINING_PATH, INSTANCE_AGENT_CARD_PATH, INSTANCE_JWKS_PATH]) {
    const res = await send(path);
    assert.equal(res.status, 200, `${path} status`);
    if (path === INSTANCE_JWKS_PATH) {
      // No keys configured: an empty JWKS, and still no hosted marker.
      assert.deepEqual(JSON.parse(res.text), { keys: [] });
      for (const marker of HOSTED_MARKERS) assert.equal(res.text.includes(marker), false, `${path} names no hosted marker`);
    } else {
      assertOwnOriginOnly(res.text, path);
    }
  }
  const joining = JSON.parse((await send(JOINING_PATH)).text);
  assert.equal(joining.issuer, OWN);
  const card = JSON.parse((await send(INSTANCE_AGENT_CARD_PATH)).text);
  assert.equal(card.url, OWN);
  assert.equal(card.signed, false);
  // Hosted mode is coherent: when the instance IS the hosted origin, the
  // documents name that origin (it is their own).
  const hosted = joiningDocument({ origin: ROOM_ORIGIN });
  assert.equal(hosted.issuer, ROOM_ORIGIN);
});
