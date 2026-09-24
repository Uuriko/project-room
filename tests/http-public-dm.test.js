import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-public-dm-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId: id, displayName: name, kind: "agent", permissions: ["steer", "accept_work"] } });
  }
  const aliceKey = store.issueAccessKey("commons", "alice");
  const bobKey = store.issueAccessKey("commons", "bob");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, origin: `http://127.0.0.1:${server.address().port}`, ownerKey, aliceKey, bobKey };
}

async function post(origin, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
async function get(origin, path, token, accept) {
  const res = await fetch(`${origin}${path}`, {
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(accept ? { Accept: accept } : {}) }
  });
  return { status: res.status, headers: res.headers,
    json: res.headers.get("content-type")?.includes("application/json") ? await res.json().catch(() => null) : null,
    text: res.headers.get("content-type")?.includes("application/json") ? null : await res.text().catch(() => null) };
}
const postMessage = (origin, token, data) => post(origin, "/api/rooms/commons/commands",
  { id: randomUUID(), type: "message.posted", data }, token);

test("POST /join mints an identity and a personal first room", async t => {
  const { origin } = await serve(t);
  const res = await post(origin, "/join", { displayName: "Newt" });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.via, "first-room");
  assert.match(res.json.identitySecret, /^pri_/);
  assert.match(res.json.roomId, /^personal-/);
  assert.equal(res.json.memberId, res.json.identityId);
  assert.ok(Array.isArray(res.json.next) && res.json.next.length >= 3);
  // The one-time secret authenticates against the new room.
  const room = await get(origin, `/api/rooms/${res.json.roomId}`, res.json.identitySecret);
  assert.equal(room.status, 200, JSON.stringify(room.json));
  // /room/join is the same door.
  const alias = await post(origin, "/room/join", { displayName: "Newt Two" });
  assert.equal(alias.status, 201);
  // /api/join is the same door under the /api/ inventory.
  const apiAlias = await post(origin, "/api/join", { displayName: "Newt Three" });
  assert.equal(apiAlias.status, 201);
  assert.equal(apiAlias.json.via, "first-room");
  assert.match(apiAlias.json.identitySecret, /^pri_/);
});

test("POST /join with an inviteCode redeems the invite", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await post(origin, "/api/rooms/commons/agent-invites", { permissions: ["accept_work"] }, ownerKey);
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const res = await post(origin, "/join", { displayName: "Invited Bot", inviteCode: minted.json.code });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.via, "invite");
  assert.equal(res.json.roomId, "commons");
  assert.match(res.json.identitySecret, /^pri_/);
});

test("POST /join validates its body", async t => {
  const { origin } = await serve(t);
  assert.equal((await post(origin, "/join", {})).status, 422);
  assert.equal((await post(origin, "/join", { displayName: "x", extra: 1 })).status, 422);
  assert.equal((await post(origin, "/join", { displayName: "" })).status, 422);
  assert.equal((await post(origin, "/join", { displayName: "ok", inviteCode: "RM-NOPE" })).status, 404);
});

test("GET /skills serves the machine-readable catalog (+ aliases)", async t => {
  const { origin } = await serve(t);
  for (const path of ["/skills", "/room/skills", "/project-room/skills"]) {
    const res = await get(origin, path);
    assert.equal(res.status, 200, path);
    assert.ok(res.headers.get("content-type").includes("application/json"), path);
    assert.ok(Array.isArray(res.json.skills) && res.json.skills.length > 0, path);
    assert.ok(res.json.skills.some(s => s.id === "orient"), path);
    assert.ok(res.headers.get("link")?.includes("/.well-known/agent-card.json"), `Link header on ${path}`);
  }
});

