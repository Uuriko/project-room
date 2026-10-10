// Auth audit 2026-10-09, path 16: an account that never chose a name joins its
// first room as the placeholder "Owner", so friends opening its invite read
// "Owner invited you." The preview now drops the placeholder (the dialog hides
// the line); a chosen name, even "Owner", is kept.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRoomServer } from "../server/http.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

async function inviterFor(t, profileName) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const accountId = `acct-${randomUUID()}`;
  f.store.createAccount(accountId);
  if (profileName !== undefined) f.store.db.prepare("UPDATE accounts SET display_name=? WHERE id=?").run(profileName, accountId);
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(accountId), 0);
  const made = await fetch(`${origin}/api/account/ensure-default-room`, { method: "POST",
    headers: { Cookie: `account_session=${slot.token}`, "X-Session-Binding": session.sessionBinding, "X-CSRF-Token": session.csrf, Origin: origin, "content-type": "application/json" }, body: "{}" });
  assert.equal(made.status, 201, await made.clone().text());
  const roomId = (await made.json()).room.id;
  const memberId = f.store.db.prepare("SELECT member_id FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, accountId).member_id;
  const key = f.store.issueAccessKey(roomId, memberId);
  const linkToken = randomBytes(32).toString("base64url");
  const revision = f.store.room(roomId).state.memberRevision ?? 0;
  f.store.shareLinks.create(key, roomId, { requestId: randomUUID(), linkToken, expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: revision }, null);
  return { roomName: f.store.room(roomId).state.members[memberId].displayName, preview: f.store.shareLinks.preview(linkToken) };
}

test("an unnamed account's invite doesn't say \"Owner invited you\"", async t => {
  const { roomName, preview } = await inviterFor(t);
  assert.equal(roomName, "Owner", "the room-side placeholder is unchanged");
  assert.equal(preview.inviterDisplayName, null);
});

test("a chosen name is kept, even one that happens to be Owner", async t => {
  assert.equal((await inviterFor(t, "Ana")).preview.inviterDisplayName, "Ana");
  assert.equal((await inviterFor(t, "Owner")).preview.inviterDisplayName, "Owner");
});
