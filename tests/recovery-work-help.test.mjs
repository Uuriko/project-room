import test from 'node:test';import assert from 'node:assert/strict';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {auditRecovery} from '../server/recovery.mjs';
import {RoomStore} from '../server/store.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows} from '../server/restore-admission.mjs';
import {initialRecoveryWorkHelp,advanceRecoveryWorkHelp} from '../server/recovery-work-help.mjs';
import {initialRecoveryProjectionScan,scanRecoveryProjectionChunk,REPLAY_CODEC_INPUT_BYTES} from '../server/replay-projection-codec.mjs';
import {seedRecoveryWorkHelpSource} from './helpers/recovery-work-help-source.mjs';
const token=['synthetic','work','help','restore','1101'].join('-');
async function post(store,body){const r=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),token,store);return{status:r.status,body:await r.json()};}
async function fixture(t,{checkpoint=true,duplicateCheckpoint=false}={}){
 const source=new RoomStore(':memory:');t.after(()=>source.close());seedRecoveryWorkHelpSource(source,{checkpoint});if(duplicateCheckpoint){const row=source.db.prepare("SELECT projection FROM projection_checkpoints WHERE room_id='legacy-room'").get(),value=JSON.parse(row.projection);source.transaction(()=>source.db.prepare("UPDATE projection_checkpoints SET projection=? WHERE room_id='legacy-room'").run(row.projection.slice(0,-1)+',\"room\":'+JSON.stringify(value.room)+'}'));assert.doesNotThrow(()=>auditRecovery(source));}const store=new RoomStore(':memory:');t.after(()=>store.close());let response=await post(store,exportNdjsonText(source.db)),calls=0;
 while(restoreProgress(store.db).progress?.audit?.stage!=='replay_events'){assert.equal(response.status,202,JSON.stringify(response.body.error));response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'help-prepare-'+calls++});assert.ok(calls<100);}
 const state=restoreProgress(store.db),step=(p,options)=>withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,state.restore_id,scratch=>advanceRecoveryWorkHelp(store,scratch,state.restore_id,'legacy-room',p,state.seal,options)));
 return{source,store,state,step};
}
for(const checkpoint of [false,true])test('exact historical help/offer/member/ownership facts compare current and checkpoint; checkpoint='+checkpoint,async t=>{
 const f=await fixture(t,{checkpoint});let p=initialRecoveryWorkHelp(),calls=0,offerAtoms=0;
 while(p.stage!=='complete'){const result=f.step(p);if(p.stage==='offers')offerAtoms+=result.units;p=result.cursor;assert.notEqual(p.stage,'deferred',p.reason);assert.ok(result.units<=32);assert.ok(++calls<100);}
 assert.equal(p.offers,2);assert.equal(p.relevant,1);assert.equal(p.helps,1);assert.equal(p.room.ownerId,'heir');assert.equal(p.checkpointChecked,true);assert.ok(p.offerChecks>0);t.diagnostic(JSON.stringify({calls,offerAtoms,checkpoint,sequence:p.sequence}));
});
function drive(f,until,p=initialRecoveryWorkHelp()){
 for(let i=0;i<1000;i++){if(until(p))return p;if(['complete','deferred'].includes(p.stage))throw Error('Target phase not reached: '+JSON.stringify(p));p=f.step(p,{maxUnits:1}).cursor;}throw Error('Too many help atoms');
}
function mutate(f,operation){withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,operation));}
function sequence(f,type,offerId){return f.source.db.prepare("SELECT sequence FROM events WHERE room_id='legacy-room' AND json_extract(body,'$.type')=? AND json_extract(body,'$.data.offerId')=?").get(type,offerId).sequence;}
for(const defect of ['missing-identity','wrong-identity','duplicate-identity','missing-selected','duplicate-selected','task-revision','accountable-permission','checkpoint-scope','current-member-revision'])test('independent global work-help phase refuses '+defect,async t=>{
 const f=await fixture(t);let p;
 if(defect==='checkpoint-scope')p=drive(f,p=>p.stage==='discover');
 else if(defect==='accountable-permission'){
  const seq=f.source.db.prepare("SELECT sequence FROM events WHERE room_id='legacy-room' AND json_extract(body,'$.type')='work.help_updated' ORDER BY sequence LIMIT 1").get().sequence;p=drive(f,p=>p.sequence===seq&&p.stage==='events');
 }else{const seq=sequence(f,defect==='missing-selected'?'work.help_offer_updated':'work.help_offer_opened',defect==='missing-selected'?'first-offer':'second-offer');p=drive(f,p=>p.sequence===seq&&p.stage==='events');}
 mutate(f,scratch=>{
  const get=(domain,key,lane='history')=>scratch.get(lane,'legacy-room',domain,key),set=(domain,key,value,lane='history')=>scratch.set(lane,'legacy-room',domain,key,value);
  const first=get('helpOffer','first-offer'),second=get('helpOffer','second-offer');
  if(defect==='missing-identity'||defect==='wrong-identity')set('helpIdentity',JSON.stringify([first.workItemId,first.invitation.eventId,first.offererId]),defect==='missing-identity'?null:'wrong-offer');
  if(defect==='duplicate-identity'){second.offererId=first.offererId;second.updatedById=first.offererId;set('helpOffer',second.id,second);}
  if(defect==='missing-selected')set('helpSelected','help-task',null);
  if(defect==='duplicate-selected'){
   for(const offer of [first,second]){offer.status='selected';offer.revision=1;offer.updatedById=offer.accountableMemberId;offer.reason='Conflicting selection';offer.externalActivityUnverified=false;offer.eventId='corrupt-selection-'+offer.id;set('helpOffer',offer.id,offer);}set('helpSelected','help-task',first.id);
  }
  if(defect==='task-revision'){const work=get('helpWork','help-task');work.revision++;set('helpWork',work.id,work);}
  if(defect==='accountable-permission'){const person=get('helpMember','owner');person.permissions=[];set('helpMember',person.id,person);}
  if(defect==='checkpoint-scope'){const work=get('helpCpWork','help-task');work.helpWanted.scope='Changed retained checkpoint scope';set('helpCpWork',work.id,work);}
  if(defect==='current-member-revision'){const person=get('members','worker','actual');person.revision++;set('members',person.id,person,'actual');}
 });
 assert.throws(()=>drive(f,p=>p.stage==='complete',p),/reconciliation|Unavailable|unavailable|Stale|Invalid|accountable|Offer|Target phase not reached/);
});