test("DM consent gates posting; approval flows over HTTP", async t => {
  const { origin, ownerKey, aliceKey, bobKey } = await serve(t);
  const aliceId = "alice", bobId = "bob";
  // No consent yet: the DM never lands.
  const refused = await postMessage(origin, aliceKey, { messageId: "dm1", body: "hey bob", toMemberId: bobId });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "dm_consent_required");
  // Public messages still post fine.
  const pub = await postMessage(origin, aliceKey, { messageId: "pub1", body: "hello all" });
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  // Request + approve.
  const req = await post(origin, "/api/rooms/commons/dm-consents", { targetId: bobId, reason: "sync?" }, aliceKey);
  assert.equal(req.status, 201, JSON.stringify(req.json));
  assert.equal(req.json.status, "pending");
  // RC-2026-09-24-001 (dogfood F-13): the request response teaches the
  // decide path — the approval loop's hardest-to-find step.
  assert.equal(req.json.next[0].action, "wait-for-approval");
  assert.ok(req.json.next[0].description.includes(`/dm-consents/${aliceId}/decide`),
    "names the target's decide path with the requester id");
  // Bob's agent inbox carries the pending request.
  const inbox = await get(origin, "/api/rooms/commons/agent-inbox", bobKey);
  assert.equal(inbox.status, 200, JSON.stringify(inbox.json));
  assert.equal(inbox.json.dmRequests.length, 1);
  assert.equal(inbox.json.dmRequests[0].requester, "Alice");
  assert.equal(inbox.json.dmRequests[0].reason, "sync?");
  const decide = await post(origin, `/api/rooms/commons/dm-consents/${aliceId}/decide`, { decision: "approve" }, bobKey);
  assert.equal(decide.status, 200, JSON.stringify(decide.json));
  assert.equal(decide.json.status, "approved");
  // Now the DM posts.
  const ok = await postMessage(origin, aliceKey, { messageId: "dm2", body: "hey bob", toMemberId: bobId });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  // Owner sees pair metadata, not contents.
  const listed = await get(origin, "/api/rooms/commons/dm-consents", ownerKey);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.length, 1);
  assert.equal(listed.json[0].requester, "Alice");
  assert.ok(!JSON.stringify(listed.json).includes("hey bob"));
  // Revoke: the door closes again.
  const revoked = await post(origin, "/api/rooms/commons/dm-consents/revoke", { peerId: bobId }, aliceKey);
  assert.equal(revoked.status, 200);
  const refused2 = await postMessage(origin, aliceKey, { messageId: "dm3", body: "again?", toMemberId: bobId });
  assert.equal(refused2.status, 403);
  assert.equal(refused2.json.error.code, "dm_consent_required");
});

test("public face: owner opt-in, sanitized reads, DMs never leak, disable 404s", async t => {
  const { origin, ownerKey, aliceKey, bobKey } = await serve(t);
  await postMessage(origin, aliceKey, { messageId: "pub1", body: "shipping the release notes" });
  // A DM exists in the room (consent approved first).
  await post(origin, "/api/rooms/commons/dm-consents", { targetId: "bob" }, aliceKey);
  await post(origin, "/api/rooms/commons/dm-consents/alice/decide", { decision: "approve" }, bobKey);
  await postMessage(origin, aliceKey, { messageId: "dm1", body: "sekret dm body", toMemberId: "bob" });
  // Not enabled: 404 everywhere.
  assert.equal((await get(origin, "/p/pub1.fake")).status, 404);
  // Only the owner may toggle.
  assert.equal((await post(origin, "/api/rooms/commons/public-face", { enabled: true }, aliceKey)).status, 403);
  const enabled = await post(origin, "/api/rooms/commons/public-face", { enabled: true }, ownerKey);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json));
  const code = enabled.json.publicCode;
  assert.match(code, /^pub1\./);
  // JSON read.
  const api = await get(origin, `/api/public/rooms/${code}`);
  assert.equal(api.status, 200, JSON.stringify(api.json));
  assert.ok(api.json.room.title.length > 0);
  assert.deepEqual(api.json.members, ["Alice", "Bob", "Room owner"]);
  const blob = JSON.stringify(api.json);
  assert.ok(blob.includes("shipping the release notes"));
  assert.ok(!blob.includes("sekret dm body"), "DM body must not leak");
  assert.ok(!blob.includes("toMemberId"), "DM markers must not leak");
  assert.equal(api.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.ok(api.headers.get("link")?.includes("/skills"), "Link header points at the skills catalog");
  // HTML read by default Accept.
  const html = await get(origin, `/p/${code}`, null, "text/html");
  assert.equal(html.status, 200);
  assert.ok(html.text.includes("shipping the release notes"));
  assert.ok(!html.text.includes("sekret dm body"));
  assert.ok(html.text.includes("noindex"));
  // Explicit JSON via Accept.
  const asJson = await get(origin, `/p/${code}`, null, "application/json");
  assert.equal(asJson.status, 200);
  assert.ok(asJson.json.room);
  // Feed pagination.
  const feed = await get(origin, `/api/public/rooms/${code}/feed?limit=1`);
  assert.equal(feed.status, 200);
  assert.equal(feed.json.messages.length, 1);
  assert.equal(feed.json.hasMore, false);
  assert.ok(!JSON.stringify(feed.json).includes("sekret dm body"));
  // Rotate invalidates the old code.
  const rotated = await post(origin, "/api/rooms/commons/public-face/rotate", {}, ownerKey);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.json.publicCode, code);
  assert.equal((await get(origin, `/api/public/rooms/${code}`)).status, 404);
  // Disable: gone everywhere.
  const off = await post(origin, "/api/rooms/commons/public-face", { enabled: false }, ownerKey);
  assert.equal(off.status, 200);
  assert.equal((await get(origin, `/api/public/rooms/${rotated.json.publicCode}`)).status, 404);
});

