import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {AgentRooms} from '../server/agent-rooms.mjs';
import {readCurrentRecord} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {setTier} from '../server/autonomy-tiers.mjs';
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'current-bonds-')),path=join(dir,'room.sqlite');let store=new RoomStore(path);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const owner=store.identities.create('Lena'),friend=store.identities.create('Friend'),other=store.identities.create('Other');
 const roomId=new AgentRooms(store).create(owner.secret,{roomId:'bond-room',title:'Bonds',purpose:'Bonds',kind:'personal',displayName:'Lena',starter:false}).roomId;
 for(const identity of [friend,other]){const linked=linkWithProof(store,owner.secret,roomId,identity,{displayName:identity.identityId,permissions:[]});setTier(store.db,roomId,linked.memberId,'t2_standard',{updatedBy:owner.identityId,nowMs:store.now()});}
 const forbid=()=>{store.room=()=>{throw Error('whole room hydration');};};forbid();
 return{get store(){return store;},roomId,owner,friend,other,
  command:(identity,id,type,data)=>store.command(identity.secret,roomId,{id,type,data}),
  restart:()=>{store.close();store=new RoomStore(path);forbid();},
  bond:id=>readCurrentRecord(store.db,roomId,'bonds',id)};
}
test('native bond lifecycle preserves complete prior fields, independent oracle, cold exact retry and old receipts',t=>{
 const f=setup(t),{owner,friend,other,roomId}=f;
 const propose=f.command(owner,'propose','bond.propose',{to:friend.identityId,scopes:['peer.dm','peer.context'],note:'Original proposal'}),id=propose.event.data.bondId;
 const prior=f.bond(id);assert.equal(prior.note,'Original proposal');
 assert.throws(()=>f.command(other,'unauthorized','bond.accept',{bondId:id}),e=>e.code==='bond_not_found');
 const accepted=f.command(friend,'accept','bond.accept',{bondId:id,scopes:['peer.dm','peer.wake']});
 const active=f.bond(id);assert.equal(active.note,prior.note);assert.deepEqual(active.proposedScopes,prior.proposedScopes);assert.equal(active.proposedAt,prior.proposedAt);assert.deepEqual(active.acceptedScopes,['peer.dm']);
 const dm=f.command(owner,'dm','dm.posted',{to:friend.identityId,messageId:'peer-message',body:'Private useful work'});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM peer_dm_messages').get().n,1);
 assert.equal(f.store.bonds.readThread(roomId,friend.identityId,dm.event.data.threadId).messages[0].body,'Private useful work');
 assert.throws(()=>f.store.bonds.readThread(roomId,other.identityId,dm.event.data.threadId),e=>e.code==='thread_not_found');
 f.restart();assert.equal(f.command(friend,'accept','bond.accept',{bondId:id,scopes:['peer.dm','peer.wake']}).duplicate,true);
 assert.equal(f.command(owner,'dm','dm.posted',{to:friend.identityId,messageId:'peer-message',body:'Private useful work'}).event.id,dm.event.id);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM peer_dm_messages').get().n,1);
 f.command(friend,'revoke','bond.revoke',{bondId:id});const revoked=f.bond(id);assert.equal(revoked.note,prior.note);assert.deepEqual(revoked.proposedScopes,prior.proposedScopes);assert.equal(revoked.acceptedAt,accepted.event.at);
 assert.throws(()=>f.command(owner,'blocked-dm','dm.posted',{to:friend.identityId,messageId:'refused',body:'No longer authorized'}),e=>e.code==='bond_revoked');
 const renewed=f.command(owner,'repropose','bond.propose',{to:friend.identityId,scopes:['peer.context'],note:'New explicit consent'});
 assert.notEqual(renewed.event.data.bondId,id);assert.deepEqual(f.bond(id),revoked);
 assert.doesNotThrow(()=>auditRecovery(f.store));
 assert.equal(f.store.db.prepare('SELECT enabled FROM current_room_writer_permit').get().enabled,0);
});
test('native bond and peer-DM side tables, events and protected records roll back atomically',t=>{
 const f=setup(t),{owner,friend}=f,before=f.store.db.prepare('SELECT count(*) n FROM events').get().n;
 const original=f.store.bonds.prepare.bind(f.store.bonds);
 f.store.bonds.prepare=(...args)=>{original(...args);throw Error('synthetic interrupted bond save');};
 assert.throws(()=>f.command(owner,'proposal','bond.propose',{to:friend.identityId,note:'Saved only once'}),/synthetic interrupted/);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_bonds').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n,before);
 f.store.bonds.prepare=original;const p=f.command(owner,'proposal','bond.propose',{to:friend.identityId,note:'Saved only once'});
 f.command(friend,'accept','bond.accept',{bondId:p.event.data.bondId});
 const seal=f.store.bonds.sealDm.bind(f.store.bonds);f.store.bonds.sealDm=(...args)=>{seal(...args);throw Error('synthetic lost DM save');};
 const command={to:friend.identityId,messageId:'fault-dm',body:'Atomic DM'};
 assert.throws(()=>f.command(owner,'fault-dm','dm.posted',command),/synthetic lost DM save/);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM peer_dm_messages').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM peer_dm_threads').get().n,0);
 f.store.bonds.sealDm=seal;f.restart();const saved=f.command(owner,'fault-dm','dm.posted',command);assert.equal(saved.duplicate,false);assert.equal(f.command(owner,'fault-dm','dm.posted',command).duplicate,true);assert.doesNotThrow(()=>auditRecovery(f.store));
});

