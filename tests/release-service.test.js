import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ConversationDrafts, DraftRecovery, draftRecoveryScope } from '../src/conversation.js';
import { createRoomServer } from '../server/http.mjs';
import { exportNdjsonText } from '../server/room-export.mjs';
import { replayNdjsonInto } from '../server/restore-ndjson.mjs';
import { reconcileRestoredAuthority } from '../server/backup.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-release-service-"));
  let now = Date.now();
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, advance: ms => { now += ms; } };
}

test('draft recovery lineage follows only a live same-account session across rotation', t => {
  const {store, owner} = fixture(t), alice = store.authenticate(owner).account.id;
  store.createAccount('draft-other');
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token, alice, 0, {method:{kind:'password'},rotateSlot:true});
  const same = store.loginAccountSessionWithMethod(first.token, alice, first.session.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  assert.notEqual(first.session.sessionBinding, same.session.sessionBinding);
  assert.equal(first.session.draftRecoveryLineage, same.session.draftRecoveryLineage);
  const other = store.loginAccountSessionWithMethod(same.token, 'draft-other', same.session.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  assert.notEqual(other.session.draftRecoveryLineage, same.session.draftRecoveryLineage);
  const again = store.loginAccountSessionWithMethod(other.token, alice, other.session.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  assert.notEqual(again.session.draftRecoveryLineage, first.session.draftRecoveryLineage);
  store.logoutAccountSession(again.token, again.session.sessionRevision);
  const signedOut = store.accountSessionSlot(again.token);
  const afterLogout = store.loginAccountSessionWithMethod(again.token, alice, signedOut.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  assert.notEqual(afterLogout.session.draftRecoveryLineage, again.session.draftRecoveryLineage);
});

test('a saved draft recovers after same-account rotation but not after sign-out', t => {
  const {store, owner} = fixture(t), accountId = store.authenticate(owner).account.id;
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token, accountId, 0, {method:{kind:'password'},rotateSlot:true});
  const roomBefore = store.authenticateAccountSession(first.token, 'commons');
  const memory = new Map(), storage = {getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
  const recovery = new DraftRecovery(storage), drafts = new ConversationDrafts();
  drafts.get(null).body = 'unsent private draft';
  assert.equal(recovery.write(draftRecoveryScope(roomBefore), drafts, null), true);
  const next = store.loginAccountSessionWithMethod(first.token, accountId, first.session.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  const roomAfter = store.authenticateAccountSession(next.token, 'commons');
  assert.equal(recovery.read(draftRecoveryScope(roomAfter), store.room('commons').state)?.drafts.get(null).body, 'unsent private draft');
  store.logoutAccountSession(next.token, next.session.sessionRevision);
  const anonymous = store.accountSessionSlot(next.token);
  const signedBack = store.loginAccountSessionWithMethod(next.token, accountId, anonymous.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  assert.equal(recovery.read(draftRecoveryScope(store.authenticateAccountSession(signedBack.token, 'commons')), store.room('commons').state), null);
});

test('account confirmation discards a backup from a different account or signed-out lineage', t => {
  const {store,owner}=fixture(t),accountId=store.authenticate(owner).account.id;
  store.createAccount('draft-other');const slot=store.createAccountSessionSlot();
  const first=store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true});
  const room=store.authenticateAccountSession(first.token,'commons'),memory=new Map();
  const recovery=new DraftRecovery({getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}),drafts=new ConversationDrafts();
  drafts.get(null).body='private';
  const accountView=session=>({authenticated:true,account:session.account,sessionBinding:session.sessionBinding,draftRecoveryLineage:session.draftRecoveryLineage});
  recovery.write(draftRecoveryScope(room),drafts,null);
  const same=store.loginAccountSessionWithMethod(first.token,accountId,first.session.sessionRevision,{method:{kind:'password'},rotateSlot:true});
  recovery.reconcileAccount(accountView(same.session));assert.ok(memory.has('project-room:drafts:v3'));
  const other=store.loginAccountSessionWithMethod(same.token,'draft-other',same.session.sessionRevision,{method:{kind:'password'},rotateSlot:true});
  recovery.reconcileAccount(accountView(other.session));assert.equal(memory.has('project-room:drafts:v3'),false);
  recovery.write(draftRecoveryScope(room),drafts,null);
  recovery.reconcileAccount({authenticated:false});assert.equal(memory.has('project-room:drafts:v3'),false);
});

test('room session HTTP returns the same recovery lineage after verified rotation', async t => {
  const {store, owner} = fixture(t), accountId = store.authenticate(owner).account.id;
  const accountKey = store.issueAccountAccessKey(accountId), slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token, accountId, 0, {method:{kind:'password'},rotateSlot:true});
  const server = createRoomServer({store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const getRoom = async (token,binding) => {
    const response = await fetch(`${origin}/api/session?room=commons`, {headers:{Cookie:`account_session=${token}`,'X-Project-Room-Auth':'account','X-Session-Binding':binding}});
    assert.equal(response.status,200);return response.json();
  };
  const before = await getRoom(first.token, first.session.sessionBinding);
  const response = await fetch(`${origin}/api/account-session`, {method:'POST',headers:{Cookie:`account_session=${first.token}`,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':first.session.csrf,'X-Session-Binding':first.session.sessionBinding},body:JSON.stringify({accountAccessKey:accountKey,expectedSessionRevision:first.session.sessionRevision})});
  assert.equal(response.status,201);const next = await response.json();
  const token = /account_session=([A-Za-z0-9_-]{43})/.exec(response.headers.get('set-cookie') ?? '')?.[1];assert.ok(token);
  const after = await getRoom(token,next.sessionBinding);
  assert.notEqual(before.sessionBinding,after.sessionBinding);
  assert.equal(before.draftRecoveryLineage,after.draftRecoveryLineage);
  assert.equal(draftRecoveryScope(before),draftRecoveryScope(after));
});

test('legacy session drafts migrate through the first same-account rotation', t => {
  const {store, owner} = fixture(t), accountId = store.authenticate(owner).account.id;
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token, accountId, 0, {method:{kind:'password'},rotateSlot:true});
  store.db.prepare('UPDATE account_session_slots SET draft_recovery_lineage=NULL WHERE hash=?').run(store.authenticateAccountSession(first.token).credentialHash);
  const legacy = store.authenticateAccountSession(first.token, 'commons');
  assert.equal(legacy.draftRecoveryLineage,null);
  const before = draftRecoveryScope(legacy);
  const next = store.loginAccountSessionWithMethod(first.token, accountId, first.session.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  assert.equal(draftRecoveryScope(store.authenticateAccountSession(next.token,'commons')), before);
});

test('revoking the session breaks draft continuity when signing in again', t => {
  const {store, owner} = fixture(t), accountId = store.authenticate(owner).account.id;
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token, accountId, 0, {method:{kind:'password'},rotateSlot:true});
  const prior = first.session.draftRecoveryLineage;
  const current = store.listAccountSessions(accountId,store.authenticateAccountSession(first.token).credentialHash).find(row=>row.current);
  assert.equal(store.revokeAccountSession(accountId,current.id),1);
  const anonymous = store.accountSessionSlot(first.token);
  const next = store.loginAccountSessionWithMethod(first.token, accountId, anonymous.sessionRevision, {method:{kind:'password'},rotateSlot:true});
  assert.notEqual(next.session.draftRecoveryLineage,prior);
});

test('draft lineage survives a storage restart and later same-account rotation', t => {
  const directory = mkdtempSync(join(tmpdir(),'room-draft-lineage-')), path = join(directory,'room.sqlite');
  let store = new RoomStore(path); t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons','owner'), accountId = store.authenticate(owner).account.id;
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true});
  const before = draftRecoveryScope(store.authenticateAccountSession(first.token,'commons'));
  store.close();store = new RoomStore(path);
  const next = store.loginAccountSessionWithMethod(first.token,accountId,first.session.sessionRevision,{method:{kind:'password'},rotateSlot:true});
  assert.equal(draftRecoveryScope(store.authenticateAccountSession(next.token,'commons')),before);
});

test('an older database gains the lineage column and preserves legacy draft scope', t => {
  const directory = mkdtempSync(join(tmpdir(),'room-draft-legacy-')), path = join(directory,'room.sqlite');
  let store = new RoomStore(path);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.initialize(initialRoom());const owner=store.issueAccessKey('commons','owner'),accountId=store.authenticate(owner).account.id;
  const slot=store.createAccountSessionSlot(), first=store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true});
  store.db.exec('ALTER TABLE account_session_slots DROP COLUMN draft_recovery_lineage');
  store.close();store=new RoomStore(path);
  const legacy=store.authenticateAccountSession(first.token,'commons'), before=draftRecoveryScope(legacy);
  assert.equal(legacy.draftRecoveryLineage,null);
  const next=store.loginAccountSessionWithMethod(first.token,accountId,legacy.sessionRevision,{method:{kind:'password'},rotateSlot:true});
  assert.equal(draftRecoveryScope(store.authenticateAccountSession(next.token,'commons')),before);
});

test('backup restores draft lineage without exposing the browser credential', t => {
  const {store, owner} = fixture(t), accountId = store.authenticate(owner).account.id;
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true});
  const before = draftRecoveryScope(store.authenticateAccountSession(first.token,'commons'));
  const exported = exportNdjsonText(store.db);
  assert.equal(exported.includes(first.token),false);
  const restored = new RoomStore(':memory:'); t.after(()=>restored.close());
  assert.equal(replayNdjsonInto(exported,restored).verified,true);
  const after = restored.loginAccountSessionWithMethod(first.token,accountId,first.session.sessionRevision,{method:{kind:'password'},rotateSlot:true});
  assert.equal(draftRecoveryScope(restored.authenticateAccountSession(after.token,'commons')),before);
});

