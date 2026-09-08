import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

const token = () => randomBytes(32).toString("base64url");
const redemption = () => crypto.randomUUID();
const digest = value => createHash("sha256").update(value).digest("hex");

function accountSession(store, accountId) {
  const accessKey = store.issueAccountAccessKey(accountId);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, accessKey, slot.session.sessionRevision);
  return { accessKey, token: slot.token, session };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-invitations-"));
  const filename = join(directory, "room.sqlite");
  let now = Date.now();
  const store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom());
  const ownerRoomKey = store.issueAccessKey("commons", "owner");
  const ownerAccountId = store.authenticate(ownerRoomKey).account.id;
  const owner = accountSession(store, ownerAccountId);
  store.createAccount("account-target");
  const target = accountSession(store, "account-target");
  store.createAccount("account-other");
  const other = accountSession(store, "account-other");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, filename, ownerRoomKey, ownerAccountId, owner, target, other, now: () => now, setNow: value => { now = value; } };
}

function invitation(f, overrides = {}) {
  const rawToken = overrides.token ?? token();
  const details = {
    requestId: overrides.requestId ?? `request-${randomBytes(8).toString("hex")}`,
    token: rawToken,
    intendedAccountId: overrides.intendedAccountId ?? "account-target",
    intendedMemberId: overrides.intendedMemberId ?? "target-member",
    displayName: overrides.displayName ?? "Target human",
    role: overrides.role ?? "member",
    expiresAt: overrides.expiresAt ?? f.now() + 3600000,
    expectedIssuerMemberRevision: overrides.expectedIssuerMemberRevision ?? f.store.room("commons").state.members.owner.revision,
    expectedSessionBinding: overrides.expectedSessionBinding ?? f.owner.session.sessionBinding
  };
  const result = f.store.issueInvitation(f.owner.token, "commons", details);
  return { rawToken, details, result };
}

function runStoreProcess(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test("account login and retirement of the prior Room credential commit or roll back together", t => {
  const f = fixture(t);
  const slot = f.store.createAccountSessionSlot();
  const revoke = f.store.revoke;
  f.store.revoke = () => { throw new Error("Simulated credential storage failure"); };
  try {
    assert.throws(() => f.store.loginAccountSession(slot.token, f.target.accessKey, 0, { revokeRoomToken: f.ownerRoomKey }), /storage failure/);
  } finally { f.store.revoke = revoke; }
  assert.equal(f.store.accountSessionSlot(slot.token).sessionRevision, 0);
  assert.throws(() => f.store.authenticateAccountSession(slot.token), { code: "unauthenticated" });
  assert.equal(f.store.authenticate(f.ownerRoomKey).member.id, "owner");
  assert.equal(f.store.loginAccountSession(slot.token, f.target.accessKey, 0, { revokeRoomToken: f.ownerRoomKey }).account.id, "account-target");
  assert.throws(() => f.store.authenticate(f.ownerRoomKey), { code: "unauthenticated" });
});

test("stable account session slots CAS-switch identity and fence stale Room reads", t => {
  const f = fixture(t);
  const slot = f.store.createAccountSessionSlot();
  const rawSlot = slot.token;
  const initialBinding = slot.session.sessionBinding;
  assert.equal(slot.session.sessionRevision, 0);
  assert.equal(slot.session.account, null);

  const loggedIn = f.store.loginAccountSession(rawSlot, f.owner.accessKey, 0);
  assert.equal(loggedIn.sessionRevision, 1);
  assert.notEqual(loggedIn.sessionBinding, initialBinding);
  assert.equal(f.store.snapshot(rawSlot, "commons", loggedIn.sessionBinding).viewerId, "owner");
  assert.throws(() => f.store.snapshot(f.owner.accessKey, "commons"), /expired|revoked|no membership|session/i,
    "an account access key is never a Room bearer credential");
  assert.throws(() => f.store.logoutAccountSession(rawSlot, 0), /changed/);

  const signedOut = f.store.logoutAccountSession(rawSlot, 1);
  assert.equal(signedOut.sessionRevision, 2);
  assert.equal(signedOut.account, null);
  assert.notEqual(signedOut.sessionBinding, loggedIn.sessionBinding);
  const switched = f.store.loginAccountSession(rawSlot, f.other.accessKey, 2);
  assert.equal(switched.sessionRevision, 3);
  assert.equal(switched.account.id, "account-other");
  assert.throws(() => f.store.authenticate(rawSlot, "commons", loggedIn.sessionBinding), /session changed/i,
    "an old stream/request fence cannot adopt the slot's replacement identity");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM account_session_slots WHERE hash=?").get(digest(rawSlot)).n, 1);
  assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM account_session_slots WHERE hash=?").get(digest(rawSlot))).includes(rawSlot), false);
});

test("a pending invitation grants its account no Room read authority", t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "no-read-before-accept" });
  const binding = f.target.session.sessionBinding;
  for (const read of [
    () => f.store.snapshot(f.target.token, "commons", binding),
    () => f.store.eventsAfter(f.target.token, "commons", 0, 100, binding),
    () => f.store.returnBrief(f.target.token, "commons", { expectedSessionBinding: binding })
  ]) assert.throws(read, /no membership/);
  assert.equal(f.store.previewInvitation(issued.rawToken).status, "pending");
  assert.equal(f.store.accountForMember("commons", "target-member"), null);
});

