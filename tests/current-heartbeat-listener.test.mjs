import {scopedKeyRoomBinding} from '../server/room-key-presence.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';import {heartbeatWithListener} from '../server/agent-listener-contract.mjs';import {assertListenerFence} from '../server/listener-fence.mjs';
function setup(t){const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(initialRoom(),{representation:'normalized-current-v1'});const key=store.issueAccessKey('commons','owner'),identity=store.identities.create('Existing receiving agent');linkWithProof(store,key,'commons',identity,{memberId:'receiver',permissions:[]});return {store,identity};}
test('normalized identity heartbeat acquires and renews exact room listener without whole-room hydration',t=>{
 const {store:s,identity}=setup(t),auth={identityId:identity.identityId};s.room=()=>{throw Error('Whole-room heartbeat read forbidden');};
 const first=s.transaction(()=>heartbeatWithListener(s,auth,{hostId:'host',mode:'wakeable',cadenceSeconds:60,listenerLease:{roomId:'commons'}}));assert.equal(first.listener.acquired,true);
 s.transaction(()=>assertListenerFence(s,auth,'commons',first.listener.fencingToken));
 const next=s.transaction(()=>heartbeatWithListener(s,auth,{hostId:'host',mode:'wakeable',cadenceSeconds:60,listenerLease:{roomId:'commons'}}));assert.equal(next.listener.renewed,true);assert.equal(next.listener.fencingToken,first.listener.fencingToken);
});
test('normalized listener refuses an unrelated identity and rolls back heartbeat side effects',t=>{
 const {store:s}=setup(t),other=s.identities.create('Unrelated receiver');
 assert.throws(()=>s.transaction(()=>heartbeatWithListener(s,{identityId:other.identityId},{hostId:'foreign-host',mode:'wakeable',listenerLease:{roomId:'commons'}})),e=>e.code==='room_mismatch');
 assert.equal(s.db.prepare('SELECT count(*) n FROM agent_hosts WHERE agent_id=?').get(other.identityId).n,0);
 const leasesExist=s.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_wake_listener_leases'").get();
 if(leasesExist)assert.equal(s.db.prepare('SELECT count(*) n FROM agent_wake_listener_leases WHERE agent_id=?').get(other.identityId).n,0);
});

// The room-scoped API-key door must re-read selected authority on every call.
test('normalized scoped key binding refuses suspension without hydrating room history',t=>{
 const {store:s,identity}=setup(t);
 const auth={identityId:identity.identityId,keyId:'synthetic-scoped-key',scopes:['mcp:wake','mcp:room:commons']};
 s.room=()=>{throw Error('Whole-room scoped heartbeat read forbidden');};
 assert.equal(scopedKeyRoomBinding(s,auth).roomId,'commons');
 const member=s.roomAuthority('commons',{memberId:'receiver'}).members.receiver;
 const owner=s.issueAccessKey('commons','owner');
 s.command(owner,'commons',{id:'suspend-scoped-receiver',type:'member.access_changed',data:{memberId:'receiver',expectedMemberRevision:member.revision,permissions:member.permissions,active:false}});
 assert.throws(()=>scopedKeyRoomBinding(s,auth),e=>e.code==='scoped_key_room_refused');
 assert.ok(s.db.prepare('SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?').get('commons',identity.identityId),'retained identity link does not override suspension');
});