test('an old-schema backup restores into the new schema and recovers legacy scope', t => {
  const {store, owner} = fixture(t), accountId=store.authenticate(owner).account.id;
  const slot=store.createAccountSessionSlot(),first=store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true});
  store.db.exec('ALTER TABLE account_session_slots DROP COLUMN draft_recovery_lineage');
  const exported=exportNdjsonText(store.db),restored=new RoomStore(':memory:');t.after(()=>restored.close());
  assert.equal(replayNdjsonInto(exported,restored).verified,true);
  const legacy=restored.authenticateAccountSession(first.token,'commons'),before=draftRecoveryScope(legacy);
  const next=restored.loginAccountSessionWithMethod(first.token,accountId,legacy.sessionRevision,{method:{kind:'password'},rotateSlot:true});
  assert.equal(draftRecoveryScope(restored.authenticateAccountSession(next.token,'commons')),before);
});

test('backup reconciliation flags a browser session signed out after its snapshot', t => {
  const {store, owner} = fixture(t), accountId = store.authenticate(owner).account.id;
  const slot = store.createAccountSessionSlot();
  const first = store.loginAccountSessionWithMethod(slot.token,accountId,0,{method:{kind:'password'},rotateSlot:true});
  const snapshot = exportNdjsonText(store.db), restored = new RoomStore(':memory:');t.after(()=>restored.close());
  replayNdjsonInto(snapshot,restored);
  store.logoutAccountSession(first.token,first.session.sessionRevision);
  assert.ok(reconcileRestoredAuthority(restored,store).stale.some(row=>row.kind==='login_method' && /account session/.test(row.detail)));
});

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
