import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {auditRecovery} from '../server/recovery.mjs';
import {RoomStore} from '../server/store.mjs';
import {exportNdjsonText} from '../server/room-export.mjs';
import {operatorRestoreResponse} from '../server/restore-ndjson.mjs';
import {restoreProgress,withRestoreTransaction,withRestoreAuditRows,checkpointRestore} from '../server/restore-admission.mjs';
import {advanceRecoveryReminders,initialRecoveryReminders} from '../server/recovery-reminder-continuation.mjs';
import {recoveryReminderCurrent,recoveryReminderReceipt} from '../server/recovery-reminder-rules.mjs';
import {withCompletedRecoveryReminders,verifyRemindersForRecovery} from '../server/recovery-reminder-consumption.mjs';
import {seedRecoveryReminderSource} from './helpers/recovery-reminder-source.mjs';
const token='synthetic-reminder-consumption-qualification';
async function post(store,body){const response=await operatorRestoreResponse(new Request('https://room.example/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+token,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)}),token,store);return{status:response.status,body:await response.json()};}
async function fixture(t,beforeSource){const source=new RoomStore(':memory:');const seeded=seedRecoveryReminderSource(source,{current:false,receipts:1});source.command(seeded.owner,'commons',{id:'padding-work',type:'work.proposed',data:{workItemId:'padding-work',title:'Admission padding',definitionOfDone:'x'.repeat(2000),accountableMemberId:'owner'}});beforeSource?.(source);assert.doesNotThrow(()=>auditRecovery(source));const store=new RoomStore(':memory:');t.after(()=>{source.close();store.close();});let response=await post(store,exportNdjsonText(source.db));for(let n=0;response.body.auditProgress?.stage!=='reminders';n++){assert.equal(response.status,202,JSON.stringify(response.body));assert.ok(n<200);response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'prepare-'+n});}const state=restoreProgress(store.db);return{source,store,state};}
function drive(f){let p=initialRecoveryReminders();for(let n=0;n<100;n++){const r=withRestoreTransaction(f.store,()=>withRestoreAuditRows(f.store.db,f.state.restore_id,s=>advanceRecoveryReminders(f.store,s,f.state.restore_id,p,f.state.seal)));p=r.cursor;if(r.done)return p;}throw Error('no reminder progress');}
function edit(f,tables,operation){withRestoreTransaction(f.store,()=>{const db=f.store.db,defs=tables.flatMap(table=>db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table));for(const d of defs)db.exec('DROP TRIGGER "'+d.name+'"');operation(db);for(const d of defs)db.exec(d.sql);});}
// Controlled selected-context grammar and hydration parity. These mutations
// do not claim complete source admission; the original predicate is the oracle.
for(const kind of ['inner-member','top-member','inner-work','top-work'])test('legacy reminder context preserves JSON.parse last duplicates: '+kind,async t=>{
 const f=await fixture(t,source=>edit({store:source},['rooms'],db=>{let raw=db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection;
  if(kind==='inner-member')raw=raw.replace('"owner":','"owner":{"active":false},"owner":');
  if(kind==='top-member')raw='{"members":{"owner":{"active":false}},'+raw.slice(1);
  if(kind==='inner-work')raw=raw.replace('"active":{','"active":{"revision":0,"supersededBy":"cancelled"},"active":{');
  if(kind==='top-work')raw='{"workItems":{"active":{"revision":0,"supersededBy":"cancelled"}},'+raw.slice(1);
  db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(raw);
 }));
 assert.doesNotThrow(()=>withRestoreTransaction(f.store,()=>{const room=f.store.room('commons').state,row=f.store.db.prepare("SELECT * FROM private_reminders WHERE work_item_id='active'").get(),receipt=recoveryReminderReceipt(f.store.db.prepare("SELECT * FROM private_reminder_commands WHERE request_id='schedule-0001'").get());recoveryReminderCurrent(row,receipt,{member:room.members.owner,work:room.workItems.active,account:f.store.accountForMember('commons','owner')});}));
 assert.equal(drive(f).stage,'complete');
});
test('legacy reminder checks hydrated terminal work rather than its nonterminal reference',async t=>{
 const f=await fixture(t);
 edit(f,['rooms','work_entities'],db=>{const row=db.prepare("SELECT body FROM work_entities WHERE room_id='commons' AND work_id='active'").get(),work=JSON.parse(row.body);work.supersededBy='cancelled';const body=JSON.stringify(work),digest=createHash('sha256').update(body).digest('hex');db.prepare("UPDATE work_entities SET body=?,digest=? WHERE room_id='commons' AND work_id='active'").run(body,digest);const raw=JSON.parse(db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);assert.equal(raw.workItems.active._workEntity,1);raw.workItems.active.digest=digest;db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(raw));});
 assert.throws(()=>withRestoreTransaction(f.store,()=>{const state=f.store.room('commons').state,row=f.store.db.prepare("SELECT * FROM private_reminders WHERE work_item_id='active'").get(),receipt=recoveryReminderReceipt(f.store.db.prepare("SELECT * FROM private_reminder_commands WHERE request_id='schedule-0001'").get());recoveryReminderCurrent(row,receipt,{member:state.members.owner,work:state.workItems.active,account:f.store.accountForMember('commons','owner')});}),/reconciliation/);
 assert.throws(()=>drive(f),/reconciliation/);
});

