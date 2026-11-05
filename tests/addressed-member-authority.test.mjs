import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';
function events({count=100,large=false,purposeBytes=0,knownMetadata=false}={}){
 const list=initialRoom();if(knownMetadata){list[0].data.title='界'.repeat(4096);list[0].data.purpose='界'.repeat(4096);}if(purposeBytes)list[0].data.purpose='p'.repeat(purposeBytes);
 for(let i=1;i<count;i++){const memberId=`member-${String(i).padStart(3,'0')}`;list.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId,displayName:memberId,kind:'agent',permissions:[]}}));
  if(large&&i!==1)list.push(event({roomId:'commons',actorId:memberId,type:'capabilities.advertised',data:{capabilities:Array.from({length:30},(_,j)=>String(j).padStart(2,'0')+'x'.repeat(78))}}));}
 if(knownMetadata)list.push(event({roomId:'commons',actorId:'owner',type:'room.charter_updated',data:{expectedRevision:0,purpose:'界'.repeat(1000),outputs:'界'.repeat(1000),boundaries:'界'.repeat(1000),escalation:'界'.repeat(1000)}}));
 return list;
}
function fixture(t,options={}){
 const legacy=new RoomStore(':memory:'),identity=options.identity?legacy.identities.create('Authority fixture agent'):null,list=events(options);
 if(identity)list.find(e=>e.data.memberId==='member-001').data.identityId=identity.identityId;
 list.push(event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'selected-work',title:'Selected work',definitionOfDone:'A useful result',accountableMemberId:'member-001'}}));
 legacy.initialize(structuredClone(list));
 if(identity)linkWithProof(legacy,legacy.issueAccessKey('commons','owner'),'commons',identity,{memberId:'member-001',permissions:[]});
 const token=legacy.issueAccessKey('commons','member-001'),row=legacy.db.prepare('SELECT * FROM credentials WHERE hash=?').get(createHash('sha256').update(token).digest('hex'));
 const identityRows=identity?['agent_identities','identity_links'].map(table=>[table,legacy.db.prepare('SELECT * FROM '+table).all()]):[];legacy.close();
 const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(list,{representation:'normalized-current-v1'});
 // A credential legitimately issued before migration; credentials remain their
 // existing authority table and are unchanged by normalized conversion.
 const fields=Object.keys(row);store.transaction(()=>store.db.prepare(`INSERT INTO credentials(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...fields.map(key=>row[key])));
 for(const [table,rows]of identityRows)for(const row of rows){const fields=Object.keys(row);store.transaction(()=>store.db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...fields.map(key=>row[key])));}
 return {store,token,identity};
}
test('existing short-profile access credential authenticates in a legal100-member normalized room',t=>{
 const {store,token}=fixture(t);assert.equal(store.authenticate(token,'commons').member.id,'member-001');
});
test('issuing a selected member key in a legal100-member room does not require full roster hydration',t=>{
 const {store}=fixture(t),token=store.issueAccessKey('commons','member-001');assert.equal(store.authenticate(token,'commons').member.id,'member-001');
});
test('selected principal authority ignores large unrelated advertised profiles',t=>{
 const {store,token}=fixture(t,{large:true}),authority=store.roomAuthority('commons',{memberId:'member-001',includeHistory:true});
 assert.equal(authority.members['member-001'].id,'member-001');assert.equal(authority.ownerId,'owner');assert.deepEqual(Object.keys(authority.members).sort(),['member-001','owner']);
 assert.equal(store.authenticate(token,'commons').member.id,'member-001');
});

test('actual selected work read at100 members does not pull unrelated advertised profiles',t=>{
 const {store,token}=fixture(t,{large:true}),read=store.workContext(token,'commons','selected-work');assert.equal(read.work.definitionOfDone,'A useful result');assert.equal(read.viewerId,'member-001');
});
test('pre-migration holder-proved identity secret and scoped API key retain fresh100-member authority and revocation',t=>{
 const {store,identity}=fixture(t,{identity:true,large:true});assert.equal(store.authenticate(identity.secret,'commons').member.id,'member-001');
 const issued=store.agentPlugin.issueApiKey({identityId:identity.identityId,scopes:['rooms:read','mcp:room:commons']}),apiKey='rak_'+issued.secret;
 assert.equal(store.authenticate(apiKey,'commons').member.id,'member-001');
 assert.throws(()=>store.authenticate(apiKey,'elsewhere'),e=>[401,403].includes(e.status));
 store.identities.revoke(identity.identityId,identity.secret);assert.throws(()=>store.authenticate(identity.secret,'commons'),e=>e.status===401);assert.throws(()=>store.authenticate(apiKey,'commons'),e=>e.status===401);
});
test('room scope, parent credential revocation and session binding remain enforced at100 members',t=>{
 const {store,token}=fixture(t);assert.throws(()=>store.authenticate(token,'elsewhere'),e=>e.status===403);
 const session=store.createJoinSession('commons','member-001');assert.equal(store.authenticate(session.token,'commons').member.id,'member-001');assert.throws(()=>store.authenticate(session.token,'commons','wrong-binding'),e=>e.code==='session_binding_changed');
 const replacement=store.issueAccessKey('commons','member-001');assert.throws(()=>store.authenticate(token,'commons'),e=>e.status===401);assert.equal(store.authenticate(replacement,'commons').member.id,'member-001');
});
import {withCurrentServingWriter,withCurrentReadContext} from '../server/current-room-repository.mjs';
test('selected and owner payload corruption fail closed after an earlier successful authentication',t=>{
 for(const id of ['member-001','owner']){
  const {store,token}=fixture(t);assert.equal(store.authenticate(token,'commons').member.id,'member-001');
  // Controlled code-owned permit fault injection, not a production writer.
  store.transaction(()=>withCurrentServingWriter(store.db,'commons',()=>store.db.prepare("DELETE FROM current_room_records WHERE room_id=? AND domain='members' AND record_key=?").run('commons',id)));
  assert.throws(()=>store.authenticate(token,'commons'),e=>/^current_room_corrupt:/.test(e.message));
 }
});
test('human account and child session checks remain intact in a100-member room',t=>{
 const {store}=fixture(t),ownerKey=store.issueAccessKey('commons','owner'),session=store.createSession(ownerKey);
 assert.equal(store.authenticate(session.token,'commons',session.session.sessionBinding).member.id,'owner');
 store.revokeRoomCredential('commons','owner',ownerKey);assert.throws(()=>store.authenticate(session.token,'commons'),e=>e.status===401);
});
test('source envelope rejects a128KiB purpose rather than treating it as a legal metadata edge',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());assert.throws(()=>store.initialize(events({count:2,purposeBytes:128000}),{representation:'normalized-current-v1'}),/Invalid purpose/);
});
test('known maximum title purpose and charter fields preserve selected auth budget',t=>{
 const {store,token}=fixture(t,{large:true,knownMetadata:true});let measured;
 const read=store.readTransaction(()=>withCurrentReadContext(store.db,'commons',b=>{try{return store.workContext(token,'commons','selected-work');}finally{measured={bytes:b.bytes,records:b.records};}}));
 assert.equal(read.work.definitionOfDone,'A useful result');
 const row=store.db.prepare("SELECT payload_bytes FROM current_room_records WHERE room_id=? AND domain='metadata' AND record_key='room'").get('commons');
 console.log('ADDRESSED_ROOM_METADATA_BOUNDARY '+JSON.stringify({roomPayloadBytes:row.payload_bytes,selectedInput:measured,maxInputBytes:262144,maxInputUnits:200,globalLimitUnchanged:true}));
});
