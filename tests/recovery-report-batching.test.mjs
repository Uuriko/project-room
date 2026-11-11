import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {RoomStore} from '../server/store.mjs';
import {beginRestore,restoreProgress,withRestoreTransaction,withRestoreAuditRows,withExactRestoreGuards,RESTORE_CONTROL_GUARDS} from '../server/restore-admission.mjs';
import {captureRecoveryReportSnapshot,readRecoveryReportSnapshot} from '../server/recovery-report-snapshot.mjs';
import {createHash} from 'node:crypto';
import {initialRecoveryReportRow,recoveryReportRowReader} from '../server/recovery-report-source.mjs';
import {initialRecoveryReportTable,appendRecoveryReportChunk,sealRecoveryReportTable,advanceRecoveryReportTable,recoveryReportTableResult} from '../server/recovery-report-continuation.mjs';
import {recoveryReportRequestBudget} from '../server/recovery-report-stage.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
test('four original1MiB binary cells preserve exact Node report1 bytes with bounded cold batches',{timeout:120000},()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE input(bytes)');const size=1024*1024;
 for(let n=0;n<4;n++)db.prepare('INSERT INTO input VALUES(?)').run(Uint8Array.from({length:size},(_,i)=>(i*31+n)%256));
 const prepare=db.prepare.bind(db);let blockReads=0;db.prepare=sql=>{if(/hex\(substr\("bytes",\?,\?\)\)/.test(sql))blockReads++;return prepare(sql);};
 let requests=0,maxWork=0,maxBytes=0;
 try{for(let id=1;id<=4;id++){
  const original=canonical(prepare('SELECT * FROM input WHERE rowid=?').get(id)),digest=createHash('sha256');let current=initialRecoveryReportRow(db,'input',id,size),done=false;
  while(!done){const budget=recoveryReportRequestBudget(),read=recoveryReportRowReader(db,{snapshot:null,scratch:null,budget});let calls=0,prior=JSON.stringify(current);
   while(calls++<128&&budget.canSourceUnit()){
    const r=read(current,{maxUnits:16384});current=r.state;
    if(r.chunk!==null){budget.charge(Buffer.byteLength(JSON.stringify({text:r.chunk,last:r.last}))+512);digest.update(r.chunk);}
    if(r.last){done=true;break;}if(r.units===0&&r.chunk===null)break;
   }
   requests++;maxWork=Math.max(maxWork,budget.usedWork);maxBytes=Math.max(maxBytes,4*1024*1024-budget.remainingBytes);assert.ok(budget.usedWork<=16384);assert.ok(budget.remainingBytes>=0);assert.notEqual(JSON.stringify(current),prior);current=JSON.parse(JSON.stringify(current));assert.ok(requests<1024,'four legal1MiB cells must not require the old131072continuations');
  }
  assert.equal(digest.digest('hex'),hash(original),'original byte-for-byte canonical digest, including numeric key lexical order');
 }}finally{db.close();}
 assert.ok(blockReads<4*size/32,'cached block reads replace per-byte SQL');tDiagnostic({requests,oldOneByteUnitLowerBound:4*size/32,blockReads,maxWork,maxLogicalBytes:maxBytes});
 function tDiagnostic(value){console.log('REPORT_BINARY_BATCHING '+JSON.stringify(value));}
});
test('request budgets reserve a largest legal unit, refuse excess and stop before exhaustion',()=>{
 const budget=recoveryReportRequestBudget();assert.equal(budget.canSourceUnit(),true);assert.equal(budget.canSortUnit(),true);assert.throws(()=>budget.charge(4*1024*1024+1),/budget exceeded/);assert.equal(budget.remainingBytes,4*1024*1024);budget.charge(4*1024*1024-1);assert.equal(budget.canSourceUnit(),false);assert.equal(budget.canSortUnit(),false);assert.equal(recoveryReportRequestBudget().canSortUnit(),true);
});

test('worst escaped TEXT output crosses request quotas without loss or livelock',()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE input(a,b,c)');const size=1024*1024;
 db.prepare('INSERT INTO input VALUES(?,?,?)').run('\u0000'.repeat(size),'中'.repeat(Math.floor(size/3)),' '.repeat(size));
 const expected=hash(canonical(db.prepare('SELECT * FROM input').get())),digest=createHash('sha256');let current=initialRecoveryReportRow(db,'input',1,3*size),requests=0,output=0,exhausted=0;
 try{for(;;){const budget=recoveryReportRequestBudget(),read=recoveryReportRowReader(db,{snapshot:null,scratch:null,budget}),before=JSON.stringify(current);let done=false;
  for(let chunks=0;chunks<128&&budget.canSourceUnit();chunks++){const r=read(current,{maxUnits:16384});current=r.state;if(r.chunk!==null){budget.charge(Buffer.byteLength(JSON.stringify({text:r.chunk,last:r.last}))+512);digest.update(r.chunk);output+=Buffer.byteLength(r.chunk);}if(r.last){done=true;break;}if(r.units===0&&r.chunk===null)break;}
  requests++;if(!budget.canSourceUnit())exhausted++;assert.ok(budget.remainingBytes>=0);assert.ok(budget.usedWork<=16384);assert.notEqual(JSON.stringify(current),before);current=JSON.parse(JSON.stringify(current));assert.ok(requests<1024);if(done)break;
 }}finally{db.close();}
 assert.equal(digest.digest('hex'),expected);assert.ok(output>6*size);assert.ok(requests>1);assert.ok(exhausted>0);console.log('REPORT_ESCAPED_TEXT_BATCHING '+JSON.stringify({requests,outputBytes:output,quotaExhaustions:exhausted}));
});

