import {placementFeeBreakdown,trialManagementFee} from "./demigod-policy-adapter.mjs";
import {createFeeCreditLedger} from "./fee-credit-ledger.mjs";
import {routeSettlement} from "./settlement-router.mjs";
// Durable, room-scoped RECORD-ONLY trial authority. No keys, money or hosts are provisioned.
import {canonicalJson} from '../src/audit-receipts.mjs';
import {validId, ownMember} from '../src/events.js';
import {createTrialTask,fundTrialTask,claimTrialTask,submitTrialTask,verdictTrialTask,receiptTrialTask,blockTrialTask,resumeTrialTask,releaseTrialTask} from './trial-tasks.mjs';
import {verifyVettingReceipt} from './vetting-receipts.mjs';
export const trialTaskSchema=`
CREATE TABLE IF NOT EXISTS room_trial_tasks(room_id TEXT NOT NULL,task_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(room_id,task_id));
CREATE TABLE IF NOT EXISTS room_trial_requests(room_id TEXT NOT NULL,request_id TEXT NOT NULL,actor_id TEXT NOT NULL,input TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(room_id,request_id));
CREATE TABLE IF NOT EXISTS room_vetting_keys(room_id TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS room_vetting_receipts(room_id TEXT NOT NULL,receipt_id TEXT NOT NULL,task_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(room_id,receipt_id),UNIQUE(room_id,task_id),UNIQUE(receipt_id));
CREATE TRIGGER IF NOT EXISTS record_rails_room_deleted AFTER DELETE ON rooms BEGIN
DELETE FROM room_trial_tasks WHERE room_id=OLD.id;
DELETE FROM room_trial_requests WHERE room_id=OLD.id;
DELETE FROM room_vetting_keys WHERE room_id=OLD.id;
DELETE FROM room_vetting_receipts WHERE room_id=OLD.id;
DELETE FROM demigod_offer_profiles WHERE room_id=OLD.id;
DELETE FROM demigod_offer_requests WHERE room_id=OLD.id;
DELETE FROM demigod_contracts WHERE room_id=OLD.id;
DELETE FROM demigod_contract_requests WHERE room_id=OLD.id;
DELETE FROM buyer_signoff_loops WHERE room_id=OLD.id;
DELETE FROM buyer_signoff_requests WHERE room_id=OLD.id;
END;`;
export const railFail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
export function railActor(store,roomId,actorId,{writing=false}={}) {
 const state=store.room(roomId).state,member=state.members[actorId];
 if(!member||member.active===false)railFail(403,'access_denied','Active room membership required');
 if(writing&&state.room.archivedAt)railFail(409,'room_archived','Archived room');
 if(writing&&member.kind==='agent'&&!member.permissions.includes('accept_work'))railFail(403,'access_denied','Agent needs accept_work');
 return state;
}
const identifier=id=>{if(!validId(id))railFail(422,'invalid_trial_input','Invalid identifier');return id;};
const shape=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k))||Buffer.byteLength(JSON.stringify(input))>65536)railFail(422,'invalid_trial_input','Unexpected fields or oversized input');};
export class TrialTasks {
 constructor(store){this.store=store;this.db=store.db;}
 raw(roomId,id){const row=this.db.prepare('SELECT value FROM room_trial_tasks WHERE room_id=? AND task_id=?').get(roomId,identifier(id));if(!row)railFail(404,'trial_task_not_found','Trial not found');return JSON.parse(row.value);}
 read(roomId,actorId,id){const state=railActor(this.store,roomId,actorId),task=this.raw(roomId,id);if(actorId!==state.room.ownerId&&actorId!==task.buyerId&&actorId!==task.candidateId)railFail(403,'access_denied','Trial is private to its parties');return task;}
 list(roomId,actorId){const state=railActor(this.store,roomId,actorId);return {tasks:this.db.prepare('SELECT value FROM room_trial_tasks WHERE room_id=? ORDER BY rowid DESC LIMIT 100').all(roomId).map(r=>JSON.parse(r.value)).filter(t=>actorId===state.room.ownerId||actorId===t.buyerId||actorId===t.candidateId)};}
 apply(roomId,actorId,input){
  const state=railActor(this.store,roomId,actorId,{writing:true});
  shape(input,['action','requestId','taskId','expectedRevision','pubkey','candidateId','buyerId','demigodReqId','title','trialScope','vettingRubric','feePolicyRef','budgetRecord','deliverableRef','rubricScores','verdict','receipt','reason','placementValueMinor','currency','trialHoursMax','hourlyRateMinor']);identifier(input.requestId);
  const owner=actorId===state.room.ownerId,now=new Date(this.store.now()).toISOString();
  return this.store.transaction(()=>{
   const fingerprint=canonicalJson(input),previous=this.db.prepare('SELECT * FROM room_trial_requests WHERE room_id=? AND request_id=?').get(roomId,input.requestId);
   if(previous){if(previous.actor_id!==actorId||previous.input!==fingerprint)railFail(409,'request_id_reused','Request ID already used');if(!['configure','quote'].includes(input.action))this.read(roomId,actorId,input.taskId);return JSON.parse(previous.outcome);}
   let result;
   if(input.action==='quote'){
    if(!owner)railFail(403,'owner_only','Owner-only hypothetical policy calculation');
    shape(input,['action','requestId','placementValueMinor','currency','trialHoursMax','hourlyRateMinor']);
    if(!['placementValueMinor','trialHoursMax','hourlyRateMinor'].every(k=>typeof input[k]==='string'&&/^[0-9]{1,18}$/.test(input[k]))||!/^[A-Z]{3}$/.test(input.currency))railFail(422,'invalid_quote','Bounded decimal strings and currency required');
    const placement=placementFeeBreakdown(input),trial=trialManagementFee(input),ledger=createFeeCreditLedger({now:()=>this.store.now()});
    ledger.recordTrialFee({clientId:actorId,trialTaskId:input.requestId,feeMinor:trial.feeMinor});
    const creditMinor=(BigInt(trial.feeMinor)<BigInt(placement.feeMinor)?BigInt(trial.feeMinor):BigInt(placement.feeMinor)).toString();
    if(BigInt(creditMinor)>0n)ledger.applyCreditToPlacement({clientId:actorId,placementId:input.requestId,trialTaskId:input.requestId,creditMinor});
    result={recordOnly:true,paymentStatus:'not_configured',hypothetical:true,placement,trial,illustrativeCreditMinor:creditMinor,illustrativeEntries:ledger.entries(),settlement:routeSettlement({venue:'project-room',amountMinor:placement.feeMinor,rail:'not-configured'})};
   } else if(input.action==='configure'){
    if(!owner)railFail(403,'owner_only','Owner must establish receipt key provenance');
    shape(input,['action','requestId','expectedRevision','pubkey']);
    if(typeof input.pubkey!=='string'||!/^[0-9a-f]{64}$/.test(input.pubkey))railFail(422,'invalid_receipt_key','Ed25519 public key required');
    if(this.db.prepare("SELECT 1 FROM room_trial_requests WHERE room_id<>? AND json_extract(outcome,'$.pubkey')=?").get(roomId,input.pubkey))railFail(409,'receipt_key_already_bound','Use a distinct issuer key for each room');
    const current=JSON.parse(this.db.prepare('SELECT value FROM room_vetting_keys WHERE room_id=?').get(roomId)?.value??'{"revision":0}');
    if(input.expectedRevision!==current.revision)railFail(409,'stale_revision','Receipt key changed');
    result={revision:current.revision+1,pubkey:input.pubkey,configuredBy:actorId,configuredAt:now};
    this.db.prepare('INSERT INTO room_vetting_keys VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET value=excluded.value').run(roomId,JSON.stringify(result));
   } else {
    identifier(input.taskId);let task;
    if(input.action==='create'){
     if(!owner)railFail(403,'owner_only','Only owner may record a trial');
     shape(input,['action','requestId','taskId','candidateId','buyerId','demigodReqId','title','trialScope','vettingRubric','feePolicyRef','budgetRecord']);
     if(this.db.prepare('SELECT 1 FROM room_trial_tasks WHERE room_id=? AND task_id=?').get(roomId,input.taskId))railFail(409,'trial_exists','Trial ID already exists');
     // #1004 follow-up: own-property lookup — an inherited Object.prototype name must never satisfy "active room member".
     for(const id of [input.candidateId,input.buyerId]){const party=ownMember(state.members,id);if(!party||party.active===false)railFail(422,'invalid_trial_party','Parties must be active room members');}
     if(input.candidateId===input.buyerId)railFail(422,'invalid_trial_party','Candidate and buyer must differ');
     task={...createTrialTask({...input,id:input.taskId},now),roomId,buyerId:input.buyerId,revision:0,recordOnly:true,paymentStatus:'not_configured'};
     if(input.budgetRecord)task=fundTrialTask(task,{...input.budgetRecord,recordedBy:actorId},now);
    } else {
     task=this.read(roomId,actorId,input.taskId);
     if(input.expectedRevision!==task.revision)railFail(409,'stale_revision','Trial changed');
     const candidate=actorId===task.candidateId,buyer=actorId===task.buyerId;
     const fields={claim:[],submit:['deliverableRef'],fund:['budgetRecord'],verdict:['rubricScores','verdict','receipt'],block:['reason'],resume:[],release:['reason']}[input.action];
     if(!fields)railFail(422,'invalid_trial_action','Unknown action');
     shape(input,['action','requestId','taskId','expectedRevision',...fields]);
     if(['claim','submit'].includes(input.action)?!candidate:!owner&&!buyer)railFail(403,'trial_not_party','Action requires the bound candidate, buyer or owner');
     if(input.action==='claim')task=claimTrialTask(task,{candidateId:actorId},now);
     if(input.action==='submit')task=submitTrialTask(task,{deliverableRef:input.deliverableRef},now);
     if(input.action==='fund')task=fundTrialTask(task,{...input.budgetRecord,recordedBy:actorId},now);
     if(input.action==='block')task=blockTrialTask(task,{reason:input.reason},now);
     if(input.action==='resume')task=resumeTrialTask(task,now);
     if(input.action==='release')task=releaseTrialTask(task,{reason:input.reason},now);
     if(input.action==='verdict'){
      // Buyer must sign off on delivery before an evaluator can receipt it.
      const loops=this.db.prepare('SELECT status FROM buyer_signoff_loops WHERE room_id=? AND trial_task_id=?').all(roomId,task.id);
      if(!loops.length||loops.some(l=>l.status!=='accepted'))railFail(409,'buyer_signoff_required','Buyer acceptance required');
      const key=JSON.parse(this.db.prepare('SELECT value FROM room_vetting_keys WHERE room_id=?').get(roomId)?.value??'null');
      const receipt=input.receipt;
      if(!key||!verifyVettingReceipt(receipt,{expectedPubkey:key.pubkey,now:this.store.now(),expectedCandidateId:task.candidateId,expectedTrialTaskId:task.id}).ok)railFail(422,'invalid_vetting_receipt','Trusted signed receipt required');
      if(receipt.demigodReqId!==task.demigodReqId||canonicalJson(receipt.scope)!==canonicalJson(task.trialScope)||canonicalJson(receipt.rubricScores)!==canonicalJson(input.rubricScores)||receipt.verdict!==input.verdict||receipt.evaluator.id!==actorId||receipt.evaluator.kind!==state.members[actorId].kind)railFail(422,'receipt_binding_mismatch','Receipt must bind exact trial, evaluator and decision');
      task=receiptTrialTask(verdictTrialTask(task,{rubricScores:input.rubricScores,verdict:input.verdict},now),{receiptRef:receipt.receiptId},now);
      if(this.db.prepare('SELECT 1 FROM room_vetting_receipts WHERE room_id=? AND receipt_id=?').get(roomId,receipt.receiptId))railFail(409,'receipt_replayed','Receipt already used');
      this.db.prepare('INSERT INTO room_vetting_receipts VALUES(?,?,?,?)').run(roomId,receipt.receiptId,task.id,JSON.stringify({receipt,trust:key,verifiedAt:now}));
     }
     task={...task,revision:task.revision+1};
    }
    this.db.prepare('INSERT INTO room_trial_tasks VALUES(?,?,?) ON CONFLICT(room_id,task_id) DO UPDATE SET value=excluded.value').run(roomId,task.id,JSON.stringify(task));result=task;
   }
   this.db.prepare('INSERT INTO room_trial_requests VALUES(?,?,?,?,?)').run(roomId,input.requestId,actorId,fingerprint,JSON.stringify(result));return result;
  });
 }
 verified(roomId,trialId,receiptId){const task=this.raw(roomId,trialId),row=this.db.prepare('SELECT value FROM room_vetting_receipts WHERE room_id=? AND receipt_id=? AND task_id=?').get(roomId,receiptId,trialId);if(!row||task.state!=='receipted'||task.verdict!=='pass'||task.receiptRef!==receiptId)railFail(422,'verified_receipt_required','Successful stored vetting receipt required');const saved=JSON.parse(row.value);if(!verifyVettingReceipt(saved.receipt,{expectedPubkey:saved.trust.pubkey,now:Date.parse(saved.verifiedAt),expectedCandidateId:task.candidateId,expectedTrialTaskId:task.id}).ok)railFail(422,'invalid_vetting_receipt','Stored receipt invalid');return task;}
}