test("a replaced account-session slot cannot accept from its stale browser generation", t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "stale-slot" });
  const staleBinding = f.target.session.sessionBinding;
  const signedOut = f.store.logoutAccountSession(f.target.token, f.target.session.sessionRevision);
  const replacement = f.store.loginAccountSession(f.target.token, f.other.accessKey, signedOut.sessionRevision);
  assert.equal(replacement.account.id, "account-other");
  assert.notEqual(replacement.sessionBinding, staleBinding);

  assert.throws(() => f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: staleBinding
  }), /session changed/i);
  assert.equal(f.store.room("commons").state.members["target-member"], undefined);
  assert.equal(f.store.accountForMember("commons", "target-member"), null);
  assert.equal(f.store.previewInvitation(issued.rawToken).status, "pending");
});

test("issue, preview, acceptance, and exact replay preserve immutable account/member/role scope", t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "invite-target" });
  const exactRetry = f.store.issueInvitation(f.owner.token, "commons", issued.details);
  assert.equal(exactRetry.duplicate, true);
  assert.equal(exactRetry.invitation.id, issued.result.invitation.id);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(issued.result.invitation.id).n, 1);
  assert.throws(() => f.store.issueInvitation(f.owner.token, "commons", { ...issued.details, role: "guest" }), /different scope/);

  const preview = f.store.previewInvitation(issued.rawToken);
  assert.deepEqual(Object.keys(preview).sort(), ["displayName", "expiresAt", "id", "invitedByDisplayName", "memberId", "permissions", "revision", "role", "roomId", "roomPurpose", "roomTitle", "status"]);
  assert.equal(preview.status, "pending");
  assert.equal(JSON.stringify(preview).includes("account-target"), false);
  assert.equal(f.store.db.prepare("SELECT token_hash FROM membership_invitations WHERE id=?").get(preview.id).token_hash, digest(issued.rawToken));
  assert.equal(JSON.stringify(f.store.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(preview.id)).includes(issued.rawToken), false);
  assert.throws(() => f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId: "guessable", expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  }), /redemption ID/);

  const before = f.store.room("commons").sequence;
  const redemptionId = redemption();
  const accepted = f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId, expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  });
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.sequence, before + 1);
  assert.equal(accepted.event.type, T.MEMBER_JOINED_VIA_INVITATION);
  assert.equal(accepted.event.actorId, "target-member");
  assert.equal(accepted.event.data.invitedByMemberId, "owner");
  assert.deepEqual(accepted.event.data.permissions, ["accept_work", "complete_work", "verify"]);
  assert.equal(accepted.session.account.id, "account-target");
  assert.equal(accepted.session.member.id, "target-member");
  assert.equal(f.store.accountForMember("commons", "target-member").id, "account-target");
  assert.equal(f.store.snapshot(f.target.token, "commons", f.target.session.sessionBinding).viewerId, "target-member");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM credentials WHERE room_id='commons' AND member_id='target-member'").get().n, 0,
    "acceptance creates no Room key or replacement cookie credential");
  assert.deepEqual(f.store.db.prepare("SELECT type,actor_member_id,room_event_id FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(preview.id).map(row => ({ ...row })), [
    { type: "issued", actor_member_id: "owner", room_event_id: null },
    { type: "accepted", actor_member_id: "target-member", room_event_id: accepted.event.id }
  ]);

  const counts = {
    events: f.store.db.prepare("SELECT count(*) AS n FROM events").get().n,
    audits: f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events").get().n,
    bindings: f.store.db.prepare("SELECT count(*) AS n FROM member_accounts").get().n
  };
  const replay = f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId, expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.id, accepted.event.id);
  assert.throws(() => f.store.acceptInvitation(f.other.token, issued.rawToken, {
    redemptionId, expectedRevision: 0, expectedSessionBinding: f.other.session.sessionBinding
  }), /different account/, "an exact receipt replay remains bound to the accepting account");
  assert.deepEqual({
    events: f.store.db.prepare("SELECT count(*) AS n FROM events").get().n,
    audits: f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events").get().n,
    bindings: f.store.db.prepare("SELECT count(*) AS n FROM member_accounts").get().n
  }, counts);
  assert.throws(() => f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  }), /another request/);
});