test('native peer inbox limits body hydration to selected results and reports source truncation',t=>{
 const f=setup(t),{owner,friend,roomId}=f;
 const id=f.command(owner,'proposal','bond.propose',{to:friend.identityId,scopes:['peer.dm']}).event.data.bondId;
 f.command(friend,'accept','bond.accept',{bondId:id});
 let now=f.store.now();f.store.now=()=>now;
 for(let i=0;i<40;i++){now+=3000;f.command(owner,`dm-${i}`,'dm.posted',{to:friend.identityId,messageId:`dm-${i}`,body:`Private ${i}`});}
 const prepare=f.store.db.prepare.bind(f.store.db);let bodyReads=0;
 f.store.db.prepare=sql=>{if(sql==='SELECT * FROM peer_dm_messages WHERE message_id=?')bodyReads++;return prepare(sql);};
 let result;try{result=f.store.bonds.nativeInboxForMember(roomId,friend.identityId,3,()=>{});}finally{f.store.db.prepare=prepare;}
 assert.equal(result.peerMessages.length,3);assert.equal(bodyReads,3);assert.equal(result.coverage.peerMessages.complete,false);assert.equal(result.coverage.peerMessages.examined,32);
 for(const sql of ["SELECT id FROM agent_bonds WHERE agent_a=? AND state='proposed' LIMIT 33","SELECT id FROM agent_bonds WHERE agent_b=? AND state='proposed' LIMIT 33","SELECT message_id FROM peer_dm_messages WHERE to_identity_id=? ORDER BY created_at DESC LIMIT 33"]){
  const plan=f.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(friend.identityId).map(x=>x.detail).join(' ');assert.match(plan,/USING INDEX/);assert.doesNotMatch(plan,/TEMP B-TREE|SCAN agent_bonds|SCAN peer_dm_messages/);
 }
 const inbox=f.store.agentInbox(friend.secret,roomId,{limit:3});assert.equal(inbox.coverage.peer.peerMessages.complete,false);assert.ok(inbox.next.some(x=>x.action==='inspect-peer-messages'));
 // The source's fixed byte admission runs before SELECT * can materialize
 // a corrupted large body, even if a small response limit was requested.
 f.store.db.prepare("UPDATE peer_dm_messages SET body=? WHERE message_id=(SELECT message_id FROM peer_dm_messages ORDER BY created_at DESC LIMIT 1)").run('x'.repeat(40000));
 bodyReads=0;f.store.db.prepare=sql=>{if(sql==='SELECT * FROM peer_dm_messages WHERE message_id=?')bodyReads++;return prepare(sql);};
 try{assert.throws(()=>f.store.bonds.nativeInboxForMember(roomId,friend.identityId,3,()=>{}),e=>e.code==='current_room_context_unavailable');assert.equal(bodyReads,0);}finally{f.store.db.prepare=prepare;}
});
