import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createWork} from '../server/work-claims.mjs';
import {CURRENT_LEGACY_WORK_GUARDS} from '../server/current-legacy-work-gate.mjs';
import {assertLegacyWorkReconciled} from '../server/current-legacy-work-gate.mjs';
import {replayCutoverSchema,captureReplayWitness,advanceReplayWitness,partitionReplayWitness,qualifyReplayHWork,qualifyReplayHMessages,advanceCurrentRoomConversion} from '../server/replay-cutover.mjs';
const by={kind:'human',id:'owner'};
function fixture(t){const store=new RoomStore(':memory:');t.after(()=>store.close());store.initialize(initialRoom());store.db.exec(replayCutoverSchema());return store;}
const capture=store=>captureReplayWitness(store,{roomId:'commons',requestId:'capture',expectedHead:store.headSequence('commons'),reason:'Legacy assignment reconciliation control'});
test('preparation permits active collaboration but the serving gate requires recorded release',t=>{
 const s=fixture(t),assigned=s.collab.assignThread('commons','thread',{kind:'agent',id:'worker'},{by});
 const before=s.db.prepare('SELECT * FROM collab_assignments').all();
 assert.throws(()=>assertLegacyWorkReconciled(s.db,'commons'),e=>e.code==='current_room_legacy_work_unreconciled'&&e.message.includes('/collab/assignments'));assert.doesNotThrow(()=>capture(s));
 assert.deepEqual(s.db.prepare('SELECT * FROM collab_assignments').all(),before);
 s.collab.releaseAssignment('commons',assigned.assignmentId,{by,reason:'Recorded reconciliation'});
 assert.doesNotThrow(()=>capture(s));assert.equal(s.collab.listAssignments('commons')[0].status,'released');
});
test('legacy board open work gates conversion but terminal history and other rooms do not',t=>{
 const s=fixture(t),work=createWork({id:'legacy-open',title:'Existing obligation'},{agentId:'owner',now:new Date(s.now())});
 s.workClaims.set('commons',work);assert.throws(()=>assertLegacyWorkReconciled(s.db,'commons'),e=>e.code==='current_room_legacy_work_unreconciled'&&e.message.includes('/work-claims-read'));assert.doesNotThrow(()=>capture(s));
 // Storage fixture for an already recorded closed authority. This does not
 // manufacture a claim completion or rewrite immutable claim history.
 s.transaction(()=>s.db.prepare("UPDATE work_claims SET item_json=json_set(item_json,'$.data.state','closed') WHERE room_id=? AND claim_id=?").run('commons',work.id));
 s.workClaims.set('other-room',createWork({id:'other',title:'Another room obligation'},{agentId:'owner',now:new Date(s.now())}));
 assert.doesNotThrow(()=>assertLegacyWorkReconciled(s.db,'commons'));assert.doesNotThrow(()=>capture(s));
});
test('publication rechecks newly admitted legacy assignments and leaves room legacy',t=>{
 const s=fixture(t),h=capture(s),input={roomId:'commons',generation:h.generation};let p={bytes:0},i=0;
 while(p.phase!=='witness_verified')p=advanceReplayWitness(s,{...input,requestId:'hash'+i++,expectedBytes:p.bytes});
 p={bytes:0};i=0;while(p.phase!=='codec_partitioned')p=partitionReplayWitness(s,{...input,requestId:'codec'+i++,expectedBytes:p.bytes});
 qualifyReplayHWork(s,{...input,requestId:'work',expectedWorkCount:0});p={hMessageSteps:0};i=0;while(!p.hMessagesQualified)p=qualifyReplayHMessages(s,{...input,requestId:'messages'+i++,expectedSteps:p.hMessageSteps});
 s.collab.assignThread('commons','late-thread',{kind:'agent',id:'worker'},{by});
 p={currentSteps:0};i=0;assert.throws(()=>{while(p.phase!=='current_serving'&&i<100)p=advanceCurrentRoomConversion(s,{...input,requestId:'current'+i++,expectedSteps:p.currentSteps});},e=>e.code==='current_room_legacy_work_unreconciled');
 assert.equal(s.db.prepare('SELECT count(*) n FROM current_room_head').get().n,0);assert.ok(s.room('commons').state.room);
});

import {mkdtempSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
test('actual old same-floor prepared writers cannot create or reopen legacy assignments after activation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'current-legacy-old45-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const archive=execFileSync('git',['archive','a75c9e0bf','server','src','client','strings','package.json'],{maxBuffer:64*1024*1024});execFileSync('tar',['-x','-C',directory],{input:archive});symlinkSync(realpathSync(new URL('../node_modules',import.meta.url)),join(directory,'node_modules'),'dir');
 const {RoomStore:OldStore}=await import(pathToFileURL(join(directory,'server/store.mjs')).href),old=new OldStore(':memory:');t.after(()=>old.close());old.initialize(initialRoom(),{representation:'normalized-current-v1'});
 const item=createWork({id:'existing',title:'Existing recorded legacy history'},{agentId:'owner',now:new Date(old.now())});old.workClaims.set('commons',item);
 old.workClaims.set('commons',{...item,state:'closed'});
 const assigned=old.collab.assignThread('commons','existing-thread',{kind:'agent',id:'worker'},{by});old.collab.releaseAssignment('commons',assigned.assignmentId,{by});
 const preparedClaim=old.db.prepare("UPDATE work_claims SET item_json=json_set(item_json,'$.data.state','unclaimed') WHERE room_id='commons' AND claim_id='existing'");
 const preparedAssignment=old.db.prepare("UPDATE collab_assignments SET record_json=json_set(record_json,'$.status','assigned') WHERE room_id='commons'");
 // Controlled installation of only the newly added authority guards. This
 // isolates actual old/prepared writes without claiming a release upgrade.
 old.transaction(()=>{for(const [,sql] of CURRENT_LEGACY_WORK_GUARDS)old.db.exec(sql);});
 const snapshot=()=>JSON.stringify(Object.fromEntries(['work_claims','work_claim_history','collab_assignments','operator_actions','rooms','events','commands'].map(table=>[table,old.db.prepare('SELECT * FROM '+table).all()]))),before=snapshot();
 for(const action of [()=>old.transaction(()=>preparedClaim.run()),()=>old.transaction(()=>preparedAssignment.run()),
   ()=>old.workClaims.set('commons',createWork({id:'new',title:'Hidden new legacy obligation'},{agentId:'owner',now:new Date(old.now())})),
   ()=>old.collab.assignThread('commons','new-thread',{kind:'agent',id:'worker'},{by})]){
  assert.throws(action,/normalized room requires native work/);assert.equal(snapshot(),before);
 }
 assert.equal(old.workClaims.get('commons','existing').state,'closed');assert.equal(old.collab.listAssignments('commons')[0].status,'released');
 assert.doesNotThrow(()=>old.workClaims.set('commons',{...item,state:'closed'}));
});
