// SEC-1 response headers, the web manifest type, and security.txt.
// The contract is what a client receives: policy headers on app and API
// responses, a manifest content type, and a contact file only when
// ROOM_SECURITY_CONTACT is set.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const previousContact = process.env.ROOM_SECURITY_CONTACT;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-security-headers-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousContact === undefined) delete process.env.ROOM_SECURITY_CONTACT;
    else process.env.ROOM_SECURITY_CONTACT = previousContact;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function assertPolicy(headers, path) {
  assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=()", path);
  assert.equal(headers.get("cross-origin-opener-policy"), "same-origin", path);
}

test("app and API responses send policy headers, the manifest type, and security.txt only with a contact", async t => {
  delete process.env.ROOM_SECURITY_CONTACT;
  const origin = await serve(t);
  for (const path of ["/", "/api/health"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assertPolicy(response.headers, path);
  }
  const manifest = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /application\/manifest\+json/);
  assertPolicy(manifest.headers, "/manifest.webmanifest");
  const missing = await fetch(`${origin}/.well-known/security.txt`);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Not found/);

  process.env.ROOM_SECURITY_CONTACT = "security@example.com";
  const configured = await serve(t);
  const response = await fetch(`${configured}/.well-known/security.txt`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/plain/);
  const body = await response.text();
  assert.match(body, /^Contact: mailto:security@example.com$/m);
  const expires = /^Expires: (.+)$/m.exec(body)?.[1];
  assert.ok(expires);
  assert.ok(Date.parse(expires) > Date.now() + 300 * 24 * 60 * 60 * 1000);
  const door = await fetch(`${configured}/room/.well-known/security.txt`);
  assert.equal(door.status, 200);
  assert.match(await door.text(), /Contact: mailto:security@example.com/);
});