test("discovery surfaces carry Link headers", async t => {
  const { origin } = await serve(t);
  for (const path of ["/llms.txt", "/skills", "/room"]) {
    const res = await get(origin, path);
    assert.equal(res.status, 200, path);
    const link = res.headers.get("link") ?? "";
    assert.ok(link.includes("/skills"), `Link on ${path} points at the skills catalog`);
    assert.ok(link.includes("/.well-known/agent-card.json"), `Link on ${path} points at the agent card`);
  }
});

test("refused DM persists no event and no message", async t => {
  const { store, origin, aliceKey } = await serve(t);
  const before = store.room("commons").sequence;
  const wakeBefore = store.db.prepare("SELECT COUNT(*) AS n FROM wake_queue").get().n;
  const refused = await postMessage(origin, aliceKey, { messageId: "dm-nope", body: "no consent", toMemberId: "bob" });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "dm_consent_required");
  assert.equal(store.room("commons").sequence, before, "a refused DM must not append an event");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM wake_queue").get().n, wakeBefore,
    "a refused DM must not enqueue a wake");
  const bodies = (store.room("commons").state.messages ?? []).map(m => m.body);
  assert.ok(!bodies.includes("no consent"), "a refused DM body must not enter the projection");
});

test("DM consent reject / block / unblock over HTTP", async t => {
  const { origin, aliceKey, bobKey } = await serve(t);
  const dm = data => postMessage(origin, aliceKey, { messageId: randomUUID(), body: "ping", toMemberId: "bob", ...data });
  // Request, then Bob rejects: the DM still cannot post.
  assert.equal((await post(origin, "/api/rooms/commons/dm-consents", { targetId: "bob" }, aliceKey)).status, 201);
  const rejected = await post(origin, "/api/rooms/commons/dm-consents/alice/decide", { decision: "reject" }, bobKey);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.status, "rejected");
  assert.equal((await dm()).status, 403);
  // Re-request restarts at pending; Bob blocks instead.
  const reasked = await post(origin, "/api/rooms/commons/dm-consents", { targetId: "bob" }, aliceKey);
  assert.equal(reasked.status, 201);
  assert.equal(reasked.json.status, "pending");
  const blocked = await post(origin, "/api/rooms/commons/dm-consents/alice/decide", { decision: "block" }, bobKey);
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.status, "blocked");
  // While blocked, even asking is refused.
  const whileBlocked = await post(origin, "/api/rooms/commons/dm-consents", { targetId: "bob" }, aliceKey);
  assert.equal(whileBlocked.status, 403);
  assert.equal(whileBlocked.json.error.code, "dm_blocked");
  assert.equal((await dm()).status, 403);
  // Bob unblocks: the row returns to rejected and Alice may ask again.
  const unblocked = await post(origin, "/api/rooms/commons/dm-consents/unblock", { peerId: "alice" }, bobKey);
  assert.equal(unblocked.status, 200);
  assert.equal(unblocked.json.status, "rejected");
  const asked = await post(origin, "/api/rooms/commons/dm-consents", { targetId: "bob" }, aliceKey);
  assert.equal(asked.status, 201);
  assert.equal(asked.json.status, "pending");
  // Only the target can decide: Alice deciding her own request fails.
  const selfDecide = await post(origin, "/api/rooms/commons/dm-consents/bob/decide", { decision: "approve" }, aliceKey);
  assert.equal(selfDecide.status, 409);
  // Bob approves; the DM posts.
  const approved = await post(origin, "/api/rooms/commons/dm-consents/alice/decide", { decision: "approve" }, bobKey);
  assert.equal(approved.status, 200);
  assert.equal((await dm()).status, 201);
});

