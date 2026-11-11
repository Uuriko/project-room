import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {AccessRequests} from '../server/access-requests.mjs';
import {readConversation} from '../server/conversation-sync.mjs';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'public-pending-retry-')),path=join(dir,'db');let store=new RoomStore(path);
  const owner=store.identities.create('Founder'),peer=store.identities.create('Collaborator');
  new AgentRooms(store).create(owner.secret,{roomId:'retry-room',title:'Project',purpose:'Useful work',starter:false,visibility:'private'});
  let serial=0;
  const send=(type,data,id=type+'-'+(++serial))=>store.command(owner.secret,'retry-room',{id,type,data});
  send('message.posted',{messageId:'private-before',body:'PRIVATE BEFORE JOIN'});
  send('room.public_page_set',{enabled:true});
  const request=(secret=peer.secret,permissions=[],id='same-request')=>new AccessRequests(store).request('retry-room',{identityId:peer.identityId,displayName:peer.displayName,requestedPermissions:permissions,requestId:id},secret);
  assert.equal(request().status,'pending');
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},owner,peer,send,request,open:()=>send('room.join_link_set',{enabled:true}),reopen(){store.close();store=new RoomStore(path);}};
}
test('same pending request joins after opening and cold retries preserve one guest admission',t=>{
  const f=fixture(t);f.open();const before=f.store.headSequence('retry-room');
  const result=f.request();assert.equal(result.status,'approved');assert.equal(result.memberId,f.peer.identityId);
  assert.equal(f.store.headSequence('retry-room'),before+1);
  const member=f.store.authenticate(f.peer.secret,'retry-room').member;assert.deepEqual(member.permissions,[]);assert.equal(member.historyGuest,true);
  assert.throws(()=>readConversation(f.store,f.peer.secret,'retry-room',{messageId:'private-before'}),e=>e.status===404);
  const after=f.store.headSequence('retry-room');f.reopen();assert.equal(f.request().status,'approved');assert.equal(f.store.headSequence('retry-room'),after);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM access_requests WHERE request_id='same-request'").get().n,1);
});
test('open pending retry needs matching current identity proof before any mutation',t=>{
  const f=fixture(t);f.open();const before=f.store.headSequence('retry-room');
  for(const secret of [null,'wrong-secret',f.owner.secret])assert.throws(()=>f.request(secret),e=>e.status===401||e.status===403);
  assert.equal(f.store.headSequence('retry-room'),before);
  assert.equal(f.store.db.prepare("SELECT status FROM access_requests WHERE request_id='same-request'").get().status,'pending');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_links WHERE room_id=? AND identity_id=?').get('retry-room',f.peer.identityId).n,0);
  assert.equal(f.request().status,'approved');
});
test('off stays pending and a stored nonempty request never gains a retry auto-approval',t=>{
  const f=fixture(t);assert.equal(f.request(null).status,'pending');
  assert.equal(f.request(f.peer.secret,['accept_work'],'work-request').status,'pending');
  new AccessRequests(f.store).setAutoApprove(f.owner.secret,'retry-room',{permissions:['accept_work']});
  f.open();const before=f.store.headSequence('retry-room');
  assert.equal(f.request(f.peer.secret,['accept_work'],'work-request').status,'pending');
  assert.equal(f.store.headSequence('retry-room'),before);
  f.send('room.join_link_set',{enabled:false});assert.equal(f.request(null).status,'pending');
});
test('same pending request cannot reactivate a removed linked identity',t=>{
  const f=fixture(t);
  const token=f.store.shareLinks.personalInvite(f.store.authenticate(f.owner.secret,'retry-room'),'retry-room',25).token;
  f.store.shareLinks.joinAgent(f.peer.secret,token,f.peer.displayName);
  assert.equal(f.store.db.prepare("SELECT status FROM access_requests WHERE request_id='same-request'").get().status,'pending');
  f.send('member.access_changed',{memberId:f.peer.identityId,active:false,permissions:[],expectedMemberRevision:f.store.authenticate(f.peer.secret,'retry-room').member.revision});f.open();
  const before=f.store.headSequence('retry-room');assert.equal(f.request().status,'pending');assert.equal(f.store.headSequence('retry-room'),before);
  assert.throws(()=>f.store.authenticate(f.peer.secret,'retry-room'));
});
test('pending retry approval-save failure rolls back admission and exact retry remains usable',t=>{
  const f=fixture(t);f.open();const before=f.store.headSequence('retry-room'),prepare=f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith("UPDATE access_requests SET status='approved',decided_at="))return statement;return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);return key==='run'? (...args)=>{value.apply(target,args);throw Error('synthetic approval save failure');}:typeof value==='function'?value.bind(target):value;}});};
  assert.throws(()=>f.request(),/synthetic approval save failure/);f.store.db.prepare=prepare;
  assert.equal(f.store.headSequence('retry-room'),before);
  assert.equal(f.store.db.prepare("SELECT status FROM access_requests WHERE request_id='same-request'").get().status,'pending');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_links WHERE room_id=? AND identity_id=?').get('retry-room',f.peer.identityId).n,0);
  assert.equal(f.request().status,'approved');assert.equal(f.store.headSequence('retry-room'),before+1);
});