test('offer and derived indices save atomically; interrupted save leaves prior cursor and all scratch exact',async t=>{
 const f=await fixture(t),seq=sequence(f,'work.help_offer_opened','first-offer'),p=drive(f,p=>p.stage==='events'&&p.sequence===seq-1),before=f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all(),prepare=f.store.db.prepare.bind(f.store.db);let fired=false;
 f.store.db.prepare=sql=>{const statement=prepare(sql),run=statement.run.bind(statement);if(sql.startsWith('INSERT INTO current_restore_audit_scratch'))statement.run=(...args)=>{const result=run(...args);if(args[3]==='helpOffer'){fired=true;throw Error('help offer save interrupted');}return result;};return statement;};
 try{assert.throws(()=>f.step(p,{maxUnits:1}),/help offer save interrupted/);}finally{f.store.db.prepare=prepare;}
 assert.equal(fired,true);assert.deepEqual(f.store.db.prepare('SELECT * FROM current_restore_audit_scratch ORDER BY rowid').all(),before);assert.equal(p.sequence,seq-1);assert.equal(drive(f,p=>p.stage==='complete',p).offers,2);
});

test('ordinary, wrong restore and wrong seal callers refuse before source payload reads',async t=>{
 const f=await fixture(t),prepare=f.store.db.prepare.bind(f.store.db),p=initialRecoveryWorkHelp();let payloads=0;
 f.store.db.prepare=sql=>{if(/^SELECT (?:sequence,body|substr\(CAST\(projection)/.test(sql))payloads++;return prepare(sql);};
 try{
  assert.throws(()=>advanceRecoveryWorkHelp(f.store,{},f.state.restore_id,'legacy-room',p,f.state.seal),/reconciliation/);
  assert.throws(()=>withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryWorkHelp(f.store,scratch,'wrong','legacy-room',p,f.state.seal))),/reconciliation/);
  assert.throws(()=>withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,scratch=>advanceRecoveryWorkHelp(f.store,scratch,f.state.restore_id,'legacy-room',p,{...f.state.seal,id:'wrong'}))),/reconciliation/);
 }finally{f.store.db.prepare=prepare;}
 assert.equal(payloads,0);
});

test('source size is checked before transferring a corrupt oversized event atom',async t=>{
 const f=await fixture(t),p=drive(f,p=>p.stage==='discover'),prepare=f.store.db.prepare.bind(f.store.db);let payloads=0;
 f.store.db.prepare=sql=>{const statement=prepare(sql),get=statement.get.bind(statement);if(sql.startsWith('SELECT rowid,sequence,length(CAST(body AS BLOB))'))statement.get=(...args)=>({...get(...args),bytes:Number.MAX_SAFE_INTEGER});if(sql==='SELECT sequence,body FROM events WHERE rowid=?'){statement.get=(...args)=>{payloads++;return get(...args);};}return statement;};
 try{assert.throws(()=>f.step(p),/reconciliation/);}finally{f.store.db.prepare=prepare;}
 assert.equal(payloads,0);
});

