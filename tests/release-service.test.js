import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-release-service-"));
  let now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, advance: ms => { now += ms; } };
}

test("account login is bounded by the existing browser slot and still rejects its expiry", t => {
  const { store, owner, advance } = fixture(t);
  const key = store.issueAccountAccessKey(store.authenticate(owner).account.id);
  for (const lifetime of [60000, 30 * 86400000]) {
    const slot = store.createAccountSessionSlot(lifetime);
    const start = store.now();
    const auth = store.loginAccountSession(slot.token, key, slot.session.sessionRevision);
    assert.equal(auth.expiresAt, Math.min(slot.session.expiresAt, store.authenticateAccountAccessKey(key).expiresAt, start + 30 * 86400000));
    assert.equal(auth.authenticatedUntil, auth.expiresAt);
    if (lifetime === 60000) {
      advance(lifetime);
      assert.throws(() => store.authenticateAccountSession(slot.token), /expired/);
      assert.throws(() => store.loginAccountSession(slot.token, key, auth.sessionRevision), /expired/);
    }
  }
});

test("snapshot and return brief request read-only transactions and never acknowledge", t => {
  const { store, owner } = fixture(t);
  const platform = store.storagePlatform, modes = [];
  store.storagePlatform = { ...platform, transaction(db, fn, readOnly) {
    modes.push(readOnly);
    return platform.transaction(db, fn, readOnly);
  } };
  const snapshot = store.snapshot(owner, "commons");
  const brief = store.returnBrief(owner, "commons");
  assert.deepEqual(modes, [true, true]);
  assert.equal(brief.current.evaluatedThrough, snapshot.sequence);
  assert.equal(store.snapshot(owner, "commons").cursor, 0);
  store.revoke(owner);
  for (const read of [() => store.snapshot(owner, "commons"), () => store.returnBrief(owner, "commons")])
    assert.throws(read, /revoked/);
});

test("verified account sessions last beyond eight hours and still honor sign out and slot expiry", t => {
  const { store, owner, advance } = fixture(t);
  const accountId = store.authenticate(owner).account.id;
  const methodSlot = store.createAccountSessionSlot();
  const method = store.loginAccountSessionWithMethod(methodSlot.token, accountId, 0, { method: { kind: "password" } });
  const googleSlot = store.createAccountSessionSlot();
  const google = store.loginAccountSessionWithGoogle(googleSlot.token, "123456789", 0);
  assert.equal(method.expiresAt, methodSlot.session.expiresAt);
  assert.equal(google.expiresAt, googleSlot.session.expiresAt);
  advance(9 * 3600000);
  assert.equal(store.authenticateAccountSession(methodSlot.token).account.id, accountId);
  assert.equal(store.authenticateAccountSession(googleSlot.token).account.id, google.account.id);
  store.logoutAccountSession(methodSlot.token, method.sessionRevision);
  assert.throws(() => store.authenticateAccountSession(methodSlot.token), /expired|revoked|ended/);
  advance(30 * 86400000);
  assert.throws(() => store.authenticateAccountSession(googleSlot.token), /expired|revoked|ended/);
});

test("account-key sessions never outlive their parent credential, including guest keys", t => {
  const { store, owner, advance } = fixture(t);
  const accountId = store.authenticate(owner).account.id;
  const key = store.insertAccountCredential(accountId, store.now() + 8 * 3600000);
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  assert.equal(session.expiresAt, store.now() + 8 * 3600000);
  advance(8 * 3600000);
  assert.throws(() => store.authenticateAccountSession(slot.token), /expired|revoked|ended/);
});

test('research: verified rotating login renews old default slot, and signout revokes it', t => {
  const { store, owner, advance } = fixture(t), accountId=store.authenticate(owner).account.id;
  const slot=store.createAccountSessionSlot();advance(29*86400000);
  const result=store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true});
  assert.equal(result.session.expiresAt,store.now()+30*86400000);
  assert.throws(()=>store.authenticateAccountSession(slot.token),/expired|revoked|ended/);
  advance(2*86400000);assert.equal(store.authenticateAccountSession(result.token).account.id,accountId);
  store.logoutAccountSession(result.token,result.session.sessionRevision);
  assert.throws(()=>store.authenticateAccountSession(result.token),/expired|revoked|ended/);
});

test('research: custom short slot and nonrotated slot retain their expiry', t => {
  const { store, owner } = fixture(t), accountId=store.authenticate(owner).account.id;
  const short=store.createAccountSessionSlot(60000);
  const rotated=store.loginAccountSessionWithMethod(short.token,accountId,0,{method:{kind:'password'},rotateSlot:true});
  assert.equal(rotated.session.expiresAt,short.session.expiresAt);
  const slot=store.createAccountSessionSlot();
  const unrotated=store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'}});
  assert.equal(unrotated.expiresAt,slot.session.expiresAt);
});