test('long equal-prefix sort and hash exhaust byte quota, resume cold, and preserve exact whole oracle',()=>{
 const map=new Map(),key=args=>JSON.stringify(args),values=['c','a','a','b'].map(end=>'中'.repeat(8192*20)+end);let writes=0;
 const raw={get remaining(){return 128-writes;},get(...args){const v=map.get(key(args));return v===undefined?undefined:JSON.parse(v);},set(l,r,d,k,v,p=0){writes++;map.set(key([l,r,d,k,p]),JSON.stringify(v));}};
 // Match optional default part=0 used by the existing SQL scratch API.
 const get=raw.get.bind(raw);raw.get=(l,r,d,k,p=0)=>get(l,r,d,k,p);
 let state=initialRecoveryReportTable('fixture');for(const value of values){const text=canonical(value);for(let offset=0;offset<text.length;offset+=8192){writes=0;state=appendRecoveryReportChunk(raw,state,text.slice(offset,offset+8192),offset+8192>=text.length);}}
 state=sealRecoveryReportTable(state);let requests=0,exhausted=0,maxBytes=0;
 while(state.stage!=='complete'){writes=0;const budget=recoveryReportRequestBudget(),scratch={get remaining(){return raw.remaining;},get(...args){const v=raw.get(...args);budget.charge(Buffer.byteLength(JSON.stringify(v)??'null')+512);return v;},set(...args){budget.charge(Buffer.byteLength(JSON.stringify(args[4]))+512);return raw.set(...args);}},before=JSON.stringify(state),r=advanceRecoveryReportTable(scratch,state,{maxUnits:1024,budget});state=JSON.parse(JSON.stringify(r.state));requests++;if(!budget.canSortUnit())exhausted++;maxBytes=Math.max(maxBytes,4*1024*1024-budget.remainingBytes);assert.ok(writes<=128);assert.ok(budget.remainingBytes>=0);assert.notEqual(JSON.stringify(state),before);assert.ok(requests<1024);}
 assert.equal(recoveryReportTableResult(state).sha256,hash(canonical(values.map(canonical).sort())));assert.ok(exhausted>0);console.log('REPORT_SORT_QUOTA '+JSON.stringify({requests,quotaExhaustions:exhausted,maxLogicalBytes:maxBytes}));
});

test('largest admitted3MiB raw control codec crosses quotas and preserves exact snapshot bytes',()=>{
 // Privileged raw codec harness only: actual operator authority/restart is
 // qualified separately. This synthetic seal is not a full restore certificate.
 const store=new RoomStore(':memory:'),pad=value=>value+' '.repeat(1048576-value.length);let capture,current,expected,requests=0,exhausted=0;
 try{
  withRestoreTransaction(store,()=>{beginRestore(store);withExactRestoreGuards(store.db,RESTORE_CONTROL_GUARDS.filter(([name])=>name==='current_restore_admission_update'),()=>store.db.prepare("UPDATE current_restore_admission SET phase='audit_pending',source_seal=?,coverage=?,latest_receipt=? WHERE singleton=1").run(pad(JSON.stringify({id:'a'.repeat(64),schemaHash:'b'.repeat(64)})),pad('{"audit":{"stage":"full_audit_pending"},"duplicate":1,"duplicate":2}'),pad('{}')));});
  expected=hash(canonical(store.db.prepare('SELECT * FROM current_restore_admission').get()));
  withRestoreTransaction(store,()=>{const state=restoreProgress(store.db);capture=withRestoreAuditRows(store.db,state.restore_id,s=>captureRecoveryReportSnapshot(store.db,s,state));});assert.equal(capture.rows,49);
  current=initialRecoveryReportRow(store.db,'current_restore_admission',1,3*1024*1024);const digest=createHash('sha256');let done=false;
  while(!done){const before=JSON.stringify(current);withRestoreTransaction(store,()=>{const state=restoreProgress(store.db);withRestoreAuditRows(store.db,state.restore_id,s=>{
   const snapshot=readRecoveryReportSnapshot(store.db,s,capture.digest,state),budget=recoveryReportRequestBudget(),scratch={...s,get(...args){const v=s.get(...args);budget.charge(Buffer.byteLength(JSON.stringify(v)??'null')+512);return v;}},read=recoveryReportRowReader(store.db,{snapshot,scratch,budget});
   for(let chunks=0;chunks<128&&budget.canSourceUnit();chunks++){const r=read(current,{maxUnits:16384});current=r.state;if(r.chunk!==null){budget.charge(Buffer.byteLength(JSON.stringify({text:r.chunk,last:r.last}))+512);digest.update(r.chunk);}if(r.last){done=true;break;}if(r.units===0&&r.chunk===null)break;}
   if(!budget.canSourceUnit())exhausted++;assert.ok(budget.remainingBytes>=0);assert.ok(budget.usedWork<=16384);
  });});requests++;assert.notEqual(JSON.stringify(current),before);current=JSON.parse(JSON.stringify(current));assert.ok(requests<1024);}
  assert.equal(digest.digest('hex'),expected);assert.ok(requests>1);console.log('REPORT_MAXIMUM_CONTROL_QUOTA '+JSON.stringify({requests,quotaExhaustions:exhausted,rawBytes:3*1024*1024}));
 }finally{store.close();}
});
