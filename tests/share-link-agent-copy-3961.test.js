// #3961: share-link agent copy must state the access actually granted.
// QA Wave C lane 1 verified the co_admin grant itself is correct — the
// joiner held the six working permissions — but the copy around it
// misstated the rule in both directions:
//  1. POST /api/share-links/join-agent answered a co_admin join with
//     the guest orientation text ("Your guest pass grants read+chat;
//     work claims, polls, and admin are out of scope"), so an agent
//     trusting next[] would under-use or misreport its access.
//  2. That same agent, refused at POST /api/rooms/:id/share-links,
//     was told "Invitation links require a signed-in browser session"
//     — while the room's agent owner minted links over the same bearer
//     auth. The real refusal is authority (not owner / not an
//     owner-appointed admin holding manage_members).
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-link-copy-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons", "owner"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mint = access => {
    const linkToken = randomBytes(32).toString("base64url");
    store.shareLinks.create(ownerKey, "commons", { requestId: randomUUID(), linkToken,
      expiresAt: Date.now() + 3600000, maxJoins: 5, expectedMemberRevision: 0, ...(access ? { access } : {}) }, null);
    return linkToken;
  };
  const post = async (path, { bearer, data } = {}) => {
    const response = await fetch(origin + path, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(data ?? {}) });
    return { status: response.status, body: await response.json() };
  };
  return { store, mint, post };
}

test("#3961: a co_admin join-agent response names the granted access, not a guest pass", async t => {
  const f = await fixture(t);
  const agent = f.store.identities.create("Co admin agent");
  const joined = await f.post("/api/share-links/join-agent", { bearer: agent.secret,
    data: { linkToken: f.mint("co_admin"), displayName: "Co admin agent" } });
  assert.equal(joined.status, 201);
  assert.ok(joined.body.permissions.includes("accept_work"));
  assert.ok(joined.body.permissions.includes("verify"));
  const hello = joined.body.next.find(step => step.action === "say-hello");
  assert.ok(hello, "the say-hello step is present");
  assert.doesNotMatch(hello.description, /guest pass/i, "a working seat is never described as a guest pass");
  assert.match(hello.description, /accept_work/, "the granted permissions are named in the guidance");
  assert.match(hello.description, /out of scope/i, "the boundary is still stated");
});

test("#3961: a guest join-agent response keeps the guest-pass wording", async t => {
  const f = await fixture(t);
  const agent = f.store.identities.create("Guest agent");
  const joined = await f.post("/api/share-links/join-agent", { bearer: agent.secret,
    data: { linkToken: f.mint(), displayName: "Guest agent" } });
  assert.equal(joined.status, 201);
  assert.deepEqual(joined.body.permissions, []);
  const hello = joined.body.next.find(step => step.action === "say-hello");
  assert.match(hello.description, /Your guest pass grants read\+chat; work claims, polls, and admin are out of scope\./);
});

test("#3961: the share-links bearer refusal names the missing authority for an identity caller", async t => {
  const f = await fixture(t);
  const agent = f.store.identities.create("Co admin agent");
  const joined = await f.post("/api/share-links/join-agent", { bearer: agent.secret,
    data: { linkToken: f.mint("co_admin"), displayName: "Co admin agent" } });
  assert.equal(joined.status, 201);
  const refused = await f.post("/api/rooms/commons/share-links", { bearer: agent.secret, data: {
    requestId: randomUUID(), linkToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: 1 } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "access_denied");
  assert.doesNotMatch(refused.body.error.message, /signed-in browser session/,
    "an identity bearer is not told to use a browser — agents administer links over this same auth when authorized");
  assert.match(refused.body.error.message, /manage_members/, "the refusal names the authority the caller lacks");
});
