import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {exportNdjsonText} from '../server/room-export.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress} from '../server/restore-admission.mjs';
import {reportProgressGuard} from './helpers/recovery-report-progress.mjs';
const token=['synthetic','finalization','operator'].join('-');
function source(t){const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();for(let n=0;n<600;n++)events.push(event({id:'bounded-recovery-'+n,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'bounded-message-'+n,body:'Original bounded recovery evidence '+n}}));store.initialize(events,{representation:'normalized-current-v1'});store.issueAccessKey('commons','owner');return store;}
function files(t,store){const directory=mkdtempSync(join(tmpdir(),'restore-final-operator-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const input=join(directory,'original.ndjson'),filename=join(directory,'target.sqlite');writeFileSync(input,exportNdjsonText(store.db));return{input,filename};}
function child(action,filename,input){const run=spawnSync(process.execPath,['tests/fixtures/recovery-finalization-budget-child.mjs',action,filename,input],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});assert.equal(run.status,77,run.stdout+'\n'+run.stderr);const report=run.stdout.trim().split('\n').reverse().map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(Boolean);assert.ok(report);return report;}
function saved(filename){const store=new RoomStore(filename);try{return{state:restoreProgress(store.db),scratch:store.db.prepare('SELECT count(*) n FROM current_restore_audit_scratch').get().n};}finally{store.close();}}
async function post(store,body){const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),token,store);const value=await response.json();assert.ok([200,202].includes(response.status),JSON.stringify(value));return value;}
function observeBulk(store){const prepare=store.db.prepare.bind(store.db),bulk=[];store.db.prepare=sql=>{const statement=prepare(sql);if(!/^SELECT \* FROM ["a-z_]+$/.test(sql))return statement;return new Proxy(statement,{get(target,key){const fn=Reflect.get(target,key,target);if(key!=='all')return typeof fn==='function'?fn.bind(target):fn;return(...args)=>{const rows=fn.apply(target,args);bulk.push({sql,rows:rows.length,textBytes:rows.reduce((sum,row)=>sum+Object.values(row).reduce((n,cell)=>n+(typeof cell==='string'?Buffer.byteLength(cell):0),0),0)});return rows;};}});};return{bulk,restore(){store.db.prepare=prepare;}};}
test('actual operator commits bounded coverage across cold exits, rolls back interrupted save and replays lost ACK exactly',t=>{
 const store=source(t),{input,filename}=files(t,store),ingest=child('ingest',filename,input);assert.equal(ingest.pending,true);assert.ok(ingest.events>=600);
 const before=saved(filename),fault=child('interrupted-save',filename,input);assert.equal(fault.insideTransaction,true);assert.deepEqual(saved(filename),before,'process exit inside checkpoint must roll back cursor, scratch and guard DDL');
 const first=child('budget',filename,input),lost=child('lost-ack',filename,input),retry=child('retry',filename,input),second=child('budget',filename,input);
 for(const step of[first,lost,second]){assert.ok(step.rows>0&&step.rows<=128);assert.ok(step.bytes<=4*1024*1024);assert.equal(step.pending,true);assert.equal(step.restoreId,ingest.restoreId);assert.equal(step.events,ingest.events);assert.equal(step.operatorActions,ingest.operatorActions);}
 assert.equal(retry.exactRetry,true);assert.equal(retry.rows,0);assert.equal(retry.revision,lost.revision);assert.deepEqual(retry.frontier,lost.frontier);
 assert.equal(first.revision,ingest.revision+1);assert.equal(lost.revision,first.revision+1);assert.equal(second.revision,lost.revision+1);assert.notDeepEqual(second.frontier,first.frontier);assert.notDeepEqual(second.prefix,first.prefix);
 const cold=new RoomStore(filename);try{assert.throws(()=>cold.headSequence('commons'),error=>error.status===503);}finally{cold.close();}t.diagnostic(JSON.stringify({protocol:20,budget:128,first,lost,retry,second,interruptedSaveRollback:true}));
});
test('actual operator report avoids whole payload table all(); default literal audit remains a separate synchronous oracle',{timeout:30000},async t=>{
 const sourceStore=source(t),literal=observeBulk(sourceStore);let reference;try{reference=auditRecovery(sourceStore);}finally{literal.restore();}assert.equal(reference.checks.projectionReplay,true);assert.ok(literal.bulk.some(row=>row.rows>128),'reference fixture must still demonstrate intentionally synchronous full audit');
 const target=new RoomStore(':memory:');t.after(()=>target.close());let receipt=await post(target,exportNdjsonText(sourceStore.db)),guard=reportProgressGuard(target,assert),publication;const bulk=[];let steps=0;
 while(receipt.pending){
  const state=restoreProgress(target.db),mark=guard.before(state); // Test-only T0 reference reads are outside measured operator calls.
  const observed=observeBulk(target);
  try{receipt=await post(target,{restoreId:receipt.restoreId,sourceSeal:receipt.sourceSeal,expectedRevision:receipt.revision,requestId:'contract-'+steps++});}
  finally{observed.restore();bulk.push(...observed.bulk);}
  if(receipt.pending){const after=restoreProgress(target.db);guard.after(mark,after);assert.equal(after.revision,state.revision+1);assert.notEqual(after.coverage,state.coverage,'committed source/semantic/report frontier must change, not only receipt revision');}else publication=receipt;
 }
 assert.equal(publication.verified,true);assert.equal(publication.recovery.fingerprintScope.basis,'restore-audit-instant');assert.equal(publication.replayContinuation.originalFullOracleRequired,true);assert.ok(bulk.every(row=>row.rows<=128),'operator final report must not use unbounded whole-payload table all()');assert.ok(bulk.every(row=>row.textBytes<=4*1024*1024),'operator whole-payload query byte bound');
 t.diagnostic(JSON.stringify({protocol:20,...guard.summary(),literalFullRows:Math.max(...literal.bulk.map(row=>row.rows)),operatorLargestBulk:bulk.sort((a,b)=>b.rows-a.rows).slice(0,5),allOtherFinalOracleChecksStillRequired:true}));
});
test('preopened prepared SQL writers cannot mutate imported authority after actual operator seal or cold coverage',t=>{
 const sourceStore=source(t),{input,filename}=files(t,sourceStore),held=new RoomStore(filename);t.after(()=>held.close());const prepared=held.db.prepare("UPDATE credentials SET revoked=1 WHERE kind='access'");child('ingest',filename,input);child('budget',filename,input);assert.equal(held.restoreStatus().pending,true);const before=held.db.prepare("SELECT revoked FROM credentials WHERE kind='access'").get();assert.equal(before.revoked,0);assert.throws(()=>prepared.run(),/restore target is sealed/);assert.deepEqual(held.db.prepare("SELECT revoked FROM credentials WHERE kind='access'").get(),before);t.diagnostic(JSON.stringify({protocol:20,preopenedSameFloor:true,preparedWriterRefused:true,coveragePending:true}));
});
