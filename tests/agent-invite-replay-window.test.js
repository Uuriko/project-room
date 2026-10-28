// #3883 (coordinator decision on the issue, 2026-10-17): the credential-less
// replay rotation (R305-1) is bounded in time. A redemption receipt may
// rotate the identity's secret only within 30 days of the receipt's
// created_at; after the window the credential-less replay refuses with a
// sponsor-actionable 410 and rotates nothing. The boundary is INCLUSIVE:
// a replay landing exactly 30 days after redemption still rotates.
// Credential-presenting replays never rotate and are untouched by the gate.
// A receipt whose created_at is unusable fails closed on the rotation path
// only — the credential-presenting replay of the same receipt still works.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const ROOM = "commons";
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-invite-replay-window-"));
  let clock = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom(ROOM));
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token) => {
    const res = await fetch(`${origin}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { store, origin, ownerKey, post, advance: ms => { clock += ms; } };
}

// Mint + redeem once with a requestId; returns everything a replay needs.
function redeemOnce(store, ownerKey, name = "Window Bot") {
  const minted = store.invites.create(ownerKey, ROOM, { permissions: ["accept_work", "complete_work"], displayName: name }, null);
  const requestId = randomUUID();
  const first = store.invites.redeem(minted.code, { displayName: name, requestId });
  assert.ok(first.identitySecret, "the first redemption shows the minted secret once");
  assert.equal(first.duplicate, undefined);
  return { code: minted.code, requestId, name, identityId: first.identityId, secret: first.identitySecret };
}

const replay = (store, { code, requestId, name }, extra = {}) =>
  store.invites.redeem(code, { displayName: name, requestId, ...extra });

test("replay inside the 30-day window rotates exactly as before", async t => {
  const { store, ownerKey, advance } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  advance(29 * DAY_MS);
  const again = replay(store, ctx);
  assert.equal(again.duplicate, true);
  assert.equal(again.identityId, ctx.identityId);
  assert.ok(again.identitySecret, "inside the window the replay still shows a fresh secret");
  assert.notEqual(again.identitySecret, ctx.secret);
  assert.equal(store.identities.resolveGlobalIdentitySecret(ctx.secret), null, "the lost secret is retired by the rotation");
  assert.equal(store.identities.resolveGlobalIdentitySecret(again.identitySecret)?.identityId, ctx.identityId);
});

test("boundary: a replay exactly 30 days after redemption still rotates (inclusive)", async t => {
  const { store, ownerKey, advance } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  advance(WINDOW_MS);
  const again = replay(store, ctx);
  assert.equal(again.duplicate, true);
  assert.ok(again.identitySecret, "the boundary is inclusive: exactly 30 days out still rotates");
  assert.notEqual(again.identitySecret, ctx.secret);
});

test("replay after the window refuses with a sponsor-actionable error and rotates nothing", async t => {
  const { store, ownerKey, advance } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  advance(31 * DAY_MS);
  assert.throws(() => replay(store, ctx), error => {
    assert.equal(error.status, 410);
    assert.equal(error.code, "invite_replay_rotation_expired");
    assert.match(error.message, /sponsor|inviter/i, "the refusal names the sponsor as the actor");
    assert.match(error.message, /fresh invite/i, "the refusal names the re-mint path");
    return true;
  });
  // Nothing rotated: the identity's live secret is still the original one,
  // and a repeated credential-less replay refuses the same way.
  assert.equal(store.identities.resolveGlobalIdentitySecret(ctx.secret)?.identityId, ctx.identityId,
    "the refused replay must not rotate the live secret");
  assert.throws(() => replay(store, ctx), { status: 410, code: "invite_replay_rotation_expired" });
});

test("the refusal surfaces on the HTTP redeem door with the same code", async t => {
  const { store, ownerKey, post, advance } = await serve(t);
  const minted = store.invites.create(ownerKey, ROOM, { permissions: ["accept_work", "complete_work"], displayName: "Door Bot" }, null);
  const requestId = randomUUID();
  const first = await post("/api/agent-invites/redeem", { code: minted.code, displayName: "Door Bot", requestId });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  advance(31 * DAY_MS);
  const refused = await post("/api/agent-invites/redeem", { code: minted.code, displayName: "Door Bot", requestId });
  assert.equal(refused.status, 410, JSON.stringify(refused.json));
  assert.equal(refused.json.error.code, "invite_replay_rotation_expired");
  assert.match(refused.json.error.message, /fresh invite/i);
  // The live secret survived the refused HTTP replay.
  assert.equal(store.identities.resolveGlobalIdentitySecret(first.json.identitySecret)?.identityId, first.json.identityId);
});

test("the refusal surfaces on the /api/join invite branch with the same code", async t => {
  const { store, ownerKey, post, advance } = await serve(t);
  const minted = store.invites.create(ownerKey, ROOM, { permissions: ["accept_work", "complete_work"], displayName: "Join Bot" }, null);
  const body = { displayName: "Join Bot", inviteCode: minted.code, requestId: "join-window-0001" };
  const first = await post("/api/join", body);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  advance(31 * DAY_MS);
  const refused = await post("/api/join", body);
  assert.equal(refused.status, 410, JSON.stringify(refused.json));
  assert.equal(refused.json.error.code, "invite_replay_rotation_expired");
  assert.equal(store.identities.resolveGlobalIdentitySecret(first.json.identitySecret)?.identityId, first.json.identityId,
    "the refused join replay rotated nothing");
});

test("credential-presenting replay after the window is unchanged: no gate, no rotation", async t => {
  const { store, ownerKey, advance } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  advance(31 * DAY_MS);
  const again = replay(store, ctx, { identitySecret: ctx.secret });
  assert.equal(again.duplicate, true);
  assert.equal(again.identityId, ctx.identityId);
  assert.equal(again.identitySecret, undefined, "a credential-presenting replay never receives a rotated secret");
  assert.equal(store.identities.resolveGlobalIdentitySecret(ctx.secret)?.identityId, ctx.identityId,
    "the presented credential stays live");
});

test("a receipt with an unusable created_at fails closed on the rotation path only", async t => {
  const { store, ownerKey } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  store.db.prepare("UPDATE agent_invite_redeem_receipts SET created_at=? WHERE request_id=?")
    .run("not-a-timestamp", ctx.requestId);
  // Credential-less replay: the rotation path fails closed, nothing rotates.
  assert.throws(() => replay(store, ctx), { status: 410, code: "invite_replay_rotation_expired" });
  assert.equal(store.identities.resolveGlobalIdentitySecret(ctx.secret)?.identityId, ctx.identityId);
  // The same receipt still serves an ordinary credential-presenting replay:
  // the fail-closed gate is on the rotation path only.
  const again = replay(store, ctx, { identitySecret: ctx.secret });
  assert.equal(again.duplicate, true);
  assert.equal(again.identitySecret, undefined);
});