test('legal oversized original event remains one reported sealed atom and no-help rooms qualify without invented obligations',async t=>{
 const source=new RoomStore(':memory:');t.after(()=>source.close());const history=initialRoom(),entry=event({roomId:'commons',actorId:'owner',type:'work.proposed',data:{workItemId:'large-source',title:'Exact preserved work',definitionOfDone:'Keep legal history',accountableMemberId:'owner'}});entry.legacyContext='x'.repeat(4*1024*1024+100);history.push(entry);source.initialize(history,{representation:'normalized-current-v1'});assert.doesNotThrow(()=>auditRecovery(source));
 const store=new RoomStore(':memory:');t.after(()=>store.close());let response=await post(store,exportNdjsonText(source.db)),steps=0,large=false;
 while(response.body.pending){const prior=restoreProgress(store.db);response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'large-help-'+steps++});assert.ok([200,202].includes(response.status),JSON.stringify(response.body.error));
  if(prior.progress?.audit?.stage==='work_help'){const after=restoreProgress(store.db),charged=after.progress.audit.bytes-prior.progress.audit.bytes;if(charged>4*1024*1024){large=true;assert.equal(after.progress.audit.units-prior.progress.audit.units,1);}}
  assert.ok(steps<200);
 }
 assert.equal(large,true);assert.equal(response.body.verified,true);assert.deepEqual(response.body.subsystemContinuation.workHelp,{rooms:1,deferred:0,helpsScanned:0,offersScanned:0,offerChecks:0});
});

test('valid JSON checkpoint outside codec grammar is explicit deferred while original oracle still gates admission',async t=>{
 const f=await fixture(t,{duplicateCheckpoint:true});let p=initialRecoveryWorkHelp();for(let n=0;n<100;n++){p=f.step(p).cursor;if(['complete','deferred'].includes(p.stage))break;}
 assert.equal(p.stage,'deferred');assert.equal(p.reason,'checkpoint_shape_requires_original_oracle');
 let state=restoreProgress(f.store.db),steps=0,response;
 do{response=await post(f.store,{restoreId:state.restore_id,sourceSeal:state.seal.id,expectedRevision:state.revision,requestId:'deferred-help-'+steps++});assert.ok([200,202].includes(response.status),JSON.stringify(response.body.error));state=restoreProgress(f.store.db);assert.ok(steps<200);}while(response.body.pending);
 assert.equal(response.body.verified,true);assert.equal(response.body.subsystemContinuation.workHelp.deferred,1);
});

test('checkpoint validation uses bounded spans and validates even discarded leaves',async t=>{
 const f=await fixture(t),bytes=Buffer.from(f.source.db.prepare("SELECT projection FROM projection_checkpoints WHERE room_id='legacy-room'").get().projection);let scan=initialRecoveryProjectionScan(bytes.length),discarded;
 while(scan.phase!=='done'){
  const result=scanRecoveryProjectionChunk(scan,bytes.subarray(scan.offset,scan.offset+REPLAY_CODEC_INPUT_BYTES),{maximumRecords:1});scan=result.state;
  discarded??=result.records.find(r=>r.kind==='message');
 }
 assert.ok(discarded,'an unrelated checkpoint message must still be validated');
 const prepare=f.store.db.prepare.bind(f.store.db);let poison=false,hits=0;
 f.store.db.prepare=sql=>{
  assert.ok(!/json_valid\(projection\)|SELECT\s+projection\s+FROM/i.test(sql),'no whole checkpoint parse or payload read');
  const statement=prepare(sql),get=statement.get.bind(statement);
  if(sql.startsWith('SELECT substr(CAST(projection AS BLOB)'))statement.get=(...args)=>{
   const row=get(...args);if(poison&&args[0]===discarded.offset+1&&args[1]===discarded.length){hits++;const value=Buffer.from(row.bytes);value[0]=33;return{...row,bytes:value};}return row;
  };return statement;
 };
 try{
  assert.equal(drive(f,p=>p.stage==='complete').stage,'complete');
  poison=true;assert.throws(()=>drive(f,p=>p.stage==='complete'),/reconciliation/);assert.equal(hits,1);
 }finally{f.store.db.prepare=prepare;}
});
