// QA2 finding P2-11: account deletion must not leave an ownerless room
// full of the deleted account's content. The HTTP confirm-then-delete
// routes are the contract: personal rooms are archived and purged, a
// shared room with another owner transfers, and a sole owner of a shared
// room with other members is refused with the room list.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

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

const post = (origin, path, data, cookie = null) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(data)
});
const get = (origin, path, cookie) => fetch(origin + path, { headers: cookie ? { Cookie: cookie } : {} });
const authedPost = (origin, path, data, creds) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie, "X-CSRF-Token": creds.csrf },
  body: JSON.stringify(data)
});

async function deletionAccount(t, n) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = `delete-rooms-${n}@example.invalid`;
  const slot = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/password/signup", {
    email, password: `fixture-password-${n}-long-enough`, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision
  });
  assert.equal(res.status, 202, await res.clone().text());
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  assert.ok(token, "signup sets a fresh account_session cookie");
  const session = f.store.authenticateAccountSession(token);
  f.store.accountLogins.markEmailVerified(session.account.id, email);
  return {
    f, origin, email, accountId: session.account.id, token, binding: session.sessionBinding,
    creds: { cookie: `account_session=${token}`, csrf: session.csrf }
  };
}

function createRoom(ctx, roomId, kind, title) {
  ctx.f.store.createAccountRoom(ctx.token, ctx.binding, {
    roomId, title, purpose: "Account deletion coverage", kind, displayName: "Owner"
  });
  const key = ctx.f.store.issueAccessKey(roomId, "owner");
  const send = (type, data) => ctx.f.store.command(key, roomId, { id: randomUUID(), type, data });
  return { key, send };
}

const SECRET = "secret-phrase-p2-11";