test("an exact replay remains a no-write receipt after expiry and inviter authority revocation", t => {
  const f = fixture(t);
  f.store.createAccount("account-moderator");
  const moderator = accountSession(f.store, "account-moderator");
  const moderatorOffer = invitation(f, {
    requestId: "invite-moderator", intendedAccountId: "account-moderator",
    intendedMemberId: "moderator-member", displayName: "Moderator", role: "moderator"
  });
  f.store.acceptInvitation(moderator.token, moderatorOffer.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: moderator.session.sessionBinding
  });

  const rawToken = token();
  const details = {
    requestId: "moderator-invites-target", token: rawToken, intendedAccountId: "account-target",
    intendedMemberId: "target-member", displayName: "Target human", role: "member",
    expiresAt: f.now() + 3600000, expectedIssuerMemberRevision: 0,
    expectedSessionBinding: moderator.session.sessionBinding
  };
  const issued = f.store.issueInvitation(moderator.token, "commons", details);
  const redemptionId = redemption();
  const accepted = f.store.acceptInvitation(f.target.token, rawToken, {
    redemptionId, expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  });
  const moderatorMember = f.store.room("commons").state.members["moderator-member"];
  f.store.command(f.ownerRoomKey, "commons", {
    id: "revoke-moderator-after-acceptance", type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: moderatorMember.id, expectedMemberRevision: moderatorMember.revision, permissions: [...moderatorMember.permissions], active: false }
  });
  f.setNow(details.expiresAt);
  const beforeReplay = {
    roomSequence: f.store.room("commons").sequence,
    invitation: { ...f.store.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(issued.invitation.id) },
    audits: f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(issued.invitation.id).n,
    bindings: f.store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='commons' AND member_id='target-member'").get().n
  };

  const replay = f.store.acceptInvitation(f.target.token, rawToken, {
    redemptionId, expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.id, accepted.event.id);
  assert.equal(replay.invitation.status, "accepted");
  assert.deepEqual({
    roomSequence: f.store.room("commons").sequence,
    invitation: { ...f.store.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(issued.invitation.id) },
    audits: f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(issued.invitation.id).n,
    bindings: f.store.db.prepare("SELECT count(*) AS n FROM member_accounts WHERE room_id='commons' AND member_id='target-member'").get().n
  }, beforeReplay);
});

