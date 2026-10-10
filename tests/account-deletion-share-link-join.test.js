// rb-account-delete-500: a signed-in account that joined a room through a
// share link must be deletable. The join writes a share_link_joins row whose
// slot_hash FK-references account_session_slots(hash), and join history is
// deliberately retained (share_link_joins_no_delete) — so the sessions purge
// step must not try to delete FK-referenced slots. Reproduces the runbook:
// signup, open a #join/ link while signed in, Join room, delete account.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, data, headers = {}) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...headers },
  body: JSON.stringify(data),
});
const get = (origin, path, cookie) => fetch(origin + path, { headers: cookie ? { Cookie: cookie } : {} });

async function signup(t, f, origin, email, n) {
  const slot = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/password/signup", {
    email, password: `fixture-password-${n}-long-enough`,
    sessionToken: slot.token, sessionRevision: slot.session.sessionRevision,
  });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(token, "signup sets an account_session cookie");
  const session = f.store.authenticateAccountSession(token);
  f.store.accountLogins.markEmailVerified(session.account.id, email);
  const fresh = f.store.accountSessionSlot(token);
  return {
    accountId: session.account.id, token,
    cookie: `account_session=${token}`,
    csrf: session.csrf,
    binding: fresh.sessionBinding,
    sessionRevision: fresh.sessionRevision,
  };
}

test("share-link-joined account deletes without a 500", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);

  const owner = await signup(t, f, origin, "link-owner@example.invalid", 1);
  f.store.createAccountRoom(owner.token, owner.binding, {
    roomId: "link-room", title: "Link room", purpose: "rb-account-delete-500",
    kind: "organization", displayName: "Owner",
  });
  const ownerKey = f.store.issueAccessKey("link-room", "owner");
  const linkToken = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(ownerKey, "link-room", {
    requestId: randomUUID(), linkToken,
    expiresAt: Date.now() + 3600000, maxJoins: 5, expectedMemberRevision: 0,
  }, null);

  const joiner = await signup(t, f, origin, "link-joiner@example.invalid", 2);
  const joinRes = await post(origin, "/api/share-links/join", {
    linkToken, displayName: "Joiner", redemptionId: randomUUID(),
    expectedSessionRevision: joiner.sessionRevision,
  }, { Cookie: joiner.cookie, "X-CSRF-Token": joiner.csrf, "X-Session-Binding": joiner.binding });
  assert.equal(joinRes.status, 201, await joinRes.clone().text());
  const joinRow = f.store.db.prepare("SELECT slot_hash FROM share_link_joins").get();
  assert.ok(joinRow, "the join wrote a retained share_link_joins row");

  const planRes = await get(origin, "/api/account/deletion/plan", joiner.cookie);
  assert.equal(planRes.status, 200, await planRes.clone().text());
  const planned = await planRes.json();
  const delRes = await post(origin, "/api/account/delete",
    { confirmationToken: planned.confirmationToken },
    { Cookie: joiner.cookie, "X-CSRF-Token": joiner.csrf });
  assert.equal(delRes.status, 200, await delRes.clone().text());

  const receipt = await delRes.json();
  assert.equal(receipt.deleted, true);
  // Join history is retained by design; the account itself is deactivated.
  assert.ok(f.store.db.prepare("SELECT 1 FROM share_link_joins").get(), "join history retained");
  const account = f.store.db.prepare("SELECT active FROM accounts WHERE id=?").get(joiner.accountId);
  assert.equal(account.active, 0, "account deactivated");
  // The FK-retained session slot is inert: the auth_epoch bump retires it.
  assert.throws(() => f.store.authenticateAccountSession(joiner.token), { status: 401 },
    "residual join-linked session slot cannot authenticate after deletion");
});