test("a solely owned personal room is archived and its messages and files are purged", async t => {
  const ctx = await deletionAccount(t, 1);
  const roomId = "solo-notes";
  const { key } = createRoom(ctx, roomId, "personal", "Solo notes");
  ctx.f.store.command(key, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "secret-note", body: SECRET } });
  ctx.f.store.roomAttachments.stage(key, roomId, {
    id: "secret-file", filename: "secret.txt", mediaType: "text/plain",
    data: Buffer.from("secret-bytes-p211").toString("base64")
  });
  // Distinct cleanup risk: private record-only rail notes and exact-retry
  // outputs must not survive personal-room account deletion.
  ctx.f.store.command(key,roomId,{id:randomUUID(),type:T.MEMBER_ADDED,data:{memberId:"rail-agent",displayName:"Rail agent",kind:"agent",permissions:["accept_work"]}});
  ctx.f.store.trialTasks.apply(roomId,"owner",{action:"create",requestId:"private-trial",taskId:"private-trial",candidateId:"rail-agent",buyerId:"owner",demigodReqId:"delete-room",title:SECRET,trialScope:{hoursMax:"1",deliverableShape:"other"},vettingRubric:[{criterion:"c1",weightBps:"10000"}],feePolicyRef:"record-only",budgetRecord:{note:SECRET}});
  const audit = ctx.f.store.db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM account_access_events WHERE account_id=?").get(ctx.accountId);
  ctx.f.store.db.prepare("INSERT INTO account_access_events(account_id,revision,active,auth_epoch,reason,at) VALUES(?,?,?,?,?,?)")
    .run(ctx.accountId, audit.revision + 1, 1, 0, "deletion-audit", Date.now());
  const auditBefore = ctx.f.store.db.prepare("SELECT count(*) AS n FROM account_access_events WHERE account_id=?").get(ctx.accountId).n;

  const planned = await (await get(ctx.origin, "/api/account/deletion/plan", ctx.creds.cookie)).json();
  assert.match(planned.summary.text, /Personal rooms archived and purged: Solo notes \(solo-notes\)/);
  assert.match(planned.summary.text, /Retention categories purged:.*personal_room_content/);
  assert.match(planned.summary.text, /Retention categories retained: audit, inbox_receipts, abuse_reports, unpublish_records, profile_tombstone, room_history/);
  const res = await authedPost(ctx.origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, ctx.creds);
  assert.equal(res.status, 200, await res.clone().text());
  const receipt = await res.json();
  assert.ok(receipt.receipt.retained.some(row => row.category === "audit"));

  const room = ctx.f.store.room(roomId);
  assert.equal(typeof room.state.room.archivedAt, "string");
  assert.equal(room.state.messages.find(message => message.id === "secret-note").body, null);
  const logged = ctx.f.store.db.prepare("SELECT body FROM events WHERE room_id=?").all(roomId).map(row => row.body).join("\n");
  const projection = ctx.f.store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection;
  assert.equal(logged.includes(SECRET), false);
  assert.equal(projection.includes(SECRET), false);
  const file = ctx.f.store.db.prepare("SELECT state, bytes, filename FROM room_attachments WHERE room_id=? AND id=?").get(roomId, "secret-file");
  assert.equal(file.state, "deleted");
  assert.equal(file.bytes, null);
  assert.equal(file.filename, "purged");
  assert.equal(ctx.f.store.account(ctx.accountId).active, false);
  assert.equal(ctx.f.store.db.prepare("SELECT count(*) AS n FROM account_access_events WHERE account_id=?").get(ctx.accountId).n, auditBefore);

  ctx.f.store.db.prepare("DELETE FROM projection_checkpoints WHERE room_id=?").run(roomId);
  const rebuilt = ctx.f.store.rebuildProjection(roomId);
  assert.equal(rebuilt.state.room.archivedAt, room.state.room.archivedAt);
  assert.equal(rebuilt.state.messages.find(message => message.id === "secret-note").body, null);
  for(const table of ["room_trial_tasks","room_trial_requests","room_vetting_keys","room_vetting_receipts","demigod_offer_profiles","demigod_offer_requests","demigod_contracts","demigod_contract_requests","buyer_signoff_loops","buyer_signoff_requests"]) assert.equal(ctx.f.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE room_id=?`).get(roomId).n,0,`${table} personal data purged`);
});

test("a shared room with another owner transfers and the account is deleted", async t => {
  const ctx = await deletionAccount(t, 2);
  const roomId = "shared-with-partner";
  const { send } = createRoom(ctx, roomId, "organization", "Shared project");
  send(T.MEMBER_ADDED, { memberId: "partner", displayName: "Partner", kind: "human", permissions: ["accept_work"] });
  send(T.MESSAGE_POSTED, { messageId: "kept-note", body: "keep-this-history" });
  const partnerId = "partner-account";
  ctx.f.store.createAccount(partnerId);
  ctx.f.store.bindHumanAccount(roomId, "partner", partnerId);

  const planned = await (await get(ctx.origin, "/api/account/deletion/plan", ctx.creds.cookie)).json();
  assert.match(planned.summary.text, /Shared rooms kept with another owner: Shared project \(shared-with-partner\)/);
  const res = await authedPost(ctx.origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, ctx.creds);
  assert.equal(res.status, 200, await res.clone().text());

  const state = ctx.f.store.room(roomId).state;
  assert.equal(state.room.ownerId, "partner");
  assert.equal(state.room.archivedAt, undefined);
  assert.equal(state.messages.find(message => message.id === "kept-note").body, "keep-this-history");
  assert.equal(ctx.f.store.account(ctx.accountId).active, false);
  assert.equal(ctx.f.store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE account_id=?").get(ctx.accountId).n, 0);
  assert.equal(ctx.f.store.accountForMember(roomId, "partner").id, partnerId);
});

test("the sole owner of a shared room with other members is refused and listed", async t => {
  const ctx = await deletionAccount(t, 3);
  const roomId = "solo-shared";
  const { send } = createRoom(ctx, roomId, "organization", "Shared project");
  send(T.MEMBER_ADDED, { memberId: "helper", displayName: "Helper", kind: "agent", permissions: ["accept_work"], accountableHumanId: "owner" });
  send(T.MESSAGE_POSTED, { messageId: "live-note", body: "still-here" });

  const planRes = await get(ctx.origin, "/api/account/deletion/plan", ctx.creds.cookie);
  assert.equal(planRes.status, 200);
  const planned = await planRes.json();
  assert.ok(planned.plan.rooms.blocked.some(room => room.id === roomId && room.title === "Shared project"));
  assert.match(planned.summary.text, /Shared rooms blocking deletion until ownership is transferred: Shared project \(solo-shared\)/);

  const res = await authedPost(ctx.origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, ctx.creds);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "transfer_ownership_required");
  assert.ok(body.rooms.some(room => room.id === roomId && room.title === "Shared project"));
  assert.equal(ctx.f.store.account(ctx.accountId).active, true);
  assert.equal(ctx.f.store.room(roomId).state.room.ownerId, "owner");
  assert.equal(ctx.f.store.room(roomId).state.messages.find(message => message.id === "live-note").body, "still-here");
  assert.equal(ctx.f.store.db.prepare("SELECT count(*) AS n FROM account_credentials WHERE account_id=?").get(ctx.accountId).n > 0, true);
});

test("the confirmation token covers room contents, so a later message requires a fresh plan", async t => {
  const ctx = await deletionAccount(t, 4);
  const roomId = "token-notes";
  const { key } = createRoom(ctx, roomId, "personal", "Token notes");
  ctx.f.store.command(key, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "first-note", body: "before-confirm" } });
  const planned = await (await get(ctx.origin, "/api/account/deletion/plan", ctx.creds.cookie)).json();
  ctx.f.store.command(key, roomId, { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "later-note", body: "after-confirm" } });

  const stale = await authedPost(ctx.origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, ctx.creds);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "plan_changed");
  assert.equal(ctx.f.store.account(ctx.accountId).active, true);
  assert.equal(ctx.f.store.room(roomId).state.messages.find(message => message.id === "later-note").body, "after-confirm");

  const fresh = await (await get(ctx.origin, "/api/account/deletion/plan", ctx.creds.cookie)).json();
  const done = await authedPost(ctx.origin, "/api/account/delete", { confirmationToken: fresh.confirmationToken }, ctx.creds);
  assert.equal(done.status, 200, await done.clone().text());
  const messages = ctx.f.store.room(roomId).state.messages;
  assert.equal(messages.find(message => message.id === "later-note").body, null);
  assert.equal(messages.find(message => message.id === "first-note").body, null);
});
