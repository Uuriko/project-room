import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';import {AgentRooms} from '../server/agent-rooms.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {classifyOwnedRooms,planAccountDeletion} from '../server/account-deletion.mjs';
function fixture(t,{normalized=true,count=4,successorAccount=true,configure=()=>{},filename=':memory:',linked=false}={}){
 const s=new RoomStore(filename);t.after(()=>{try{s.close();}catch{}});const es=initialRoom();es[0].data.kind='organization';
 for(let i=1;i<count;i++){const id=i===1?'successor':i===2?'worker':'agent-'+i;es.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:id,displayName:id,kind:i===1?'human':'agent',permissions:['accept_work','complete_work']}}));}
 es.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'task',title:'Project task',definitionOfDone:'Saved project result',accountableMemberId:'worker'}}));
 configure(es);let identity=null,identityRows=[];
 if(linked){const legacy=new RoomStore(':memory:');identity=legacy.identities.create('Continuity delegate');es.find(e=>e.data.memberId==='worker').data.identityId=identity.identityId;legacy.initialize(structuredClone(es));linkWithProof(legacy,legacy.issueAccessKey('commons','owner'),'commons',identity,{memberId:'worker',permissions:es.find(e=>e.data.memberId==='worker').data.permissions});identityRows=['agent_identities','identity_links'].map(table=>[table,legacy.db.prepare('SELECT * FROM '+table).all()]);legacy.close();}
 s.initialize(es,normalized?{representation:'normalized-current-v1'}:undefined);const owner=s.issueAccessKey('commons','owner'),successor=successorAccount?s.issueAccessKey('commons','successor'):null;
 for(const[table,rows]of identityRows)for(const row of rows){const fields=Object.keys(row);s.transaction(()=>s.db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...fields.map(key=>row[key])));}
 const accountId=s.db.prepare("SELECT account_id FROM member_accounts WHERE room_id='commons' AND member_id='owner'").get().account_id;
 return {s,owner,successor,accountId,identity,rooms:new AgentRooms(s)};
}
test('normalized ownership transfer preserves the same explicit owner appointment and exact lost-response retry',t=>{
 const {s,owner,successor,rooms}=fixture(t),before=s.db.prepare('SELECT * FROM work_entities').all();s.room=()=>{throw Error('whole room hydration');};
 const result=rooms.transfer(owner,'commons',{toMemberId:'successor',reason:'Authorized successor'});assert.equal(result.ownerId,'successor');assert.equal(result.duplicate,false);
 assert.equal(rooms.transfer(owner,'commons',{toMemberId:'successor'}).duplicate,true);assert.equal(s.roomAuthority('commons',{memberId:'successor'}).ownerId,'successor');
 assert.equal(rooms.transfer(successor,'commons',{toMemberId:'owner'}).ownerId,'owner');assert.deepEqual(s.db.prepare('SELECT * FROM work_entities').all(),before);
});
test('normalized deletion preview includes protected room and succession dependency instead of omitting unavailable room',t=>{
 const {s,accountId}=fixture(t);s.room=()=>{throw Error('whole room hydration');};
 const disposition=classifyOwnedRooms(s,accountId);assert.equal(disposition.transfer.length,1);assert.equal(disposition.transfer[0].toMemberId,'successor');
 const {plan}=planAccountDeletion(s,accountId);assert.ok(plan.steps.some(step=>step.category==='owned_rooms'));assert.equal(plan.rooms.transfer[0].id,'commons');
});
import {withCurrentServingWriter} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
test('shared normalized room without an eligible account heir blocks deletion instead of inventing a successor',t=>{
 const {s,accountId}=fixture(t,{successorAccount:false});const rooms=classifyOwnedRooms(s,accountId);assert.equal(rooms.blocked.length,1);assert.equal(rooms.transfer.length,0);assert.equal(rooms.archive.length,0);
});
test('temporary account-bound guest without login remains ineligible to inherit a normalized project',t=>{
 const {s,accountId}=fixture(t),binding=s.db.prepare("SELECT account_id FROM member_accounts WHERE member_id='successor'").get();
 s.transaction(()=>s.db.prepare("UPDATE accounts SET origin='share-link-guest' WHERE id=?").run(binding.account_id));
 const rooms=classifyOwnedRooms(s,accountId);assert.equal(rooms.blocked.length,1);assert.equal(rooms.transfer.length,0);
});
test('legal100 member inventory and transfer require no work/history or unrelated profile hydration',t=>{
 const {s,owner,accountId,rooms}=fixture(t,{count:100,configure:es=>{for(let i=3;i<100;i++)es.push(event({roomId:'commons',actorId:'agent-'+i,type:'capabilities.advertised',data:{capabilities:Array.from({length:30},(_,j)=>String(j).padStart(2,'0')+'x'.repeat(78))}}));}});
 s.room=()=>{throw Error('whole room hydration');};const read=s.db.prepare.bind(s.db);let workReads=0,profileReads=0;
 s.db.prepare=sql=>new Proxy(read(sql),{get(target,key){const fn=Reflect.get(target,key,target);if(!['get','all','iterate'].includes(key))return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{if(/SELECT.*FROM work_entities/.test(sql))workReads++;if(sql.includes('SELECT payload FROM current_room_records')&&args.includes('members')&&args.some(v=>typeof v==='string'&&v.startsWith('agent-')))profileReads++;return fn.apply(target,args);};}});
 assert.equal(classifyOwnedRooms(s,accountId).transfer[0].toMemberId,'successor');rooms.transfer(owner,'commons',{toMemberId:'successor'});assert.equal(workReads,0);assert.equal(profileReads,0);
});
test('transfer does not grant an unrelated caller authority or expose an inactive target',t=>{
 const {s,owner,successor,rooms}=fixture(t,{configure:es=>es.push(event({roomId:'commons',actorId:'owner',type:'member.access_changed',data:{memberId:'worker',expectedMemberRevision:0,permissions:['accept_work','complete_work'],active:false}}))});
 assert.throws(()=>rooms.transfer(successor,'commons',{toMemberId:'successor'}),e=>e.status===403);
 for(const toMemberId of ['worker','not-a-member'])assert.throws(()=>rooms.transfer(owner,'commons',{toMemberId}),e=>e.status===404&&e.code==='unknown_member');
 assert.equal(s.roomAuthority('commons',{memberId:'owner'}).ownerId,'owner');
});
test('missing protected inventory member fails closed without a misleading empty deletion preview',t=>{
 const {s,accountId}=fixture(t);s.transaction(()=>withCurrentServingWriter(s.db,'commons',()=>s.db.prepare("DELETE FROM current_room_records WHERE room_id='commons' AND domain='members' AND record_key='successor'").run()));
 assert.throws(()=>classifyOwnedRooms(s,accountId),e=>/current_room_corrupt/.test(e.message));
});
test('normalized transfer rollback and exact replay preserve work and immutable state',t=>{
 const {s,owner,rooms}=fixture(t),tables=['events','commands','rooms','current_room_records','current_room_record_proofs','operator_actions','work_entities'];
 const rows=()=>Object.fromEntries(tables.map(name=>[name,s.db.prepare('SELECT * FROM '+name).all()])),before=rows(),prepare=s.db.prepare.bind(s.db);let fired=false;
 s.db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const result=fn.apply(target,args);if(/^INSERT INTO current_room_head/.test(sql)){fired=true;throw Error('transfer interrupted');}return result;};}});
 try{assert.throws(()=>rooms.transfer(owner,'commons',{toMemberId:'successor'}),/transfer interrupted/);}finally{s.db.prepare=prepare;}
 assert.equal(fired,true);assert.deepEqual(rows(),before);rooms.transfer(owner,'commons',{toMemberId:'successor'});const committed=rows();assert.equal(rooms.transfer(owner,'commons',{toMemberId:'successor'}).duplicate,true);assert.deepEqual(rows(),committed);assert.doesNotThrow(()=>auditRecovery(s));
});
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('cold restart retains successor authority and exact retry but revoked former-owner credential never replays',t=>{
 const dir=mkdtempSync(join(tmpdir(),'current-successor-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const filename=join(dir,'room.sqlite'),{s,owner,successor,rooms}=fixture(t,{filename});rooms.transfer(owner,'commons',{toMemberId:'successor'});s.close();
 const cold=new RoomStore(filename);t.after(()=>cold.close());cold.room=()=>{throw Error('whole room hydration');};const api=new AgentRooms(cold);assert.equal(cold.authenticate(successor,'commons').member.id,'successor');assert.equal(api.transfer(owner,'commons',{toMemberId:'successor'}).duplicate,true);
 cold.issueAccessKey('commons','owner');assert.throws(()=>api.transfer(owner,'commons',{toMemberId:'successor'}),e=>e.status===401);
 assert.equal(cold.roomAuthority('commons',{memberId:'successor'}).ownerId,'successor');
});
test('agent outgoing owner loses exclusive administration on explicit human appointment',t=>{
 const s=new RoomStore(':memory:');t.after(()=>s.close());const es=initialRoom();es[1].data.kind='agent';es.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'human',displayName:'Human',kind:'human',permissions:['accept_work']}}));s.initialize(es,{representation:'normalized-current-v1'});const key=s.issueAccessKey('commons','owner');new AgentRooms(s).transfer(key,'commons',{toMemberId:'human'});
 const authority=s.roomAuthority('commons',{memberId:'owner'});assert.equal(authority.ownerId,'human');assert.equal(authority.members.owner.permissions.includes('manage_members'),false);assert.equal(authority.members.owner.permissions.includes('decide'),false);assert.equal(authority.members.human.permissions.includes('manage_members'),true);
});
test('outgoing owner personal delegations are revoked and never inherited by successor',t=>{
 const {s,owner,rooms,identity}=fixture(t,{linked:true,configure:es=>es.find(e=>e.data.memberId==='worker').data.permissions.push('invite_member')});
 s.ownerDelegates.grant(owner,'commons',{identityId:identity.identityId});s.delegation.grant(owner,'commons',{identityId:identity.identityId});
 assert.equal(s.ownerDelegates.hasGrant('commons',identity.identityId),true);assert.equal(s.delegation.hasGrant('commons',identity.identityId),true);
 rooms.transfer(owner,'commons',{toMemberId:'successor'});
 assert.equal(s.ownerDelegates.hasGrant('commons',identity.identityId),false);assert.equal(s.delegation.hasGrant('commons',identity.identityId),false);
 // This bit existed independently before delegation and is deliberately kept
 // under the established legacy added_invite_member=0 rule.
 assert.equal(s.roomAuthority('commons',{memberId:'worker'}).members.worker.permissions.includes('invite_member'),true);
});
test('unqualified delegation permission-strip dependency refuses before any transfer mutation',t=>{
 const {s,owner,rooms}=fixture(t);
 // Synthetic old-state dependency fault, not a grant or a migration claim.
 // A real migrated grant requiring a strip must not silently retain that bit.
 s.transaction(()=>s.db.prepare("INSERT INTO membership_delegation_grants(room_id,identity_id,granted_by,granted_at,added_invite_member) VALUES('commons','synthetic-delegate','owner',1,1)").run());
 const tables=['rooms','events','commands','current_room_records','current_room_record_proofs','operator_actions','membership_delegation_grants'];const rows=()=>Object.fromEntries(tables.map(table=>[table,s.db.prepare('SELECT * FROM '+table).all()])),before=rows();
 assert.throws(()=>rooms.transfer(owner,'commons',{toMemberId:'successor'}),e=>e.code==='current_room_context_unavailable'&&/Revoke membership delegation/.test(e.message));assert.deepEqual(rows(),before);
});
test('authorized replacement runtime resumes exact saved agent work after credential rotation and cold restart',t=>{
 const dir=mkdtempSync(join(tmpdir(),'project-agent-replacement-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const filename=join(dir,'room.sqlite'),{s}=fixture(t,{filename});
 const old=s.issueAccessKey('commons','worker');s.command(old,'commons',{id:'old-accept',type:'work.accepted',data:{workItemId:'task',expectedRevision:0}});
 const current=s.issueAccessKey('commons','worker'),body=s.db.prepare("SELECT body FROM work_entities WHERE work_id='task'").get().body;assert.throws(()=>s.authenticate(old,'commons'),e=>e.status===401);s.close();
 const cold=new RoomStore(filename);t.after(()=>cold.close());assert.equal(cold.db.prepare("SELECT body FROM work_entities WHERE work_id='task'").get().body,body);
 assert.equal(cold.command(current,'commons',{id:'replacement-start',type:'work.started',data:{workItemId:'task',expectedRevision:1}}).event.actorId,'worker');
});