test("suspending the target account after invitation join immediately blocks Room access", t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "suspend-after-join" });
  f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  });
  assert.equal(f.store.snapshot(f.target.token, "commons", f.target.session.sessionBinding).viewerId, "target-member");

  f.store.changeAccountAccess("account-target", { expectedRevision: 0, active: false, reason: "Security suspension" });
  for (const access of [
    () => f.store.snapshot(f.target.token, "commons", f.target.session.sessionBinding),
    () => f.store.eventsAfter(f.target.token, "commons", 0, 100, f.target.session.sessionBinding),
    () => f.store.command(f.target.token, "commons", {
      id: "message-after-suspension", type: T.MESSAGE_POSTED, data: { body: "Must not persist" }
    }, f.target.session.sessionBinding)
  ]) assert.throws(access, /expired|revoked|account access ended/);
  assert.equal(f.store.room("commons").state.members["target-member"].active, true,
    "account suspension fences authority without rewriting Room membership history");
  assert.deepEqual(f.store.accountForMember("commons", "target-member"), {
    id: "account-target", active: false, revision: 1, authEpoch: 1
  });
});

test("expiry, account mismatch, revocation, and changed issuer authority cannot create membership", t => {
  const f = fixture(t);
  const expiring = invitation(f, { requestId: "expiring", expiresAt: f.now() + 1000 });
  f.setNow(expiring.details.expiresAt);
  assert.equal(f.store.previewInvitation(expiring.rawToken).status, "expired");
  assert.throws(() => f.store.acceptInvitation(f.target.token, expiring.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  }), /expired/);
  assert.equal(f.store.room("commons").state.members["target-member"], undefined);

  f.setNow(expiring.details.expiresAt + 1);
  const wrong = invitation(f, { requestId: "wrong-account", intendedMemberId: "target-two" });
  assert.throws(() => f.store.acceptInvitation(f.other.token, wrong.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.other.session.sessionBinding
  }), /different account/);
  const revoked = f.store.revokeInvitation(f.owner.token, wrong.result.invitation.id, {
    expectedRevision: 0, reason: "Invitation sent in error", expectedSessionBinding: f.owner.session.sessionBinding
  });
  assert.equal(revoked.invitation.status, "revoked");
  assert.throws(() => f.store.acceptInvitation(f.target.token, wrong.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  }), /revoked/);

  const changed = invitation(f, { requestId: "changed-authority", intendedMemberId: "target-three" });
  const ownerMember = f.store.room("commons").state.members.owner;
  f.store.command(f.ownerRoomKey, "commons", {
    id: "change-owner-revision", type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "owner", expectedMemberRevision: ownerMember.revision, permissions: [...ownerMember.permissions], active: true }
  });
  assert.throws(() => f.store.acceptInvitation(f.target.token, changed.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  }), /authority changed/);
  assert.equal(f.store.previewInvitation(changed.rawToken).status, "stale", "preview must not advertise an unusable offer as pending");
  assert.equal(f.store.room("commons").state.members["target-three"], undefined);
});

test("a delegated moderator cannot widen its own grant or alter owner authority", t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "moderator-scope", role: "moderator" });
  f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  });
  assert.throws(() => f.store.command(f.target.token, "commons", {
    id: "moderator-self-escalation", type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "target-member", expectedMemberRevision: 0, permissions: [...PERMISSIONS], active: true }
  }, f.target.session.sessionBinding), /cannot grant or remove authority/);
  const owner = f.store.room("commons").state.members.owner;
  assert.throws(() => f.store.command(f.target.token, "commons", {
    id: "moderator-owner-tamper", type: T.MEMBER_ACCESS_CHANGED,
    data: { memberId: "owner", expectedMemberRevision: owner.revision, permissions: ["manage_members"], active: true }
  }, f.target.session.sessionBinding), /Only the Room owner/);
  assert.throws(() => f.store.command(f.target.token, "commons", {
    id: "moderator-new-admin", type: T.MEMBER_ADDED,
    data: { memberId: "over-granted", displayName: "Over granted", kind: "human", permissions: ["decide"] }
  }, f.target.session.sessionBinding), /cannot grant or remove authority/);
});

test("an audit failure rolls back event, projection, binding, and accepted state together", t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "rollback" });
  const before = f.store.room("commons");
  f.store.db.exec(`CREATE TRIGGER abort_invitation_accept BEFORE INSERT ON membership_invitation_events
    WHEN NEW.type='accepted' BEGIN SELECT RAISE(ABORT,'invitation audit unavailable'); END`);
  assert.throws(() => f.store.acceptInvitation(f.target.token, issued.rawToken, {
    redemptionId: redemption(), expectedRevision: 0, expectedSessionBinding: f.target.session.sessionBinding
  }), /audit unavailable/);
  assert.deepEqual(f.store.room("commons"), before);
  assert.equal(f.store.accountForMember("commons", "target-member"), null);
  assert.equal(f.store.previewInvitation(issued.rawToken).status, "pending");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=?").get(issued.result.invitation.id).n, 1);
  f.store.db.exec("DROP TRIGGER abort_invitation_accept");
});

