// #3949: the credential-less replay rotation (R305-1) is one-shot per
// redemption receipt. The R305-1 rationale — "the original secret died in
// that lost response, so retiring it strands nobody" — holds only for the
// FIRST credential-less replay: that replay delivers a fresh secret, and
// its holder is from then on the legitimate holder. A second
// credential-less replay (code + requestId only) must refuse: rotating
// again would retire the delivered secret, revoke the identity's scoped
// API keys, and hand full identity possession to anyone who captured the
// burned code + requestId pair. QA-WAVE-B repro (issue #3949), inverted:
// redeem -> replay rotates to S1 -> second credential-less replay is
// refused 410 invite_replay_rotation_used, S1 stays live, and a
// credential-presenting replay with S1 still succeeds.
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

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-invite-replay-one-shot-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
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
  return { store, origin, ownerKey, post };
}

function redeemOnce(store, ownerKey, name = "One Shot Bot") {
  const minted = store.invites.create(ownerKey, ROOM, { permissions: ["accept_work", "complete_work"], displayName: name }, null);
  const requestId = randomUUID();
  const first = store.invites.redeem(minted.code, { displayName: name, requestId });
  assert.ok(first.identitySecret, "the first redemption shows the minted secret once");
  assert.equal(first.duplicate, undefined);
  return { code: minted.code, requestId, name, identityId: first.identityId, secret: first.identitySecret };
}

const replay = (store, { code, requestId, name }, extra = {}) =>
  store.invites.redeem(code, { displayName: name, requestId, ...extra });

test("the first credential-less replay still rotates and records the rotation on the receipt", async t => {
  const { store, ownerKey } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  const again = replay(store, ctx);
  assert.equal(again.duplicate, true);
  assert.ok(again.identitySecret, "the first credential-less replay still delivers a fresh secret");
  assert.notEqual(again.identitySecret, ctx.secret);
  assert.equal(store.identities.resolveGlobalIdentitySecret(ctx.secret), null, "the lost secret is retired by the rotation");
  assert.equal(store.identities.resolveGlobalIdentitySecret(again.identitySecret)?.identityId, ctx.identityId);
  const receipt = store.db.prepare("SELECT rotated_at FROM agent_invite_redeem_receipts WHERE request_id=?").get(ctx.requestId);
  assert.ok(receipt.rotated_at != null, "the rotation is recorded on the receipt");
});

test("a second credential-less replay refuses, rotates nothing, and the delivered secret stays live", async t => {
  const { store, ownerKey } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  const first = replay(store, ctx);
  const delivered = first.identitySecret;
  assert.ok(delivered, "the first replay delivered the rotated secret");

  let revocations = 0;
  const plugin = store.agentPlugin;
  const originalRevoke = plugin?.revokeApiKeysForIdentity?.bind(plugin);
  if (plugin && originalRevoke) plugin.revokeApiKeysForIdentity = (...args) => { revocations += 1; return originalRevoke(...args); };

  assert.throws(() => replay(store, ctx), error => {
    assert.equal(error.status, 410);
    assert.equal(error.code, "invite_replay_rotation_used");
    assert.match(error.message, /inviter/i, "the refusal names the sponsor remedy");
    assert.match(error.message, /fresh invite/i, "the refusal names the re-mint path");
    assert.match(error.message, /presenting the current identity secret/i, "the refusal names the holder's own remedy");
    return true;
  });
  assert.equal(revocations, 0, "the refused replay revokes no scoped API keys");
  // The lockout from the QA repro is inverted: the delivered secret still
  // authenticates, and its holder can still replay by presenting it.
  assert.equal(store.identities.resolveGlobalIdentitySecret(delivered)?.identityId, ctx.identityId,
    "the delivered secret survives the refused replay");
  const presented = replay(store, ctx, { identitySecret: delivered });
  assert.equal(presented.duplicate, true);
  assert.equal(presented.identitySecret, undefined, "a credential-presenting replay never receives a rotated secret");
  // A third credential-less attempt refuses the same way (no state drift).
  assert.throws(() => replay(store, ctx), { status: 410, code: "invite_replay_rotation_used" });
  assert.equal(store.identities.resolveGlobalIdentitySecret(delivered)?.identityId, ctx.identityId);
});

test("a credential-presenting replay does not consume the one-shot rotation", async t => {
  const { store, ownerKey } = await serve(t);
  const ctx = redeemOnce(store, ownerKey);
  const presented = replay(store, ctx, { identitySecret: ctx.secret });
  assert.equal(presented.duplicate, true);
  assert.equal(presented.identitySecret, undefined);
  const receipt = store.db.prepare("SELECT rotated_at FROM agent_invite_redeem_receipts WHERE request_id=?").get(ctx.requestId);
  assert.equal(receipt.rotated_at, null, "presenting a credential records no rotation");
  // The lost-response recovery is still there when it is actually needed.
  const rotated = replay(store, ctx);
  assert.ok(rotated.identitySecret, "the first credential-less replay still rotates after a credential-presenting one");
  assert.notEqual(rotated.identitySecret, ctx.secret);
});

test("the one-shot refusal surfaces on the HTTP redeem door with the same code", async t => {
  const { store, ownerKey, post } = await serve(t);
  const minted = store.invites.create(ownerKey, ROOM, { permissions: ["accept_work", "complete_work"], displayName: "Door Bot" }, null);
  const requestId = randomUUID();
  const first = await post("/api/agent-invites/redeem", { code: minted.code, displayName: "Door Bot", requestId });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const replayed = await post("/api/agent-invites/redeem", { code: minted.code, displayName: "Door Bot", requestId });
  assert.equal(replayed.status, 201, JSON.stringify(replayed.json));
  assert.ok(replayed.json.identitySecret, "the first HTTP replay rotates and delivers");
  const refused = await post("/api/agent-invites/redeem", { code: minted.code, displayName: "Door Bot", requestId });
  assert.equal(refused.status, 410, JSON.stringify(refused.json));
  assert.equal(refused.json.error.code, "invite_replay_rotation_used");
  assert.equal(refused.json.identitySecret, undefined, "the refusal hands out no secret");
  assert.equal(store.identities.resolveGlobalIdentitySecret(replayed.json.identitySecret)?.identityId, first.json.identityId,
    "the delivered secret survives the refused HTTP replay");
});
