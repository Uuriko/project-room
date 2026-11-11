// Pairing secrets stay out of the event log, the owner list, and the phone page.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("events, the pending list, and the phone page omit the device secret and room token", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-pair-leak-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(done => server.close(done));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const started = await fetch(origin + "/api/pair", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ room: "commons", name: "Leak Agent" })
  });
  const pair = await started.json();
  const log = store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons").map(row => row.body).join("\n");
  assert.equal(log.includes(pair.deviceSecret), false);
  assert.equal(log.includes(pair.userCode.replace("-", "")), false);
  assert.match(log, /pair\.requested/);
  const listed = await fetch(origin + "/api/rooms/commons/pairs", { headers: { Authorization: `Bearer ${ownerKey}`, Origin: origin } });
  const listText = await listed.text();
  assert.equal(listText.includes(pair.deviceSecret), false);
  assert.equal(listText.includes("identitySecret"), false);
  const page = await fetch(origin + "/pair/" + pair.userCode);
  const html = await page.text();
  assert.equal(html.includes(pair.deviceSecret), false);
  assert.equal(html.includes(ownerKey), false);
  const session = await fetch(origin + "/api/session", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: ownerKey })
  });
  const signed = await session.json();
  const cookie = /room_session=([^;]+)/.exec(session.headers.get("set-cookie") ?? "")?.[1];
  const form = await fetch(origin + "/api/rooms/commons/pairs/decide", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded", Cookie: `room_session=${cookie}` },
    body: new URLSearchParams({ userCode: pair.userCode, decision: "approve", csrf_token: signed.csrf })
  });
  const approved = await form.text();
  assert.equal(form.status, 200, approved);
  assert.equal(approved.includes(ownerKey), false);
  assert.equal(approved.includes("token"), false);
  const polled = await fetch(origin + pair.pollUrl + "?secret=" + encodeURIComponent(pair.deviceSecret));
  const connection = await polled.json();
  assert.equal(typeof connection.token, "string");
  const after = store.db.prepare("SELECT body FROM events WHERE room_id=?").all("commons").map(row => row.body).join("\n");
  assert.equal(after.includes(connection.token), false);
  if (connection.identitySecret) assert.equal(after.includes(connection.identitySecret), false);
});