test('research: explicit browser renewal handles prior short-lived rotated slots, without changing other callers', t => {
  const { store, owner }=fixture(t),accountId=store.authenticate(owner).account.id;
  const old=store.createAccountSessionSlot(20*86400000);
  const renewed=store.loginAccountSessionWithMethod(old.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true});
  assert.equal(renewed.session.expiresAt,store.now()+30*86400000);
  const short=store.createAccountSessionSlot(60000);
  assert.throws(()=>store.loginAccountSessionWithMethod(short.token,accountId,0,{method:{kind:'password'},renewBrowserSession:true}),/rotation/);
  assert.equal(store.accountSessionSlot(short.token).expiresAt,short.session.expiresAt);
});

test('browser renewal cannot revive an expired slot', t => {
  const {store,owner,advance}=fixture(t), accountId=store.authenticate(owner).account.id;
  const key=store.issueAccountAccessKey(accountId), slot=store.createAccountSessionSlot(60000);
  advance(60000);
  assert.throws(()=>store.loginAccountSession(slot.token,key,0,{rotateSlot:true,renewBrowserSession:true}),/expired/);
  assert.throws(()=>store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true}),/expired/);
  assert.throws(()=>store.authenticateAccountSession(slot.token),/expired/);
});

test('renewed browser session and signout survive a storage restart', t => {
  const directory=mkdtempSync(join(tmpdir(),'room-renew-restart-')),path=join(directory,'room.sqlite');
  let now=Date.now(),store=new RoomStore(path,{now:()=>now});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.initialize(initialRoom());
  const owner=store.issueAccessKey('commons','owner'),accountId=store.authenticate(owner).account.id;
  const slot=store.createAccountSessionSlot();now+=29*86400000;
  const renewed=store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true});
  store.close();store=new RoomStore(path,{now:()=>now});
  const session=store.authenticateAccountSession(renewed.token);
  assert.equal(session.account.id,accountId);
  assert.ok(session.expiresAt-now>29*86400000);
  assert.throws(()=>store.authenticateAccountSession(slot.token),/expired|revoked|ended/);
  store.logoutAccountSession(renewed.token,session.sessionRevision);
  store.close();store=new RoomStore(path,{now:()=>now});
  assert.throws(()=>store.authenticateAccountSession(renewed.token),/expired|revoked|ended/);
});

test('research: failed rotation rolls back the renewed slot and login', t => {
  const {store,owner,advance}=fixture(t),accountId=store.authenticate(owner).account.id;
  const slot=store.createAccountSessionSlot();advance(29*86400000);
  const original=store.rotateAccountSessionSlot.bind(store);store.rotateAccountSessionSlot=()=>{throw Error('injected rotation fault')};
  try{assert.throws(()=>store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true}),/injected/);}finally{store.rotateAccountSessionSlot=original;}
  const after=store.accountSessionSlot(slot.token);assert.equal(after.expiresAt,slot.session.expiresAt);assert.equal(after.sessionRevision,0);
  assert.throws(()=>store.authenticateAccountSession(slot.token),/expired|revoked|ended/);
});

test('research: competing login cannot extend or replace a rotated session', t => {
  const {store,owner,advance}=fixture(t), accountId=store.authenticate(owner).account.id;
  const slot=store.createAccountSessionSlot(); advance(29*86400000);
  const first=store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true});
  assert.throws(()=>store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true}),/expired|revoked|ended/);
  assert.throws(()=>store.loginAccountSessionWithMethod(first.token,accountId,0,{method:{kind:'password'},rotateSlot:true,renewBrowserSession:true}),/revision|changed/);
  const current=store.authenticateAccountSession(first.token);
  assert.equal(current.sessionRevision,1);
  assert.equal(current.expiresAt,first.session.expiresAt);
});

test('research: renewed account-key session never outlives its parent key', t => {
 const {store,owner,advance}=fixture(t),accountId=store.authenticate(owner).account.id;
 const slot=store.createAccountSessionSlot();advance(29*86400000);
 const key=store.insertAccountCredential(accountId,store.now()+8*3600000);
 const result=store.loginAccountSession(slot.token,key,0,{rotateSlot:true,renewBrowserSession:true});
 assert.equal(result.session.expiresAt,store.now()+8*3600000);
 advance(8*3600000);assert.throws(()=>store.authenticateAccountSession(result.token),/expired|revoked|ended/);
});

test('research: renewed key login fails atomically on wrong key or failed rotation', t => {
 const {store,owner,advance}=fixture(t),accountId=store.authenticate(owner).account.id;
 const slot=store.createAccountSessionSlot();advance(29*86400000);
 assert.throws(()=>store.loginAccountSession(slot.token,'A'.repeat(43),0,{rotateSlot:true,renewBrowserSession:true}),/expired|revoked|ended/);
 const key=store.insertAccountCredential(accountId,store.now()+86400000),original=store.rotateAccountSessionSlot.bind(store);store.rotateAccountSessionSlot=()=>{throw Error('injected')};
 try{assert.throws(()=>store.loginAccountSession(slot.token,key,0,{rotateSlot:true,renewBrowserSession:true}),/injected/);}finally{store.rotateAccountSessionSlot=original;}
 const after=store.accountSessionSlot(slot.token);assert.equal(after.expiresAt,slot.session.expiresAt);assert.equal(after.sessionRevision,0);
});