test("two database connections serialize one acceptance and one exact no-write replay", t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "concurrent" });
  const redemptionId = redemption();
  const moduleUrl = new URL("../server/store.mjs", import.meta.url).href;
  const source = `import { RoomStore } from ${JSON.stringify(moduleUrl)};
    const s=new RoomStore(process.env.INVITE_DB); try {
      const r=s.acceptInvitation(process.env.SLOT_TOKEN,process.env.INVITE_TOKEN,{redemptionId:process.env.REDEMPTION_ID,expectedRevision:0,expectedSessionBinding:process.env.SESSION_BINDING});
      process.stdout.write(JSON.stringify({duplicate:r.duplicate,eventId:r.event.id}));
    } catch(e) { process.stderr.write(e.stack); process.exitCode=1; } finally { s.close(); }`;
  const run = () => runStoreProcess(source, {
    INVITE_DB: f.filename, SLOT_TOKEN: f.target.token, INVITE_TOKEN: issued.rawToken,
    SESSION_BINDING: f.target.session.sessionBinding, REDEMPTION_ID: redemptionId
  });
  return Promise.all([run(), run()]).then(results => {
    assert.deepEqual(results.map(result => result.duplicate).sort(), [false, true]);
    assert.equal(results[0].eventId, results[1].eventId);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE body LIKE '%member.joined_via_invitation%'").get().n, 1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM membership_invitation_events WHERE invitation_id=? AND type='accepted'").get(issued.result.invitation.id).n, 1);
  });
});

test("acceptance and revocation serialize to one terminal outcome across database connections", async t => {
  const f = fixture(t);
  const issued = invitation(f, { requestId: "accept-versus-revoke" });
  const redemptionId = redemption();
  const beforeSequence = f.store.room("commons").sequence;
  const moduleUrl = new URL("../server/store.mjs", import.meta.url).href;
  const source = `import { RoomStore } from ${JSON.stringify(moduleUrl)};
    const s=new RoomStore(process.env.INVITE_DB); const op=process.env.OP; try {
      const r=op==='accept'
        ? s.acceptInvitation(process.env.SLOT_TOKEN,process.env.INVITE_TOKEN,{redemptionId:process.env.REDEMPTION_ID,expectedRevision:0,expectedSessionBinding:process.env.SESSION_BINDING})
        : s.revokeInvitation(process.env.SLOT_TOKEN,process.env.INVITE_ID,{expectedRevision:0,reason:'Concurrent administrator revocation',expectedSessionBinding:process.env.SESSION_BINDING});
      process.stdout.write(JSON.stringify({op,ok:true,status:r.invitation.status,eventId:r.event?.id??null}));
    } catch(e) { process.stdout.write(JSON.stringify({op,ok:false,code:e.code,status:e.status})); } finally { s.close(); }`;
  const common = {
    INVITE_DB: f.filename, INVITE_ID: issued.result.invitation.id,
    INVITE_TOKEN: issued.rawToken, REDEMPTION_ID: redemptionId
  };
  const results = await Promise.all([
    runStoreProcess(source, { ...common, OP: "accept", SLOT_TOKEN: f.target.token, SESSION_BINDING: f.target.session.sessionBinding }),
    runStoreProcess(source, { ...common, OP: "revoke", SLOT_TOKEN: f.owner.token, SESSION_BINDING: f.owner.session.sessionBinding })
  ]);
  const [winner] = results.filter(result => result.ok);
  const [loser] = results.filter(result => !result.ok);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => !result.ok).length, 1);
  const row = f.store.db.prepare("SELECT status FROM membership_invitations WHERE id=?").get(issued.result.invitation.id);
  assert.equal(row.status, winner.status);
  assert.deepEqual(f.store.db.prepare("SELECT type FROM membership_invitation_events WHERE invitation_id=? ORDER BY sequence").all(issued.result.invitation.id).map(({ type }) => type), ["issued", row.status]);

  if (row.status === "accepted") {
    assert.equal(winner.op, "accept");
    assert.deepEqual({ op: loser.op, code: loser.code, status: loser.status }, { op: "revoke", code: "stale_invitation_revision", status: 409 });
    assert.equal(f.store.room("commons").sequence, beforeSequence + 1);
    assert.equal(f.store.accountForMember("commons", "target-member").id, "account-target");
  } else {
    assert.equal(row.status, "revoked");
    assert.equal(winner.op, "revoke");
    assert.deepEqual({ op: loser.op, code: loser.code, status: loser.status }, { op: "accept", code: "invitation_revoked", status: 410 });
    assert.equal(f.store.room("commons").sequence, beforeSequence);
    assert.equal(f.store.accountForMember("commons", "target-member"), null);
  }
});

