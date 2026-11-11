// Identity mint returns a server-generated Ed25519 seed on the create
// response only. The seed is not stored. The response must say so, and a
// later read of the same identity must not carry the seed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "identity-mint-private-key-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, directory };
}

const post = (origin, body, secret) => fetch(`${origin}/api/agent-identities`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "project-room-agent",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
});

function storedFilesContain(directory, needle) {
  const files = readdirSync(directory);
  return files.some(name => readFileSync(join(directory, name)).includes(needle));
}

test("identity mint returns the private key once, with a warning, and does not keep it", async t => {
  const { origin, directory } = await serve(t);
  const created = await post(origin, { displayName: "Key Warning Agent" });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(Buffer.from(body.privateKey, "base64").length, 32);
  assert.equal(typeof body.privateKeyWarning, "string");
  assert.match(body.privateKeyWarning, /shown once/);
  assert.match(body.privateKeyWarning, /not stored/);
  assert.match(body.privateKeyWarning, /Save it now/);
  assert.equal(body.privateKeyWarning.includes(body.privateKey), false);
  assert.equal(body.privateKeyWarning.includes(body.secret), false);

  const listed = await fetch(`${origin}/api/agent-identities/${body.identityId}/keys`, {
    headers: { "user-agent": "project-room-agent" },
  });
  assert.equal(listed.status, 200);
  const keys = await listed.json();
  assert.equal(keys.keys.length, 1);
  assert.equal(keys.keys[0].publicKey, body.publicKey);
  assert.equal(JSON.stringify(keys).includes(body.privateKey), false);
  assert.equal(storedFilesContain(directory, body.privateKey), false);

  const replay = await post(origin, { displayName: "Key Warning Agent", recoverable: true }, body.secret);
  assert.equal(replay.status, 201);
  const again = await replay.json();
  assert.equal(again.duplicate, true);
  assert.equal(again.identityId, body.identityId);
  assert.equal(again.privateKey, undefined);
  assert.equal(again.privateKeyWarning, undefined);
  assert.equal(again.secret, undefined);
});
