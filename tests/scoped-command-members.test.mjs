import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event,PERMISSIONS} from '../src/events.js';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {currentCommandContext,withCurrentReadContext} from '../server/current-room-repository.mjs';
function fixture(t,{count=100,large=false,linked=false,configure=()=>{}}={}){
 const events=initialRoom();
 for(let i=1;i<count;i++){
  const memberId=`member-${String(i).padStart(3,'0')}`;
  events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId,displayName:memberId,kind:'agent',permissions:[...PERMISSIONS]}}));
  if(large&&i>3)events.push(event({roomId:'commons',actorId:memberId,type:'capabilities.advertised',data:{capabilities:Array.from({length:30},(_,j)=>String(j).padStart(2,'0')+'x'.repeat(78))}}));
 }
 configure(events);let identityRows=[];
 if(linked){
  const legacy=new RoomStore(':memory:'),identity=legacy.identities.create('Linked Alias');
  events.find(e=>e.data.memberId==='member-001').data.identityId=identity.identityId;
  legacy.initialize(structuredClone(events));linkWithProof(legacy,legacy.issueAccessKey('commons','owner'),'commons',identity,{memberId:'member-001',permissions:[...PERMISSIONS]});
  identityRows=['agent_identities','identity_links'].map(table=>[table,legacy.db.prepare('SELECT * FROM '+table).all()]);legacy.close();
 }
 const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(events,{representation:'normalized-current-v1'});
 for(const [table,rows]of identityRows)for(const row of rows){const fields=Object.keys(row);store.transaction(()=>store.db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...fields.map(key=>row[key])));}
 return {store,owner:store.issueAccessKey('commons','owner'),agent:store.issueAccessKey('commons','member-001')};
}
const post=(id,body='Useful ordinary text')=>({id,type:'message.posted',data:{messageId:id,body}});
test('ordinary post at100 members does not hydrate the roster',t=>{
 const {store,owner}=fixture(t);const result=store.command(owner,'commons',post('plain'));
 assert.equal(result.event.actorId,'owner');assert.equal(result.event.data.body,'Useful ordinary text');
 assert.equal(store.command(owner,'commons',post('plain')).duplicate,true);
});
test('unrelated large legal profiles do not prevent an addressed work assignment',t=>{
 const {store,owner,agent}=fixture(t,{large:true});
 const result=store.command(owner,'commons',{id:'propose',type:'work.proposed',data:{workItemId:'task',title:'Useful task',definitionOfDone:'A saved result',accountableMemberId:'member-001',verifierMemberId:'member-002'}});
 assert.equal(result.event.actorId,'owner');
 assert.equal(store.command(agent,'commons',{id:'accept',type:'work.accepted',data:{workItemId:'task',expectedRevision:0}}).event.actorId,'member-001');
});
import {textVersion} from '../server/text-results.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {withCurrentServingWriter} from '../server/current-room-repository.mjs';
test('100-member native work runs through result, independent review and owner decision without deleting unrelated authority',t=>{
 const {store,owner,agent}=fixture(t,{large:true}),verifier=store.issueAccessKey('commons','member-002');
 const cmd=(key,id,type,data)=>store.command(key,'commons',{id,type,data});
 const untouched=store.db.prepare("SELECT payload,payload_sha256 FROM current_room_records WHERE domain='members' AND record_key='member-099'").get();
 store.room=()=>{throw Error('whole-room hydration');};
 cmd(owner,'propose','work.proposed',{workItemId:'task',title:'Useful task',definitionOfDone:'Independent saved result',accountableMemberId:'member-001',verifierMemberId:'member-002',humanDecisionMakerId:'owner',independentVerificationRequired:true,ownerDecisionRequired:true});
 cmd(agent,'accept','work.accepted',{workItemId:'task',expectedRevision:0});
 cmd(agent,'start','work.started',{workItemId:'task',expectedRevision:1});
 const body='Exact saved result',posted=cmd(agent,'result','message.posted',{messageId:'result',body,workItemId:'task'}),version=textVersion(body);
 const done=cmd(agent,'complete','work.completed',{workItemId:'task',expectedRevision:2,evidenceKind:'room_text',evidenceMessageId:'result',evidenceMessageEventId:posted.event.id,evidenceVersion:version,producerId:'member-003',previousCompletionEventId:null,summary:'Saved result',nextAction:'Review'});
 const review={workItemId:'task',expectedRevision:3,result:'pass',completionEventId:done.event.id,evidenceVersion:version,summary:'Independently checked'};
 assert.throws(()=>cmd(agent,'wrong-review','verification.recorded',review),/designated verifier/);
 cmd(verifier,'verify','verification.recorded',review);
 cmd(owner,'rationale','message.posted',{messageId:'rationale',body:'I reviewed the exact saved result'});
 cmd(owner,'approve','owner.decision_recorded',{workItemId:'task',expectedRevision:4,decision:'approved',completionEventId:done.event.id,evidenceVersion:version,reason:'Useful and correct',sourceMessageId:'rationale'});
 assert.deepEqual(store.db.prepare("SELECT payload,payload_sha256 FROM current_room_records WHERE domain='members' AND record_key='member-099'").get(),untouched);
 assert.equal(JSON.parse(store.db.prepare("SELECT body FROM work_entities WHERE work_id='task'").get().body).decision.decision,'approved');
 assert.doesNotThrow(()=>auditRecovery(store));
});
test('mention path preserves full roster resolution at100 short profiles',t=>{
 const {store,owner}=fixture(t);
 const result=store.command(owner,'commons',post('mention','@member-099 please review'));
 assert.equal(result.event.data.body,'@member-099 please review');
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM activity_events WHERE message_id='mention' AND user_id='member-099'").get().n,1);
});
test('trusted actor option ignores caller-invented command actor and uses protected member facts',t=>{
 const {store,agent}=fixture(t,{large:true});let measured;
 const command={...post('spoof'),actorId:'member-099'};
 const context=store.readTransaction(()=>withCurrentReadContext(store.db,'commons',b=>{
  const value=currentCommandContext(store,'commons',command,{actorId:'member-001'});measured={records:b.records,bytes:b.bytes};return value;
 }));
 assert.deepEqual(Object.keys(context.room.state.members).sort(),['member-001','owner']);
 assert.ok(measured.records<=200);assert.throws(()=>store.command(agent,'commons',command),e=>e.code==='invalid_command');assert.equal(store.command(agent,'commons',post('honest')).event.actorId,'member-001');
});
test('missing assignee and corrupt selected member remain refusals with sparse command authority',t=>{
 const {store,owner}=fixture(t,{large:true});
 // Existing code-owned format permit is used solely for controlled fault and
 // authority-gate fixture setup; no new production mutation path is introduced.
 const propose=id=>({id,type:'work.proposed',data:{workItemId:id,title:'Task',definitionOfDone:'Saved',accountableMemberId:'missing'}});
 assert.throws(()=>store.command(owner,'commons',propose('unknown')),/member/i);
 store.transaction(()=>withCurrentServingWriter(store.db,'commons',()=>{
  // Corrupting a selected proof-bound payload must fail closed, never borrow
  // the authenticated in-memory member or a caller's actor object.
  store.db.prepare("UPDATE current_room_records SET payload='{}' WHERE domain='members' AND record_key='member-001'").run();
 }));
 assert.throws(()=>store.command(owner,'commons',{...propose('corrupt'),data:{...propose('corrupt').data,accountableMemberId:'member-001'}}),/current_room_corrupt/);
});
test('longest display alias keeps precedence over a shorter exact member ID at100 members',t=>{
 const {store,owner}=fixture(t,{configure:events=>{events.find(e=>e.data.memberId==='member-098').data.displayName='member-099 review';}});
 store.command(owner,'commons',post('longest','@member-099 review this'));
 const targets=store.db.prepare("SELECT user_id FROM activity_events WHERE message_id='longest' ORDER BY user_id").all().map(row=>row.user_id);
 assert.deepEqual(targets,['member-098']);
});
test('cross-owner assignment and wake keep existing trust-off behavior',t=>{
 const {store,owner}=fixture(t,{configure:events=>{
  const foreign=events.find(e=>e.data.memberId==='member-002');foreign.data.kind='human';
  const agent=events.find(e=>e.data.memberId==='member-003');agent.data.accountableHumanId='member-002';
  events.push(event({roomId:'commons',actorId:'owner',type:'room.trust_set',data:{enabled:false}}));
 }});
 assert.throws(()=>store.command(owner,'commons',{id:'foreign',type:'work.proposed',data:{workItemId:'foreign',title:'Foreign work',definitionOfDone:'Saved',accountableMemberId:'member-003'}}),e=>e.code==='trust_off');
 const posted=store.command(owner,'commons',post('foreign-mention','@member-003 please review'));
 assert.match(posted.note,/Trust is off/);
});
test('sparse command interrupted save rolls back and same ID retry preserves every other member',t=>{
 const {store,owner}=fixture(t,{large:true}),command=post('interrupted'),tables=['events','commands','current_room_records','current_room_record_proofs','operator_actions'];
 const rows=()=>Object.fromEntries(tables.map(table=>[table,store.db.prepare('SELECT * FROM '+table).all()]));
 const before=rows(),prepare=store.db.prepare.bind(store.db);let fired=false;
 store.db.prepare=sql=>new Proxy(prepare(sql),{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='run')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const out=fn.apply(target,args);if(/^INSERT INTO current_room_head/.test(sql)){fired=true;throw Error('interrupted save');}return out;};}});
 try{assert.throws(()=>store.command(owner,'commons',command),/interrupted save/);}finally{store.db.prepare=prepare;}
 assert.equal(fired,true);assert.deepEqual(rows(),before);store.command(owner,'commons',command);const committed=rows();
 assert.equal(store.command(owner,'commons',command).duplicate,true);assert.deepEqual(rows(),committed);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM current_room_records WHERE domain='members'").get().n,100);
});
test('100-member private reply inherits exact parties and bystanders remain denied',t=>{
 const {store,owner,agent}=fixture(t,{large:true}),other=store.issueAccessKey('commons','member-002');
 store.command(owner,'commons',{id:'private',type:'message.posted',data:{messageId:'private',body:'Private task context',toMemberId:'member-001'}});
 const reply=store.command(agent,'commons',{id:'reply',type:'message.posted',data:{messageId:'reply',body:'Private saved reply',replyToId:'private'}});
 assert.equal(reply.event.data.toMemberId,'owner');
 assert.throws(()=>store.command(other,'commons',{id:'bystander',type:'message.posted',data:{messageId:'bystander',body:'Injection',replyToId:'private'}}),e=>e.status===422);
});
test('100-member request response and cancellation retain exact selected party checks',t=>{
 const {store,owner,agent}=fixture(t,{large:true}),other=store.issueAccessKey('commons','member-002');
 store.command(owner,'commons',{id:'request',type:'message.posted',data:{messageId:'request',body:'Please reply',toMemberId:'member-001',requestKind:'reply'}});
 const command={id:'cancel',type:'reply_request.cancelled',data:{requestMessageId:'request',expectedRequestRevision:0,reason:'No longer needed'}};
 assert.throws(()=>store.command(other,'commons',command),e=>e.status===422);
 assert.throws(()=>store.command(agent,'commons',command),e=>e.status===422);
 assert.equal(store.command(owner,'commons',command).event.type,'reply_request.cancelled');
});
test('internal claim context with absent or unknown actor retains the owner for existing fallback',t=>{
 const {store}=fixture(t,{large:true});
 for(const actorId of [undefined,'retired-member']){
  const context=store.readTransaction(()=>withCurrentReadContext(store.db,'commons',()=>currentCommandContext(store,'commons',{id:'claim-context',type:'work_claim.updated',data:{}},{actorId})));
  assert.equal(context.room.state.members.owner.id,'owner');
  assert.equal(Object.hasOwn(context.room.state.members,'retired-member'),false);
 }
});
test('ordinary post skips linked identity alias enumeration while actual alias mentions still resolve',t=>{
 const {store,owner}=fixture(t,{linked:true}),prepare=store.db.prepare.bind(store.db);let aliasReads=0;
 store.db.prepare=sql=>{if(sql.includes('SELECT l.member_id AS memberId, i.display_name AS displayName FROM identity_links l'))aliasReads++;return prepare(sql);};
 store.command(owner,'commons',post('no-alias'));
 assert.equal(aliasReads,0);
 store.command(owner,'commons',post('alias','@Linked Alias please review'));
 assert.ok(aliasReads>0);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM activity_events WHERE message_id='alias' AND user_id='member-001'").get().n,1);
});
