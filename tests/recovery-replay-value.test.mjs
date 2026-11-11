import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {beginRestore,checkpointRestore,restoreProgress,withRestoreTransaction,withRestoreAuditRows,RESTORE_CONTROL_GUARDS} from '../server/restore-admission.mjs';
import {planRecoveryReplayValue,writeRecoveryReplayValue,readRecoveryReplayValue,RECOVERY_VALUE_PART_BYTES} from '../server/recovery-replay-value.mjs';
function store(){const rows=new Map();return{rows,remaining:128,get(lane,room,domain,key,part){return rows.get(JSON.stringify([lane,room,domain,key,part]));},set(lane,room,domain,key,value,part){const payload=JSON.stringify(value);assert.ok(Buffer.byteLength(payload)<=131072+2048);rows.set(JSON.stringify([lane,room,domain,key,part]),JSON.parse(payload));this.remaining--;}};}
const get=(s,max)=>readRecoveryReplayValue(s,'r','seenEvents','e',max),put=(s,v,max)=>writeRecoveryReplayValue(s,'r','seenEvents','e',planRecoveryReplayValue(v,max));
test('legal long fingerprint survives bounded scratch parts, unicode boundaries and cold adapter',()=>{
 for(const value of ['short',{body:'🦉'.repeat(40000),escaped:'\\\"\n'.repeat(10000)},'a'.repeat(160029)]){
  const s=store(),bytes=Buffer.byteLength(JSON.stringify(value));assert.equal(put(s,value,bytes),true);const cold=store();
  for(const [key,v]of s.rows){const args=JSON.parse(key);cold.set(...args.slice(0,4),v,args[4]);}
  assert.deepEqual(get(cold,bytes),value);assert.throws(()=>get(cold,bytes-1),/reconciliation/);
 }
});
test('missing, reordered, mutated and ambiguous base64 parts fail closed',()=>{
 const original=store(),value='🦉'.repeat(50000),maximum=Buffer.byteLength(JSON.stringify(value));put(original,value,maximum);
 for(const mutate of [s=>s.rows.delete(JSON.stringify(['replay','r','seenEvents','e',2])),s=>s.rows.set(JSON.stringify(['replay','r','seenEvents','e',1]),s.rows.get(JSON.stringify(['replay','r','seenEvents','e',2]))),s=>s.rows.set(JSON.stringify(['replay','r','seenEvents','e',1]),'!!!!'),s=>{const key=JSON.stringify(['replay','r','seenEvents','e',1]);s.rows.set(key,s.rows.get(key)+'\n');},s=>s.rows.get(JSON.stringify(['replay','r','seenEvents','e',0])).bytes++]){
  const s=store();for(const[k,v]of original.rows)s.rows.set(k,structuredClone(v));mutate(s);assert.throws(()=>get(s,maximum+1),/reconciliation/);
 }
});
test('insufficient transaction row admission leaves old working head and all parts unchanged',()=>{
 const s=store();put(s,'old',100);const before=structuredClone([...s.rows]);s.remaining=1;const plan=planRecoveryReplayValue('x'.repeat(160029),170000);assert.equal(writeRecoveryReplayValue(s,'r','seenEvents','e',plan),false);assert.deepEqual([...s.rows],before);assert.equal(get(s,100),'old');
 s.remaining=128;assert.equal(writeRecoveryReplayValue(s,'r','seenEvents','e',plan),true);assert.equal(get(s,170000),'x'.repeat(160029));s.remaining=128;put(s,'new',100);assert.equal(get(s,100),'new','old unreachable parts cannot replace current head');
});
test('source scalar admission and exact part index are enforced',()=>{
 assert.throws(()=>planRecoveryReplayValue('too large',3),/reconciliation/);assert.throws(()=>planRecoveryReplayValue(undefined,100),/reconciliation/);
 const plan=planRecoveryReplayValue('x'.repeat(RECOVERY_VALUE_PART_BYTES),100000);assert.throws(()=>plan.part(0),/reconciliation/);assert.throws(()=>plan.part(plan.rows),/reconciliation/);
});