async function completed(t,current){
 const source=new RoomStore(':memory:'),store=new RoomStore(':memory:');t.after(()=>{source.close();store.close();});seedRecoveryReminderSource(source,{current,receipts:4});let response=await post(store,exportNdjsonText(source.db));
 for(let n=0;response.body.auditProgress?.stage!=='full_audit_pending';n++){assert.equal(response.status,202,JSON.stringify(response.body));assert.ok(n<250);response=await post(store,{restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'complete-'+n});}
 return{store,source,state:restoreProgress(store.db),response};
}
function counted(store,operation){const prepare=store.db.prepare.bind(store.db),counts={private_reminders:0,private_reminder_commands:0};store.db.prepare=sql=>{const statement=prepare(sql),name=/^SELECT \* FROM (private_reminders|private_reminder_commands)$/.exec(sql)?.[1];if(!name)return statement;return new Proxy(statement,{get(target,key){if(key==='all')return(...args)=>{counts[name]++;return target.all(...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});};try{return{result:operation(),counts};}finally{store.db.prepare=prepare;}}
for(const current of [false,true])test('complete reminder proof replaces only repeated semantic scan; current='+current,async t=>{
 const f=await completed(t,current),{store,state}=f;
 assert.throws(()=>withCompletedRecoveryReminders(store,state.restore_id,state.seal.id,()=>null),/reconciliation/);
 const audit=()=>withRestoreTransaction(store,()=>auditRecovery(store));
 const ordinary=counted(store,audit),consumed=counted(store,()=>withRestoreTransaction(store,()=>withCompletedRecoveryReminders(store,state.restore_id,state.seal.id,()=>auditRecovery(store))));
 assert.deepEqual(consumed.result,ordinary.result,'same literal audit-instant report, including original report fingerprint');
 assert.deepEqual(ordinary.counts,{private_reminders:2,private_reminder_commands:2});assert.deepEqual(consumed.counts,{private_reminders:1,private_reminder_commands:1},'report fingerprint remains mandatory and still scans both tables');
 assert.deepEqual(counted(store,audit).counts,ordinary.counts,'capability expires after callback');
 assert.throws(()=>withRestoreTransaction(store,()=>withCompletedRecoveryReminders(store,state.restore_id,'wrong',()=>null)),/reconciliation/);
 assert.throws(()=>withRestoreTransaction(store,()=>withCompletedRecoveryReminders(store,state.restore_id,state.seal.id,()=>Promise.resolve())),/reconciliation/);
 assert.throws(()=>withRestoreTransaction(store,()=>withCompletedRecoveryReminders(store,state.restore_id,state.seal.id,()=>{checkpointRestore(store.db,{restoreId:state.restore_id,expectedRevision:state.revision,phase:'audit_pending',seal:state.seal,progress:state.progress,latest:null});verifyRemindersForRecovery(store,new Map());})),/reconciliation/);
 assert.deepEqual(counted(store,audit).counts,ordinary.counts,'failed revision drift rolls back and releases scope');
 assert.deepEqual(restoreProgress(store.db),state,'refusals are read-only and preserve persisted proof');
 let input,published,receipt={restoreId:state.restore_id,sourceSeal:state.seal.id,revision:state.revision};for(let n=0;n<10000;n++){input={restoreId:receipt.restoreId,sourceSeal:receipt.sourceSeal,expectedRevision:receipt.revision,requestId:'publication-'+n};published=await post(store,input);if(!published.body.pending)break;assert.equal(published.status,202,JSON.stringify(published.body));receipt=published.body;}assert.equal(published.status,200,JSON.stringify(published.body));assert.equal(published.body.verified,true);assert.deepEqual(await post(store,input),published);
 assert.deepEqual(counted(store,()=>auditRecovery(store)).counts,ordinary.counts,'ordinary post-publication audit always runs original predicates');
 t.diagnostic(JSON.stringify({current,defaultReminderTableScans:ordinary.counts,consumedReminderTableScans:consumed.counts,reportVersion:ordinary.result.contractVersion,fullOracleStillRequired:true,wholeRecoveryBounded:false}));
});
test('consumption refuses incomplete, old-version, mismatched counts and changed freeze before private payload scans',async t=>{
 const f=await completed(t,true),{store,state}=f;
 const replace=audit=>withRestoreTransaction(store,()=>checkpointRestore(store.db,{restoreId:state.restore_id,expectedRevision:restoreProgress(store.db).revision,phase:'audit_pending',seal:state.seal,progress:{...state.progress,audit},latest:null}));
 for(const mutation of [a=>a.stage='reminders',a=>a.reminders.version=1,a=>a.reminders.stage='rows',a=>a.reminders.receipts++,a=>a.reminders.rows++,a=>a.reminders.groups++]){
  const audit=structuredClone(state.progress.audit);mutation(audit);replace(audit);const before=restoreProgress(store.db);
  const checked=counted(store,()=>{assert.throws(()=>withRestoreTransaction(store,()=>withCompletedRecoveryReminders(store,state.restore_id,state.seal.id,()=>verifyRemindersForRecovery(store,new Map()))),/reconciliation/);});
  assert.deepEqual(checked.counts,{private_reminders:0,private_reminder_commands:0});assert.deepEqual(restoreProgress(store.db),before);
 }
 replace(state.progress.audit);
 const guard=store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'restore_frozen_*' LIMIT 1").get();assert.ok(guard);
 store.db.exec('DROP TRIGGER "'+guard.name+'"');const before=restoreProgress(store.db);
 assert.throws(()=>withRestoreTransaction(store,()=>withCompletedRecoveryReminders(store,state.restore_id,state.seal.id,()=>null)),/reconciliation|schema/);assert.deepEqual(restoreProgress(store.db),before);store.db.exec(guard.sql);
});

test('zero and negative safe hidden rowids preserve original reminder semantics on sealed target',async t=>{
 const f=await fixture(t);edit(f,['private_reminder_commands','private_reminders'],db=>{db.prepare("UPDATE private_reminder_commands SET rowid=-7 WHERE request_id='schedule-0001'").run();db.prepare("UPDATE private_reminders SET rowid=0 WHERE work_item_id='active'").run();});
 assert.doesNotThrow(()=>withRestoreTransaction(f.store,()=>auditRecovery(f.store)));assert.equal(drive(f).stage,'complete');
});
