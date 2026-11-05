import test from 'node:test';import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';import {event} from '../src/events.js';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../server/replay-cutover.mjs';
import {planLegacyMirrorRetirement,retireLegacyMirror} from '../server/replay-mirror-retirement.mjs';
import {readWorkItem} from '../server/work-repository.mjs';import {auditRecovery} from '../server/recovery.mjs';import {textVersion} from '../server/text-results.mjs';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
function setup(t,filename=':memory:'){const s=new RoomStore(filename);t.after(()=>{try{s.close();}catch{}});const events=initialRoom();events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'observer',displayName:'Observer',kind:'agent',permissions:[]}}));s.initialize(events);const key=s.issueAccessKey('commons','owner'),other=s.issueAccessKey('commons','observer');let n=0,commandSerial=0;
 const send=(type,data)=>s.command(key,'commons',{id:'task-command-'+(++commandSerial),type,data});
 send('work.proposed',{workItemId:'ongoing',title:'Private task title not copied into operator plans',definitionOfDone:'Native useful saved result',accountableMemberId:'owner',mode:'read'});send('work.accepted',{workItemId:'ongoing',expectedRevision:0});send('work.started',{workItemId:'ongoing',expectedRevision:1});
 s.db.exec(replayCutoverSchema());const h=captureReplayWitness(s,{roomId:'commons',requestId:'capture',expectedHead:s.headSequence('commons'),reason:'Prepare ongoing task conversion without closing canonical work'}),input={roomId:'commons',generation:h.generation};let p={bytes:0};n=0;while(p.phase!=='witness_verified')p=advanceReplayWitness(s,{...input,requestId:'hash'+n++,expectedBytes:p.bytes});p={bytes:0};n=0;while(p.phase!=='codec_partitioned')p=partitionReplayWitness(s,{...input,requestId:'codec'+n++,expectedBytes:p.bytes});p={workCount:0};n=0;while(!p.workDefaultsQualified)p=qualifyReplayHWork(s,{...input,requestId:'work'+n++,expectedWorkCount:p.workCount});
 return {s,key,other,send,input,selection:{...input,workItemId:'ongoing'}};
}
const bodies=s=>s.db.prepare('SELECT * FROM work_entities').all();
const legacy=s=>s.db.prepare('SELECT * FROM work_claims').all();
test('reviewed H-bound mirror retirement preserves ongoing canonical work and exact retry through activation',t=>{
 const f=setup(t),nativeBefore=bodies(f.s),old=f.s.workClaims.get('commons','ongoing'),plan=planLegacyMirrorRetirement(f.s,f.key,f.selection);
 assert.equal(plan.canonical.state,'working');assert.equal(JSON.stringify(plan).includes('Private task title'),false);assert.ok(plan.inputBytes<=262144);
 const request={...f.selection,requestId:'retire-once',planHash:plan.planHash,reason:'Reviewed exact mirror and native task; retain native ownership'};
 f.s.room=()=>{throw Error('full room hydration during retirement');};const result=retireLegacyMirror(f.s,f.key,request);assert.equal(result.canonicalUnchanged,true);assert.deepEqual(bodies(f.s),nativeBefore);
 const closed=f.s.workClaims.get('commons','ongoing');assert.equal(closed.state,'closed');assert.deepEqual(closed.history.slice(0,old.history.length),old.history);assert.match(closed.history.at(-1).note,/canonical task ongoing.*continues/);
 const frozen=legacy(f.s),receipts=f.s.db.prepare('SELECT * FROM operator_actions').all();assert.equal(retireLegacyMirror(f.s,f.key,{reason:request.reason,planHash:request.planHash,requestId:request.requestId,...f.selection}).duplicate,true);assert.deepEqual(legacy(f.s),frozen);assert.deepEqual(f.s.db.prepare('SELECT * FROM operator_actions').all(),receipts);
 let p={hMessageSteps:0},n=0;while(!p.hMessagesQualified)p=qualifyReplayHMessages(f.s,{...f.input,requestId:'messages'+n++,expectedSteps:p.hMessageSteps});p={currentSteps:0};n=0;while(p.phase!=='current_serving'){p=advanceCurrentRoomConversion(f.s,{...f.input,requestId:'current'+n++,expectedSteps:p.currentSteps});assert.ok(n<100);}
 assert.equal(readWorkItem(f.s.db,'commons','ongoing').state,'working');assert.deepEqual(bodies(f.s),nativeBefore);assert.equal(retireLegacyMirror(f.s,f.key,request).duplicate,true);
 const body='Useful work completed after migration',posted=f.send('message.posted',{messageId:'saved-result',workItemId:'ongoing',body});f.send('work.completed',{workItemId:'ongoing',expectedRevision:2,evidenceKind:'room_text',evidenceMessageId:'saved-result',evidenceMessageEventId:posted.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,producerId:'owner',summary:'Saved',nextAction:'Review'});
 assert.equal(f.s.workResult(f.key,'commons','ongoing').result.text.body,body);assert.deepEqual(legacy(f.s),frozen);assert.doesNotThrow(()=>auditRecovery(f.s));
});
test('changed canonical work makes a reviewed mirror plan stale without closing the mirror',t=>{
 const f=setup(t),plan=planLegacyMirrorRetirement(f.s,f.key,f.selection);f.send('work.blocked',{workItemId:'ongoing',expectedRevision:2,reason:'A newly discovered condition',nextAction:'Reconcile the changed condition'});const before=legacy(f.s);
 assert.throws(()=>retireLegacyMirror(f.s,f.key,{...f.selection,requestId:'retire-stale-native',planHash:plan.planHash,reason:'Old reviewed plan'}),e=>e.code==='stale_mirror_retirement');assert.deepEqual(legacy(f.s),before);
});
test('changed mirror and missing permission refuse without widening authority',t=>{
 const f=setup(t);assert.throws(()=>planLegacyMirrorRetirement(f.s,f.other,f.selection),e=>e.status===403);
 const plan=planLegacyMirrorRetirement(f.s,f.key,f.selection),item=f.s.workClaims.get('commons','ongoing');f.s.workClaims.set('commons',{...item,title:'Changed legacy title'});const before=legacy(f.s);
 assert.throws(()=>retireLegacyMirror(f.s,f.key,{...f.selection,requestId:'retire-stale-mirror',planHash:plan.planHash,reason:'Old reviewed plan'}),e=>e.code==='stale_mirror_retirement');assert.deepEqual(legacy(f.s),before);
});
test('cold restart preserves deliberate mirror retirement before serving activation',t=>{
 const directory=mkdtempSync(join(tmpdir(),'retire-mirror-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'source.sqlite'),f=setup(t,path),plan=planLegacyMirrorRetirement(f.s,f.key,f.selection),request={...f.selection,requestId:'cold-retire',planHash:plan.planHash,reason:'Reviewed native continuation'};
 retireLegacyMirror(f.s,f.key,request);const before=bodies(f.s);f.s.close();const cold=new RoomStore(path);t.after(()=>cold.close());
 assert.deepEqual(bodies(cold),before);assert.equal(cold.workClaims.get('commons','ongoing').state,'closed');assert.equal(retireLegacyMirror(cold,f.key,request).duplicate,true);
});

test('receipt interruption rolls back mirror closure and preserves retry',t=>{
 const f=setup(t),plan=planLegacyMirrorRetirement(f.s,f.key,f.selection),request={...f.selection,requestId:'interrupted-retire',planHash:plan.planHash,reason:'Reviewed before interruption'},before=legacy(f.s),native=bodies(f.s),prepare=f.s.db.prepare.bind(f.s.db);let fired=false;
 f.s.db.prepare=query=>new Proxy(prepare(query),{get(target,key){const value=Reflect.get(target,key,target);if(key!=='run')return typeof value==='function'?value.bind(target):value;return(...args)=>{const result=value.apply(target,args);if(/^INSERT INTO operator_actions/.test(query)){fired=true;throw Error('lost retirement receipt save');}return result;};}});
 try{assert.throws(()=>retireLegacyMirror(f.s,f.key,request),/lost retirement receipt/);}finally{f.s.db.prepare=prepare;}
 assert.equal(fired,true);assert.deepEqual(legacy(f.s),before);assert.deepEqual(bodies(f.s),native);assert.equal(retireLegacyMirror(f.s,f.key,request).duplicate,false);
});
test('retirement preserves spilled history and refuses independent holder or review obligations',t=>{
 const f=setup(t),item=f.s.workClaims.get('commons','ongoing');
 f.s.workClaims.set('commons',{...item,owner:'observer'});assert.throws(()=>planLegacyMirrorRetirement(f.s,f.key,f.selection),e=>e.code==='independent_legacy_work');
 f.s.workClaims.set('commons',{...item,files:['existing-artifact']});assert.throws(()=>planLegacyMirrorRetirement(f.s,f.key,f.selection),e=>e.code==='independent_legacy_work');
 const history=Array.from({length:205},(_,i)=>({...item.history[0],note:'Historical note '+i}));f.s.workClaims.set('commons',{...item,history,historyOmitted:0});
 const before=f.s.workClaims.get('commons','ongoing'),plan=planLegacyMirrorRetirement(f.s,f.key,f.selection);assert.equal(plan.mirror.storedHistory,200);assert.equal(plan.mirror.historyOmitted,5);
 retireLegacyMirror(f.s,f.key,{...f.selection,requestId:'preserve-history',planHash:plan.planHash,reason:'Preserve exact history'});const after=f.s.workClaims.get('commons','ongoing');assert.deepEqual(after.history.slice(0,-1),before.history);assert.equal(after.history.length,206);
});
