// #3380: POST /api/join's invite branch minted the identity server-side and
// returned only the 30-day room-scoped rak_ token (aliased as
// identitySecret). The identity's durable pri_ secret was never shown, so
// when the token expired the membership stranded: pack/claim 401'd, the
// burned code 410'd, and rejoining under the agent's own name 422'd — the
// only way back was a new identity under a new name (W3 hostile cold-start
// S6 leg A). The fix follows the redeem door's surviving pattern: the join
// response shows the minted identity's secret ONCE (hash-only storage makes
// join time the only moment it can ever be shown), and recovery is a re-run
// of the join with the original code + that secret as Bearer — redeem's
// already-redeemed-by-this-identity path returns duplicate:true with a
// fresh room token, same member record, same display name, no new invite.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createTestClock } from "./helpers/test-clock.mjs";

const DAY = 86_400_000;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-recovery-"));
  const clock = createTestClock();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: clock.now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, clock, origin: `http://127.0.0.1:${server.address().port}`, ownerKey };
}

async function call(origin, method, path, body, token) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const post = (origin, path, body, token) => call(origin, "POST", path, body, token);
const get = (origin, path, token) => call(origin, "GET", path, undefined, token);
const mint = (origin, ownerKey) =>
  post(origin, "/api/rooms/commons/agent-invites", { profile: "collaborate", expiresInMinutes: 60 }, ownerKey);
const memberCount = (store, roomId) =>
  store.db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE room_id = ?").get(roomId).n;

test("an invite join returns the durable identity secret once, distinct from the room token", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const joined = await post(origin, "/api/join", { displayName: "Durable Bot", inviteCode: minted.json.code });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  assert.match(joined.json.roomToken, /^rak_/, "the room-scoped token is issued as before");
  assert.match(joined.json.identitySecret, /^pri_/, "identitySecret is now the identity's real durable secret");
  assert.notEqual(joined.json.identitySecret, joined.json.roomToken, "the secret is not the token under an alias");
  // The secret resolves the identity on identity-wide routes that refuse
  // the room token outright.
  const rooms = await get(origin, "/api/agent-rooms", joined.json.identitySecret);
  assert.equal(rooms.status, 200, JSON.stringify(rooms.json));
  assert.ok(rooms.json.rooms.some(room => room.roomId === "commons" && room.memberId === joined.json.memberId));
  const refused = await get(origin, "/api/agent-rooms", joined.json.roomToken);
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error.code, "room_token_not_identity");
  // The refusal now names the credential to present instead of claiming
  // invite joins never reveal one.
  assert.match(refused.json.error.message, /shown once in your join response/);
  assert.doesNotMatch(refused.json.error.message, /do not reveal/);
});

test("day 30: the expired room token 401s with recovery teaching; the identity secret still works", async t => {
  const { origin, ownerKey, clock, store } = await serve(t);
  const seeded = await post(origin, "/api/rooms/commons/work-claims", { id: "nx1-task", title: "First claim" }, ownerKey);
  assert.equal(seeded.status, 201, JSON.stringify(seeded.json));
  const minted = await mint(origin, ownerKey);
  const joined = await post(origin, "/api/join", { displayName: "Stranded Bot", inviteCode: minted.json.code });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  const { roomToken, identitySecret } = joined.json;
  // Pre-expiry control: the room token reads the pack.
  const packBefore = await get(origin, "/api/rooms/commons/activation-pack", roomToken);
  assert.equal(packBefore.status, 200, JSON.stringify(packBefore.json));
  // The designed death of the only credential the old join handed out.
  clock.advance(31 * DAY);
  const packAfter = await get(origin, "/api/rooms/commons/activation-pack", roomToken);
  assert.equal(packAfter.status, 401, JSON.stringify(packAfter.json));
  assert.equal(packAfter.json.error.code, "unauthenticated");
  // Decision #28: the error teaches the recovery in hint/next, not only
  // "keep your saved connection".
  const guidance = `${packAfter.json.hint ?? ""} ${JSON.stringify(packAfter.json.next ?? [])}`;
  assert.match(guidance, /identitySecret/, "the guidance names the durable credential");
  assert.match(guidance, /original inviteCode/, "the guidance names the fresh-token recovery");
  assert.match(guidance, /Never mint a replacement identity/, "the guidance forbids the abandonment path");
  // The identity secret never expired: pack and a first claim both work.
  const packSecret = await get(origin, "/api/rooms/commons/activation-pack", identitySecret);
  assert.equal(packSecret.status, 200, JSON.stringify(packSecret.json));
  const claim = await post(origin, "/api/rooms/commons/work-claims/nx1-task/claim", {}, identitySecret);
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  assert.equal(memberCount(store, "commons"), 1, "no replacement membership was created");
});