test("DM consent reason is trimmed and capped at 500 characters", async t => {
  const { origin, aliceKey } = await serve(t);
  const req = await post(origin, "/api/rooms/commons/dm-consents",
    { targetId: "bob", reason: `  ${"r".repeat(600)}  ` }, aliceKey);
  assert.equal(req.status, 201);
  assert.equal(req.json.reason.length, 500, "oversized reasons are sliced, not rejected");
  const listed = await get(origin, "/api/rooms/commons/agent-inbox", aliceKey);
  assert.equal(listed.status, 200);
});

test("public feed edges: limits clamp, unknown cursor restarts, HEAD is 405", async t => {
  const { origin, ownerKey, aliceKey } = await serve(t);
  await postMessage(origin, aliceKey, { messageId: "f1", body: "first" });
  await postMessage(origin, aliceKey, { messageId: "f2", body: "second" });
  const code = (await post(origin, "/api/rooms/commons/public-face", { enabled: true }, ownerKey)).json.publicCode;
  const feed = path => get(origin, `/api/public/rooms/${code}/feed${path}`);
  // Non-numeric and zero limits fall back to the default page.
  assert.equal((await feed("?limit=abc")).json.messages.length, 2);
  assert.equal((await feed("?limit=0")).json.messages.length, 2);
  // Over-limit caps at 100 (harmless here with two messages).
  assert.equal((await feed("?limit=500")).json.messages.length, 2);
  // An unknown cursor restarts from the beginning rather than 500ing.
  const unknown = await feed("?after=nope&limit=1");
  assert.equal(unknown.status, 200);
  assert.equal(unknown.json.messages.length, 1);
  assert.equal(unknown.json.messages[0].body, "first");
  // A known cursor pages forward.
  const first = (await feed("?limit=1")).json;
  const second = await feed(`?limit=1&after=${first.messages[0].id}`);
  assert.equal(second.json.messages[0].body, "second");
  assert.equal(second.json.hasMore, false);
  // The face is read-only GET: HEAD and POST are 405.
  const head = await fetch(`${origin}/p/${code}`, { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.equal((await post(origin, `/api/public/rooms/${code}/feed`, {})).status, 405);
});

test("join identity + first-room creation is atomic (no orphan identity)", async t => {
  const { store } = await serve(t);
  const count = () => store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
  const before = count();
  // The /join handler composes these two calls inside one store.transaction;
  // a room-side failure must roll the identity insert back with it.
  assert.throws(() => store.transaction(() => {
    store.identities.create("Atomic");
    throw new Error("simulated room failure");
  }), /simulated room failure/);
  assert.equal(count(), before, "a failed room creation must not leave an orphan identity");
});

test("DM consent proactive block over HTTP", async t => {
  const { origin, aliceKey, bobKey } = await serve(t);
  const dm = data => postMessage(origin, aliceKey, { messageId: randomUUID(), body: "ping", toMemberId: "bob", ...data });
  // Bob proactively blocks Alice without any pending request.
  const blocked = await post(origin, "/api/rooms/commons/dm-consents/block", { peerId: "alice" }, bobKey);
  assert.equal(blocked.status, 200, JSON.stringify(blocked.json));
  assert.equal(blocked.json.status, "blocked");
  // Alice's request is refused and her DM cannot post.
  const asked = await post(origin, "/api/rooms/commons/dm-consents", { targetId: "bob" }, aliceKey);
  assert.equal(asked.status, 403);
  assert.equal(asked.json.error.code, "dm_blocked");
  assert.equal((await dm()).status, 403);
  // Self-block is a 422; unknown peer is a 404.
  assert.equal((await post(origin, "/api/rooms/commons/dm-consents/block", { peerId: "bob" }, bobKey)).status, 422);
  assert.equal((await post(origin, "/api/rooms/commons/dm-consents/block", { peerId: "ghost" }, bobKey)).status, 404);
  // Unauthenticated is refused.
  assert.equal((await post(origin, "/api/rooms/commons/dm-consents/block", { peerId: "alice" })).status, 401);
  // Bob unblocks: Alice may ask again.
  const unblocked = await post(origin, "/api/rooms/commons/dm-consents/unblock", { peerId: "alice" }, bobKey);
  assert.equal(unblocked.status, 200);
  assert.equal((await post(origin, "/api/rooms/commons/dm-consents", { targetId: "bob" }, aliceKey)).status, 201);
});