test("v3 to v4 is additive and a failed migration leaves the v3 database untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-v4-migration-"));
  const filename = join(directory, "room.sqlite");
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const roomKey = store.issueAccessKey("commons", "owner");
  store.command(roomKey, "commons", { id: "pre-v4-message", type: T.MESSAGE_POSTED, data: { body: "Preserve me" } });
  const preserved = {
    rooms: store.db.prepare("SELECT * FROM rooms ORDER BY id").all().map(row => ({ ...row })),
    events: store.db.prepare("SELECT * FROM events ORDER BY room_id,sequence").all().map(row => ({ ...row })),
    credentials: store.db.prepare("SELECT * FROM credentials ORDER BY hash").all().map(row => ({ ...row })),
    accounts: store.db.prepare("SELECT * FROM accounts ORDER BY id").all().map(row => ({ ...row })),
    bindings: store.db.prepare("SELECT * FROM member_accounts ORDER BY room_id,member_id").all().map(row => ({ ...row }))
  };
  store.db.exec("DROP TABLE private_reminder_commands; DROP TABLE private_reminders; DROP TABLE membership_invitation_journal; DROP TABLE membership_invitation_events; DROP TABLE membership_invitations; DROP TABLE account_session_slots; DROP TABLE account_credentials; PRAGMA user_version=3");
  store.close();

  store = new RoomStore(filename);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 8);
  assert.deepEqual({
    rooms: store.db.prepare("SELECT * FROM rooms ORDER BY id").all().map(row => ({ ...row })),
    events: store.db.prepare("SELECT * FROM events ORDER BY room_id,sequence").all().map(row => ({ ...row })),
    credentials: store.db.prepare("SELECT * FROM credentials ORDER BY hash").all().map(row => ({ ...row })),
    accounts: store.db.prepare("SELECT * FROM accounts ORDER BY id").all().map(row => ({ ...row })),
    bindings: store.db.prepare("SELECT * FROM member_accounts ORDER BY room_id,member_id").all().map(row => ({ ...row }))
  }, preserved);
  store.close();

  const broken = join(directory, "broken.sqlite");
  store = new RoomStore(broken);
  store.initialize(initialRoom("broken", "owner"));
  store.db.exec("DROP TABLE private_reminder_commands; DROP TABLE private_reminders; DROP TABLE membership_invitation_journal; DROP TABLE membership_invitation_events; DROP TABLE membership_invitations; DROP TABLE account_session_slots; DROP TABLE account_credentials; PRAGMA user_version=3");
  store.close();
  const raw = new DatabaseSync(broken);
  raw.exec("CREATE TABLE membership_invitations(dummy TEXT)");
  const originalRoom = raw.prepare("SELECT * FROM rooms").get();
  raw.close();
  assert.throws(() => new RoomStore(broken), /no such column|already exists/);
  const inspected = new DatabaseSync(broken);
  assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_credentials'").get(), undefined);
  assert.equal(inspected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_session_slots'").get(), undefined);
  assert.deepEqual({ ...inspected.prepare("SELECT * FROM rooms").get() }, { ...originalRoom });
  inspected.close();
  rmSync(directory, { recursive: true, force: true });
});