test("recovery: re-join with the original expired code + identity secret returns a fresh room token, same membership", async t => {
  const { origin, ownerKey, clock, store } = await serve(t);
  const minted = await mint(origin, ownerKey);
  const code = minted.json.code;
  const joined = await post(origin, "/api/join", { displayName: "Recovering Bot", inviteCode: code });
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  const { identitySecret, roomToken: deadToken, identityId, memberId } = joined.json;
  clock.advance(31 * DAY);
  // W3 S6's dead ends, re-run against the fix: anonymous re-presentation of
  // the burned, aged-out code still refuses (410) — the code alone is not
  // the recovery key.
  const anonymous = await post(origin, "/api/join", { displayName: "Recovering Bot", inviteCode: code });
  assert.equal(anonymous.status, 410, JSON.stringify(anonymous.json));
  assert.equal(anonymous.json.error.code, "invite_expired");
  // A different identity's secret does not unlock someone else's recovery.
  const stranger = store.identities.create("Stranger Bot");
  const hijack = await post(origin, "/api/join", { displayName: "Recovering Bot", inviteCode: code }, stranger.secret);
  assert.equal(hijack.status, 410, JSON.stringify(hijack.json));
  assert.equal(hijack.json.error.code, "invite_expired");
  // The recovery itself, through both doors: same identity, same member,
  // same display name, fresh room token, no new invite.
  const viaRedeem = await post(origin, "/api/agent-invites/redeem", { code, displayName: "Recovering Bot" }, identitySecret);
  assert.equal(viaRedeem.status, 201, JSON.stringify(viaRedeem.json));
  assert.equal(viaRedeem.json.duplicate, true);
  assert.equal(viaRedeem.json.identityId, identityId);
  assert.equal(viaRedeem.json.memberId, memberId);
  assert.ok(viaRedeem.json.mcpToken.credential.startsWith("rak_"));
  assert.notEqual(viaRedeem.json.mcpToken.credential, deadToken);
  const viaJoin = await post(origin, "/api/join", { displayName: "Recovering Bot", inviteCode: code }, identitySecret);
  assert.equal(viaJoin.status, 201, JSON.stringify(viaJoin.json));
  assert.equal(viaJoin.json.duplicate, true);
  assert.equal(viaJoin.json.identityId, identityId);
  assert.equal(viaJoin.json.memberId, memberId);
  assert.equal(viaJoin.json.displayName, "Recovering Bot", "the member keeps its name — no rename, no 422");
  assert.ok(!("identitySecret" in viaJoin.json), "a presented credential is never echoed back");
  const pack = await get(origin, "/api/rooms/commons/activation-pack", viaJoin.json.roomToken);
  assert.equal(pack.status, 200, "the fresh room token works");
  assert.equal(memberCount(store, "commons"), 1, "recovery created no second membership");
});

test("the redeem door shows the minted secret once; the requestId replay cannot re-reveal it", async t => {
  const { origin, ownerKey } = await serve(t);
  const minted = await mint(origin, ownerKey);
  const redeemed = await post(origin, "/api/agent-invites/redeem", { code: minted.json.code, displayName: "Redeem Bot" });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  assert.match(redeemed.json.identitySecret, /^pri_/, "the sibling door's server-minted fallback reveals the secret the same way");
  const rooms = await get(origin, "/api/agent-rooms", redeemed.json.identitySecret);
  assert.equal(rooms.status, 200, JSON.stringify(rooms.json));
  // #3260's journal under the new shape: the first join carries the secret;
  // the replay returns the same membership with a fresh room token but no
  // secret — shown once means once (it is stored hash-only).
  const minted2 = await mint(origin, ownerKey);
  const body = { displayName: "Journal Bot", inviteCode: minted2.json.code, requestId: "join-recovery-0001" };
  const first = await post(origin, "/api/join", body);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.match(first.json.identitySecret, /^pri_/);
  const replay = await post(origin, "/api/join", body);
  assert.equal(replay.status, 201, JSON.stringify(replay.json));
  assert.equal(replay.json.duplicate, true);
  assert.equal(replay.json.identityId, first.json.identityId);
  assert.ok(!("identitySecret" in replay.json), "the replay does not re-reveal the shown-once secret");
  assert.match(replay.json.roomToken, /^rak_/, "the replay still recovers the working room credential");
});

test("a caller that presents its own identity secret is never echoed one", async t => {
  const { origin, ownerKey, store } = await serve(t);
  const minted = await mint(origin, ownerKey);
  const identity = store.identities.create("Presenting Bot");
  const joined = await post(origin, "/api/join", { displayName: "Presenting Bot", inviteCode: minted.json.code }, identity.secret);
  assert.equal(joined.status, 201, JSON.stringify(joined.json));
  assert.equal(joined.json.identityId, identity.identityId);
  assert.ok(!("identitySecret" in joined.json), "nothing new was minted, so nothing is revealed or echoed");
  assert.match(joined.json.roomToken, /^rak_/);
  const next = joined.json.next.join("\n");
  assert.match(next, /identity secret remains your durable credential/);
  assert.match(next, /original inviteCode/, "the recovery is taught on this branch too");
});
