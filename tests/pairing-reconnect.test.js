// Reconnect by key proof or credential, and the duplicate-name flag.
import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { generateKeyPair } from "../server/agent-card-signing.mjs";
import { pairProofBytes } from "../server/pairing.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function signProof(roomId, name, pair) {
  const seed = Buffer.from(pair.privateKey, "base64");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return sign(null, pairProofBytes(roomId, name, pair.publicKey), key).toString("base64");
}

function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-pair-reconnect-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ store, ownerKey, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

async function post(origin, path, body, token) {
  const res = await fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

const agents = state => Object.values(state.members).filter(member => member.kind === "agent" && member.active !== false);

test("a proved key reconnects the same member and a bare key stays pending", async t => {
  const { origin, ownerKey, store } = await boot(t);
  const pair = generateKeyPair();
  const first = await post(origin, "/api/pair", { room: "commons", name: "Ada Agent", publicKey: pair.publicKey });
  assert.equal(first.status, 200);
  assert.equal(typeof first.json.deviceSecret, "string");
  const approved = await post(origin, `/api/rooms/commons/pairs/${first.json.pairId}/decide`, { decision: "approve", profile: "contribute" }, ownerKey);
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  const memberId = approved.json.memberId;
  const proof = signProof("commons", "Ada Agent", pair);
  const again = await post(origin, "/api/pair", { room: "commons", name: "Ada Agent", publicKey: pair.publicKey, keyProof: proof });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal(again.json.reconnected, true);
  assert.equal(again.json.memberId, memberId);
  assert.equal(agents(store.room("commons").state).length, 1);
  const bare = await post(origin, "/api/pair", { room: "commons", name: "Ada Agent", publicKey: pair.publicKey });
  assert.equal(bare.json.connection, undefined);
  assert.equal(bare.json.pairId.startsWith("pair"), true);
  const listed = await fetch(origin + "/api/rooms/commons/pairs", { headers: { Authorization: `Bearer ${ownerKey}`, Origin: origin } });
  const pending = await listed.json();
  assert.equal(pending.pairs[0].possibleDuplicate.memberId, memberId);
  assert.equal(pending.pairs[0].possibleDuplicate.displayName, "Ada Agent");
});

test("a valid room credential reconnects and does not mint another member", async t => {
  const { origin, ownerKey, store } = await boot(t);
  const started = await post(origin, "/api/pair", { room: "commons", name: "Bea Agent" });
  const approved = await post(origin, `/api/rooms/commons/pairs/${started.json.pairId}/decide`, { decision: "approve" }, ownerKey);
  const token = approved.json.connection.token;
  const again = await post(origin, "/api/pair", { room: "commons", name: "Bea Agent", credential: token });
  assert.equal(again.json.reconnected, true);
  assert.equal(again.json.memberId, approved.json.memberId);
  assert.equal(agents(store.room("commons").state).length, 1);
  assert.equal(store.authenticate(token, "commons").member.id, approved.json.memberId);
});

test("the owner can reconnect a duplicate name instead of adding a second agent", async t => {
  const { origin, ownerKey, store } = await boot(t);
  const first = await post(origin, "/api/pair", { room: "commons", name: "Cara Agent" });
  const approved = await post(origin, `/api/rooms/commons/pairs/${first.json.pairId}/decide`, { decision: "approve" }, ownerKey);
  const second = await post(origin, "/api/pair", { room: "commons", name: "Cara Agent" });
  const page = await fetch(origin + "/pair/" + second.json.userCode);
  const html = await page.text();
  assert.match(html, /Same agent, reconnect it/);
  assert.equal(html.includes(second.json.deviceSecret), false);
  const kept = await post(origin, "/api/rooms/commons/pairs/decide", {
    userCode: second.json.userCode, decision: "approve", reconnect: true
  }, ownerKey);
  assert.equal(kept.json.reconnected, true);
  assert.equal(kept.json.memberId, approved.json.memberId);
  assert.equal(agents(store.room("commons").state).length, 1);
});

test("approve without reconnect adds a second agent when only the name matches", async t => {
  const { origin, ownerKey, store } = await boot(t);
  const first = await post(origin, "/api/pair", { room: "commons", name: "Dana Agent" });
  await post(origin, `/api/rooms/commons/pairs/${first.json.pairId}/decide`, { decision: "approve" }, ownerKey);
  const second = await post(origin, "/api/pair", { room: "commons", name: "Dana Agent" });
  const added = await post(origin, `/api/rooms/commons/pairs/${second.json.pairId}/decide`, { decision: "approve", reconnect: false }, ownerKey);
  assert.equal(added.json.reconnected, false);
  assert.equal(agents(store.room("commons").state).length, 2);
});

test("a kicked agent is not reconnected by key proof", async t => {
  const { origin, ownerKey, store } = await boot(t);
  const pair = generateKeyPair();
  const started = await post(origin, "/api/pair", { room: "commons", name: "Eden Agent", publicKey: pair.publicKey });
  const approved = await post(origin, `/api/rooms/commons/pairs/${started.json.pairId}/decide`, { decision: "approve" }, ownerKey);
  const member = store.room("commons").state.members[approved.json.memberId];
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: member.id, expectedMemberRevision: member.revision, permissions: [...member.permissions], active: false }
  });
  const proof = signProof("commons", "Eden Agent", pair);
  const retry = await post(origin, "/api/pair", { room: "commons", name: "Eden Agent", publicKey: pair.publicKey, keyProof: proof });
  assert.equal(retry.json.reconnected, undefined);
  assert.equal(typeof retry.json.pairId, "string");
  assert.equal(store.room("commons").state.members[member.id].active, false);
});
