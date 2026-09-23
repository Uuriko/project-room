// G7: independent HTTP adversarial review of isolated 02fba88. No integration edits.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";

const INTEGRATION = process.env.PROJECT_ROOM_G7_ROOT || "/Users/johnpotter/src/project-room-integration";
const { RoomStore } = await import(`${INTEGRATION}/server/store.mjs`);
const { initialRoom } = await import(`${INTEGRATION}/server/bootstrap.mjs`);
const { createRoomServer } = await import(`${INTEGRATION}/server/http.mjs`);
const { attachmentLimits } = await import(`${INTEGRATION}/server/attachments.mjs`);

async function serve(t, rooms = ["files"]) {
  const store = new RoomStore(":memory:");
  for (const id of rooms) store.initialize(initialRoom(id, `${id}-owner`));
  const server = createRoomServer({ store });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  return { store, server, origin: `http://127.0.0.1:${server.address().port}` };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}`, "X-File-Name": "notes.txt", "Content-Type": "text/plain" };
}

function pendingPut(origin, path, headers) {
  let resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  const req = request(origin + path, { method: "PUT", headers }, res => {
    const chunks = [];
    res.on("data", chunk => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", reject);
  req.write(Buffer.from([1]));
  return { req, done };
}

function rows(store) {
  return store.db.prepare("SELECT count(*) n FROM room_attachments").get().n;
}

test("unknown methods and query selectors are rejected without persistence", async t => {
  const { store, origin } = await serve(t);
  const token = store.issueAccessKey("files", "files-owner");
  const path = "/api/rooms/files/attachments/" + randomUUID();
  const headers = bearer(token);
  assert.equal((await fetch(origin + path + "?view=1", { method: "PUT", headers, body: new Uint8Array([1]) })).status, 422);
  assert.equal((await fetch(origin + path + "?auth=room&auth=account", { method: "PUT", headers, body: new Uint8Array([1]) })).status, 422);
  const post = await fetch(origin + path, { method: "POST", headers, body: new Uint8Array([1]) });
  assert.equal(post.status, 405);
  assert.match(post.headers.get("allow") || "", /PUT/);
  const patch = await fetch(origin + path, { method: "PATCH", headers, body: new Uint8Array([1]) });
  assert.equal(patch.status, 405);
  assert.equal(rows(store), 0);
});

test("member, room and global in-flight admission match the live counters", async t => {
  const { store, server, origin } = await serve(t, ["alpha", "beta", "gamma"]);
  const keys = {};
  for (const room of ["alpha", "beta", "gamma"]) {
    const owner = store.issueAccessKey(room, `${room}-owner`);
    store.command(owner, room, {
      id: randomUUID(), type: "member.added",
      data: { memberId: `${room}-guest`, displayName: "Guest", kind: "human", permissions: [] }
    });
    store.command(owner, room, {
      id: randomUUID(), type: "member.added",
      data: { memberId: `${room}-extra`, displayName: "Extra", kind: "human", permissions: [] }
    });
    keys[`${room}-owner`] = owner;
    keys[`${room}-guest`] = store.issueAccessKey(room, `${room}-guest`);
    keys[`${room}-extra`] = store.issueAccessKey(room, `${room}-extra`);
  }
  const inflight = [];
  const start = async (room, member) => {
    const path = `/api/rooms/${room}/attachments/${randomUUID()}`;
    const arrived = once(server, "request");
    const upload = pendingPut(origin, path, bearer(keys[`${room}-${member}`]));
    await arrived;
    inflight.push(upload);
    return upload;
  };
  await start("alpha", "owner");
  const sameMember = await fetch(`${origin}/api/rooms/alpha/attachments/${randomUUID()}`, {
    method: "PUT", headers: bearer(keys["alpha-owner"]), body: new Uint8Array([1])
  });
  assert.equal(sameMember.status, 429, await sameMember.text());
  await start("alpha", "guest");
  const thirdInRoom = await fetch(`${origin}/api/rooms/alpha/attachments/${randomUUID()}`, {
    method: "PUT", headers: bearer(keys["alpha-extra"]), body: new Uint8Array([1])
  });
  assert.equal(thirdInRoom.status, 429, await thirdInRoom.text());
  await start("beta", "owner");
  await start("beta", "guest");
  const global = await fetch(`${origin}/api/rooms/gamma/attachments/${randomUUID()}`, {
    method: "PUT", headers: bearer(keys["gamma-owner"]), body: new Uint8Array([1])
  });
  assert.equal(global.status, 429, await global.text());
  await Promise.all(inflight.map(upload => {
    upload.req.end();
    return upload.done.catch(() => {});
  }));
});

test("slow uploads time out, free the admission slot and persist nothing", { timeout: 20000 }, async t => {
  const { store, server, origin } = await serve(t);
  const token = store.issueAccessKey("files", "files-owner");
  const path = "/api/rooms/files/attachments/" + randomUUID();
  const arrived = once(server, "request");
  const upload = pendingPut(origin, path, bearer(token));
  await arrived;
  const result = await upload.done.catch(error => ({ status: 0, body: String(error) }));
  assert.ok(result.status === 408 || /ECONNRESET|socket hang up/.test(result.body), result.body);
  assert.equal(rows(store), 0);
  const next = await fetch(origin + "/api/rooms/files/attachments/" + randomUUID(), {
    method: "PUT", headers: bearer(token), body: new Uint8Array([9])
  });
  assert.equal(next.status, 200, await next.text());
});

test("account-session rebind during the body cannot persist bytes", async t => {
  const { store, server, origin } = await serve(t);
  store.issueAccessKey("files", "files-owner");
  const account = store.accountForMember("files", "files-owner");
  const accountKey = store.issueAccountAccessKey(account.id);
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSession(slot.token, accountKey, 0);
  assert.equal(typeof first.sessionRevision, "number");
  const path = "/api/rooms/files/attachments/" + randomUUID();
  const headers = {
    Cookie: `account_session=${slot.token}`,
    "X-Project-Room-Auth": "account",
    Origin: origin,
    "X-CSRF-Token": first.csrf,
    "X-Session-Binding": first.sessionBinding,
    "X-File-Name": "notes.txt",
    "Content-Type": "text/plain"
  };
  const arrived = once(server, "request");
  const upload = pendingPut(origin, path, headers);
  await arrived;
  store.loginAccountSession(slot.token, accountKey, first.sessionRevision);
  upload.req.end(Buffer.from([3]));
  const result = await upload.done;
  assert.equal(result.status, 409, result.body);
  assert.match(result.body, /session_binding_changed/);
  assert.equal(rows(store), 0);
});

test("oversize Content-Length rejects 413, holds the admission slot, and persists nothing", async t => {
  const { store, server, origin } = await serve(t);
  const token = store.issueAccessKey("files", "files-owner");
  const path = "/api/rooms/files/attachments/" + randomUUID();
  const arrived = once(server, "request");
  const upload = pendingPut(origin, path, {
    ...bearer(token),
    "Content-Length": String(attachmentLimits.fileBytes + 1)
  });
  await arrived;
  const blocked = await fetch(origin + "/api/rooms/files/attachments/" + randomUUID(), {
    method: "PUT", headers: bearer(token), body: new Uint8Array([1])
  });
  assert.equal(blocked.status, 429, await blocked.text());
  upload.req.end();
  const drained = await upload.done.catch(error => ({ status: 0, body: String(error) }));
  assert.ok(drained.status === 413 || /ECONNRESET|aborted/.test(drained.body), drained.body);
  const stillHeld = await fetch(origin + "/api/rooms/files/attachments/" + randomUUID(), {
    method: "PUT", headers: bearer(token), body: new Uint8Array([1])
  });
  assert.equal(stillHeld.status, 429, await stillHeld.text());
  assert.equal(rows(store), 0);
});
