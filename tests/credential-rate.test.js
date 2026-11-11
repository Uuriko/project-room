import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

// A credential used to be able to spend its whole minute at once: 600 reads
// or 60 writes. Back-to-back polls and posts then all succeeded. Each token
// now has its own burst, and a guest command keeps only the guest-post window.

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-credential-rate-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "ada", displayName: "Ada", kind: "human", permissions: ["steer"] },
  });
  const adaKey = store.issueAccessKey("commons", "ada");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { store, request, ownerKey, adaKey };
}

function post(request, token, body) {
  return request("/api/rooms/commons/commands", {
    method: "POST", token,
    data: { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body } },
  });
}

test("back-to-back event reads are limited per token", async t => {
  const { request, ownerKey, adaKey } = await serve(t);
  const reads = await Promise.all(Array.from({ length: 80 }, () => request("/api/rooms/commons/events", { token: adaKey })));
  const readStatuses = reads.map(response => response.status);
  assert.ok(readStatuses.includes(200), "a token can still read inside its burst");
  const limited = reads.find(response => response.status === 429);
  assert.ok(limited, "80 back-to-back event reads are not all allowed");
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(limited.headers.get("x-ratelimit-bucket"), "read");
  assert.equal(JSON.stringify(body).includes(adaKey), false);
  const other = await request("/api/rooms/commons/events", { token: ownerKey });
  assert.equal(other.status, 200, "a second token keeps its own read burst");
  const posted = await post(request, adaKey, "a note after the read burst");
  assert.equal(posted.status, 201, "reads do not spend the write burst");
});

test("back-to-back posts are limited per token", async t => {
  const { request, ownerKey, adaKey } = await serve(t);
  // bond.list is a write on the command route and does not spend the chat flood,
  // so this burst is the per-token budget rather than the per-member message cap.
  const writes = await Promise.all(Array.from({ length: 50 }, () => request("/api/rooms/commons/commands", {
    method: "POST", token: ownerKey,
    data: { id: randomUUID(), type: "bond.list", data: {} },
  })));
  const writeStatuses = writes.map(response => response.status);
  assert.ok(writeStatuses.includes(201), "a token can still post inside its burst");
  const refused = writes.find(response => response.status === 429);
  assert.ok(refused, "50 back-to-back command posts are not all allowed");
  const refusedBody = await refused.json();
  assert.equal(refusedBody.error.code, "rate_limited");
  assert.equal(refused.headers.get("x-ratelimit-bucket"), "write");
  assert.equal(JSON.stringify(refusedBody).includes(ownerKey), false);
  const adaPost = await post(request, adaKey, "ada still has a write burst");
  assert.equal(adaPost.status, 201, "a second token keeps its own write burst");
});

test("guest command posts stay on the guest-post budget", async t => {
  const { store, request, ownerKey } = await serve(t);
  const mint = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "Visitor", expectedOwnerRevision: 0 },
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json();
  const identity = store.identities.create("Visitor");
  const keys = generateKeyPair();
  const cardBody = { name: "Visitor", description: "visiting agent", capabilities: ["chat"] };
  const card = {
    ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }),
  };
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: minted.code, card },
  });
  assert.equal(redeemed.status, 201);
  const guest = await redeemed.json();
  const posts = await Promise.all(Array.from({ length: 25 }, (_, index) => post(request, guest.token, `guest note ${index}`)));
  const statuses = await Promise.all(posts.map(async response => {
    const payload = response.status === 201 ? null : await response.json();
    return { status: response.status, bucket: response.headers.get("x-ratelimit-bucket"), code: payload?.error?.code };
  }));
  assert.deepEqual(statuses.map(entry => entry.status), Array.from({ length: 25 }, () => 201), JSON.stringify(statuses));
  assert.ok(statuses.every(entry => entry.bucket !== "write"));
});
