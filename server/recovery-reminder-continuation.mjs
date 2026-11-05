import {isWorkReference,hydrateWorkRecord} from './work-repository.mjs';
import {inRestoreContext,restoreProgress} from './restore-admission.mjs';
import {Buffer} from 'node:buffer';
import {isCurrentRoom,withCurrentAuditUnits} from './current-room-repository.mjs';
import {recoveryReminderReceipt,recoveryReminderStep,recoveryReminderCurrent} from './recovery-reminder-rules.mjs';
const fail=()=>{throw Error('Recovery reminder ledger requires operator reconciliation');};
export const initialRecoveryReminders=()=>({version:2,stage:'receipts',after:null,receipts:0,rows:0,groups:0,groupAfter:'',groupKey:null,revision:0,prior:null});
export function validateRecoveryReminders(p){
 if(!p||Object.keys(p).sort().join(',')!=='after,groupAfter,groupKey,groups,prior,receipts,revision,rows,stage,version'||p.version!==2||!['receipts','history','rows','complete'].includes(p.stage))fail();
 if(!(p.after===null||Number.isSafeInteger(p.after))||!['receipts','rows','groups','revision'].every(key=>Number.isSafeInteger(p[key])&&p[key]>=0)||typeof p.groupAfter!=='string'||Buffer.byteLength(p.groupAfter)>1024||p.groupKey!==null&&(typeof p.groupKey!=='string'||Buffer.byteLength(p.groupKey)>1024))fail();
 if(p.stage==='complete'&&(p.groupKey!==null||p.prior!==null||p.revision!==0))fail();
 if(p.prior!==null&&(!p.prior||Buffer.byteLength(JSON.stringify(p.prior))>4096||p.prior.revision!==p.revision)||p.groupKey===null&&(p.revision!==0||p.prior!==null))fail();
}
const quote=name=>'"'+name.replaceAll('"','""')+'"';
function sealed(seal,table){const entry=seal?.tables?.find(row=>row.name===table);if(!entry||!Number.isSafeInteger(entry.maxRowBytes)||entry.maxRowBytes<0||!Number.isSafeInteger(entry.expected?.rows)||entry.expected.rows<0)fail();return entry;}
function rowScalar(db,table,where,args){
 const columns=table==='private_reminder_commands'?['room_id','member_id','request_id','fingerprint','response']:['room_id','member_id','work_item_id','revision','due_at','state','basis_work_revision','created_at','updated_at'];
 const expression=columns.map(name=>'coalesce(length(CAST('+quote(name)+' AS BLOB)),0)').join('+');
 return db.prepare('SELECT rowid,('+expression+')+4096 bytes FROM '+quote(table)+' WHERE '+where+' ORDER BY rowid LIMIT 1').get(...args);
}
function admitted(row,entry){
 if(!row)return false;
 // The seal's existing encoded-row maximum is an admission bound, never a
 // trust substitute for the independent semantic checks below.
 if(!Number.isSafeInteger(row.rowid)||!Number.isSafeInteger(row.bytes)||row.bytes<4096||row.bytes>entry.maxRowBytes+4096)fail();return true;
}
function contextBytes(db,row,seal){
 if(isCurrentRoom(db,row.room_id)){
  const head=db.prepare("SELECT length(CAST(h.counts_json AS BLOB)) bytes,(SELECT length(CAST(a.counts_json AS BLOB)) FROM operator_actions a WHERE a.id=h.receipt_id) receipt_bytes FROM current_room_head h WHERE h.room_id=?").get(row.room_id);
  if(!head||![head.bytes,head.receipt_bytes].every(n=>Number.isSafeInteger(n)&&n>=0))fail();
  let bytes=8192+head.bytes+head.receipt_bytes;
  for(const [domain,key]of [['members',row.member_id],['workItems',row.work_item_id]]){
   const r=db.prepare("SELECT r.payload_bytes,(SELECT length(CAST(a.counts_json AS BLOB)) FROM operator_actions a WHERE a.id=p.receipt_id) receipt_bytes FROM current_room_record_proofs p LEFT JOIN current_room_records r ON r.room_id=p.room_id AND r.domain=p.domain AND r.record_key=p.record_key WHERE p.room_id=? AND p.domain=? AND p.record_key=?").get(row.room_id,domain,key);
   bytes+=(r?.payload_bytes??0)+(r?.receipt_bytes??0);
  }
  bytes+=db.prepare('SELECT length(CAST(body AS BLOB)) bytes FROM work_entities WHERE room_id=? AND work_id=?').get(row.room_id,row.work_item_id)?.bytes??0;
  if(!Number.isSafeInteger(bytes)||bytes<4096)fail();return bytes;
 }
 const entry=sealed(seal,'rooms'),scalar=db.prepare('SELECT length(CAST(projection AS BLOB)) bytes FROM rooms WHERE id=?').get(row.room_id);
 if(!scalar||!Number.isSafeInteger(scalar.bytes)||scalar.bytes<1||scalar.bytes>entry.maxRowBytes)fail();
 // Legacy JSON extraction remains a measured SQLite atom; do not call it
 // strict CPU-bounded. No whole projection enters JavaScript.
 const work=sealed(seal,'work_entities'),entity=db.prepare('SELECT length(CAST(body AS BLOB)) bytes FROM work_entities WHERE room_id=? AND work_id=?').get(row.room_id,row.work_item_id);
 if(entity&&(!Number.isSafeInteger(entity.bytes)||entity.bytes<1||entity.bytes>work.maxRowBytes))fail();
 return scalar.bytes+(entity?.bytes??0)+8192;
}
function reminderAccount(db,row){
 // Exactly the account existence/active fields consumed by the shared rule;
 // unrelated account metadata must not be hydrated for a reminder check.
 const account=db.prepare('SELECT a.active FROM member_accounts m JOIN accounts a ON a.id=m.account_id WHERE m.room_id=? AND m.member_id=?').get(row.room_id,row.member_id);
 return account?{active:account.active===1}:null;
}
function readContext(store,row){
 const db=store.db;
 if(isCurrentRoom(db,row.room_id))return withCurrentAuditUnits(store,row.room_id,reader=>{
  const member=reader.record('members',row.member_id),ref=reader.record('workItems',row.work_item_id);
  return{member,work:ref===undefined?undefined:reader.work(row.work_item_id,ref),account:reminderAccount(db,row)};
 });
 // The original full oracle hydrates JSON.parse(projection): LAST top-level
 // map and LAST selected key, followed by the existing work-reference proof.
 const selected=map=>`(SELECT json_quote(value) FROM json_each((SELECT value FROM json_each(rooms.projection) WHERE key='${map}' ORDER BY id DESC LIMIT 1)) WHERE CAST(key AS TEXT)=? ORDER BY id DESC LIMIT 1)`;
 const r=db.prepare('SELECT '+selected('members')+' member,'+selected('workItems')+' work FROM rooms WHERE id=?').get(row.member_id,row.work_item_id,row.room_id);
 const member=r?.member?JSON.parse(r.member):undefined,reference=r?.work?JSON.parse(r.work):undefined;
 const work=isWorkReference(reference)?hydrateWorkRecord(row.work_item_id,reference,db.prepare('SELECT revision,digest,body FROM work_entities WHERE room_id=? AND work_id=?').get(row.room_id,row.work_item_id)):reference;
 return{member,work,account:reminderAccount(db,row)};
}
// Called inside the existing sealed restore/scratch transaction. Every
// receipt is checked independently, then ordered revisions prove the ledger;
// target-row/source-bag equality alone cannot establish any of these rules.
export function advanceRecoveryReminders(store,scratch,restoreId,previous,seal){
 validateRecoveryReminders(previous);const p=structuredClone(previous),db=store.db;let units=0,bytes=0;
 if(!db.isTransaction||!inRestoreContext(db))fail();
 const authority=restoreProgress(db);
 if(authority.state!=='pending'||authority.restore_id!==restoreId||authority.phase!=='audit_pending'||authority.seal?.id!==seal?.id)fail();
 seal=authority.seal;
 const commands=sealed(seal,'private_reminder_commands'),reminders=sealed(seal,'private_reminders');
 if(p.stage==='complete'&&(p.receipts!==commands.expected.rows||p.rows!==reminders.expected.rows||p.rows!==p.groups))fail();
 store.reminders.verifySchema();
 while(units<128){
  if(p.stage==='complete')return{cursor:p,units,bytes,done:true};
  if(p.stage==='receipts'){
   const scalar=rowScalar(db,'private_reminder_commands',p.after===null?'1':'rowid>?',p.after===null?[]:[p.after]);
   if(!scalar){if(p.receipts!==commands.expected.rows)fail();p.stage='history';p.after=null;return{cursor:p,units,bytes,done:false};}
   admitted(scalar,commands);if(bytes+scalar.bytes>4*1024*1024){if(units)break;fail();}
   if(scratch.remaining<2)break;
   const row=db.prepare('SELECT * FROM private_reminder_commands WHERE rowid=?').get(scalar.rowid),receipt=recoveryReminderReceipt(row),key=JSON.stringify([row.room_id,row.member_id,receipt.workItemId]);
   if(scratch.get('actual','','reminderReceipt',key,receipt.revision)!==undefined)fail();
   scratch.put('actual','','reminderReceipt',key,receipt,receipt.revision);
   scratch.ensure('actual','','reminderGroup',key,{roomId:row.room_id,memberId:row.member_id,workItemId:receipt.workItemId});
   p.after=scalar.rowid;p.receipts++;units++;bytes+=scalar.bytes;continue;
  }
  if(p.stage==='history'){
   if(p.groupKey===null){
    const key=scratch.nextKey('actual','','reminderGroup',p.groupAfter);
    if(key===undefined){p.stage='rows';p.after=null;continue;}
    if(Buffer.byteLength(key)>1024)fail();p.groupKey=key;p.revision=0;p.prior=null;
   }
   const next=db.prepare("SELECT part,payload_bytes,length(CAST(payload AS BLOB)) bytes FROM current_restore_audit_scratch WHERE restore_id=(SELECT restore_id FROM current_restore_admission WHERE singleton=1) AND lane='actual' AND room_id='' AND domain='reminderReceipt' AND unit_key=? AND part>? ORDER BY part LIMIT 1").get(p.groupKey,p.revision);
   if(next){
    if(!Number.isSafeInteger(next.bytes)||next.bytes<1||next.bytes!==next.payload_bytes||next.bytes>4096||bytes+next.bytes>4*1024*1024){if(units)break;fail();}
    const receipt=scratch.get('actual','','reminderReceipt',p.groupKey,next.part);if(receipt?.revision!==next.part)fail();recoveryReminderStep(p.prior,receipt);p.prior=receipt;p.revision=next.part;units++;bytes+=next.bytes;continue;
   }
   if(!p.prior)fail();
   const group=scratch.get('actual','','reminderGroup',p.groupKey);if(!group||JSON.stringify([group.roomId,group.memberId,group.workItemId])!==p.groupKey)fail();
   const scalar=rowScalar(db,'private_reminders','room_id=? AND member_id=? AND work_item_id=?',[group.roomId,group.memberId,group.workItemId]);if(!admitted(scalar,reminders))fail();
   const addressed={room_id:group.roomId,member_id:group.memberId,work_item_id:group.workItemId},cost=scalar.bytes+contextBytes(db,addressed,seal);
   if(units&&bytes+cost>4*1024*1024)break;
   if(scratch.remaining<1)break;
   const row=db.prepare('SELECT * FROM private_reminders WHERE rowid=?').get(scalar.rowid);
   recoveryReminderCurrent(row,p.prior,readContext(store,row));
   scratch.put('actual','','reminderVerified',p.groupKey,true);p.groups++;p.groupAfter=p.groupKey;p.groupKey=null;p.revision=0;p.prior=null;units++;bytes+=cost;continue;
  }
  if(p.stage==='rows'){
   const scalar=rowScalar(db,'private_reminders',p.after===null?'1':'rowid>?',p.after===null?[]:[p.after]);
   if(!scalar){if(p.rows!==reminders.expected.rows||p.rows!==p.groups)fail();p.stage='complete';continue;}
   admitted(scalar,reminders);if(bytes+scalar.bytes>4*1024*1024){if(units)break;fail();}
   const row=db.prepare('SELECT room_id,member_id,work_item_id FROM private_reminders WHERE rowid=?').get(scalar.rowid),key=JSON.stringify([row.room_id,row.member_id,row.work_item_id]);
   if(scratch.get('actual','','reminderVerified',key)!==true)fail();p.after=scalar.rowid;p.rows++;units++;bytes+=scalar.bytes;continue;
  }
  fail();
 }
 return{cursor:p,units,bytes,done:p.stage==='complete'};
}