test('existing guarded SQLite scratch atomically checkpoints large replay value and survives cold reopen',t=>{
 const directory=mkdtempSync(join(tmpdir(),'recovery-replay-value-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const filename=join(directory,'target.sqlite');let store=new RoomStore(filename);t.after(()=>store.close());const id=beginRestore(store);
 // Synthetic target-only scratch qualification, not an authenticated source seal.
 const seal={syntheticScratchTest:true},progress={replay:0};withRestoreTransaction(store,()=>checkpointRestore(store.db,{restoreId:id,expectedRevision:0,phase:'audit_pending',seal,progress,latest:null}));
 const value={fingerprint:'🦉'.repeat(50000),legacyTimestamp:'x'.repeat(160029)},maximum=Buffer.byteLength(JSON.stringify(value));
 const write=(next,fault=false)=>withRestoreTransaction(store,()=>{
  withRestoreAuditRows(store.db,id,scratch=>assert.equal(put(scratch,next,maximum),true));
  const before=restoreProgress(store.db);checkpointRestore(store.db,{restoreId:id,expectedRevision:before.revision,phase:'audit_pending',seal,progress:{replay:before.progress.replay+1},latest:{requestId:'value_'+before.revision}});
  if(fault)throw Error('after-head-and-cursor-before-commit');
 });
 write(value);const before=restoreProgress(store.db);assert.throws(()=>write({fingerprint:'replacement'},true),/before-commit/);assert.deepEqual(restoreProgress(store.db),before,'rolled-back guard DDL permits exact-definition warm readmission without changing checkpoint');
 assert.throws(()=>store.db.prepare("UPDATE current_restore_audit_scratch SET payload='null'").run(),/unsupported restore admission mutation/);
 store.close();store=new RoomStore(filename);assert.deepEqual(withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,id,scratch=>get(scratch,maximum))),value);assert.deepEqual(restoreProgress(store.db),before);assert.throws(()=>store.headSequence('commons'),error=>error.status===503);
 const [name,sql]=RESTORE_CONTROL_GUARDS.find(([name])=>name==='current_restore_audit_scratch_update');store.db.exec('DROP TRIGGER '+name);store.db.exec(sql.replace('unsupported restore admission mutation','changed restore admission mutation'));assert.throws(()=>restoreProgress(store.db),/schema requires reconciliation/,'exact warm readmission never accepts a changed guard definition');
});

test('actual process exit preserves reducer patch parts and exact independently folded cursor together',async t=>{
 const {writeFileSync}=await import('node:fs'),{spawnSync}=await import('node:child_process'),{initialRoom}=await import('../server/bootstrap.mjs'),{event,replayEvents,emptyRoomState}=await import('../src/events.js');
 const directory=mkdtempSync(join(tmpdir(),'recovery-replay-process-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const filename=join(directory,'target.sqlite'),eventsFile=join(directory,'events.json');let store=new RoomStore(filename);const id=beginRestore(store),seal={syntheticScratchTest:true};
 const events=[...initialRoom(),event({id:'large-pair-event',roomId:'commons',actorId:'owner',type:'pair.requested',at:'Sun, 01 Nov 2026 12:00:00 GMT'+' '.repeat(160000),data:{pairId:'p',displayName:'Synthetic recovery pair',status:'pending'}}),event({id:'root-message-event',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'root-message',body:'Saved useful work'}}),event({id:'reply-event',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'reply-message',replyToId:'root-message',body:'Cold reply'}})];writeFileSync(eventsFile,JSON.stringify(events));
 withRestoreTransaction(store,()=>checkpointRestore(store.db,{restoreId:id,expectedRevision:0,phase:'audit_pending',seal,progress:{replay:0,counts:{members:0,channels:0,workItems:0,replyRequests:0}},latest:null}));store.close();
 const run=mode=>{const child=spawnSync(process.execPath,['tests/fixtures/recovery-point-replay-child.mjs',filename,eventsFile,mode],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});assert.equal(child.status,77,child.stdout+'\n'+child.stderr);return child.stdout.trim()?JSON.parse(child.stdout.trim().split('\n').at(-1)):null;};
 for(let n=0;n<events.length;n++){
  assert.equal(run('before-commit'),null);store=new RoomStore(filename);assert.equal(restoreProgress(store.db).progress.replay,n);store.close();const committed=run('committed');assert.equal(committed.replay,n+1);store=new RoomStore(filename);assert.equal(restoreProgress(store.db).revision,committed.revision);assert.deepEqual(restoreProgress(store.db).latest,committed.receipt);assert.throws(()=>store.headSequence('commons'),error=>error.status===503);store.close();
 }
 store=new RoomStore(filename);try{
  const expected=replayEvents(emptyRoomState(),events);withRestoreTransaction(store,()=>withRestoreAuditRows(store.db,id,scratch=>{
   for(const incoming of events)assert.equal(readRecoveryReplayValue(scratch,'commons','seenEvents',incoming.id,1024*1024),expected.seenEvents[incoming.id]);
   for(const message of expected.messages)assert.deepEqual(readRecoveryReplayValue(scratch,'commons','messages',message.id,1024*1024),message);
   assert.deepEqual(readRecoveryReplayValue(scratch,'commons','metadata','room',1024*1024),expected.room);
  }));
 }finally{store.close();}
});

test('declared entity bytes are admitted before allocating or fetching any large body part',()=>{
 const s=store(),value='x'.repeat(160029);put(s,value,170000);const get=s.get.bind(s);let fetchedParts=0;s.get=(...args)=>{if(args[4]>0)fetchedParts++;return get(...args);};
 assert.throws(()=>readRecoveryReplayValue(s,'r','seenEvents','e',170000,{admit(bytes){assert.equal(bytes,160031);throw Error('input quantum exhausted');}}),/input quantum exhausted/);assert.equal(fetchedParts,0);
});
