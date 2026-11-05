// Exact existing full recovery predicates, shared with the durable ledger scan.
import {createHash} from 'node:crypto';
import {validId} from '../src/events.js';
import {terminalWork} from '../src/workflow.js';
const requireState=condition=>{if(!condition)throw Error('Recovery data requires operator reconciliation');};
const integer=value=>Number.isSafeInteger(value);
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
export function recoveryReminderReceipt(row){
 const receipt=JSON.parse(row.response);
 requireState(receipt && Object.keys(receipt).sort().join(' ')==='dueAt requestId revision state workItemId'
  && validId(row.member_id)&&validId(row.request_id)&&receipt.requestId===row.request_id
  && validId(receipt.workItemId)&&integer(receipt.revision)&&receipt.revision>0
  && integer(receipt.dueAt)&&['active','cancelled'].includes(receipt.state));
 const request={requestId:receipt.requestId,workItemId:receipt.workItemId,expectedRevision:receipt.revision-1,action:receipt.state==='active'?'schedule':'cancel',...(receipt.state==='active'?{dueAt:receipt.dueAt}:{})};
 requireState(row.fingerprint===createHash('sha256').update(canonical(request)).digest('hex'));return receipt;
}
export function recoveryReminderStep(prior,next){
 if(!prior){requireState(next.revision===1&&next.state==='active');return;}
 const step=next.revision-prior.revision;
 requireState(step===1||(step===2&&prior.state==='active'&&next.state==='active'));
 if(next.state==='cancelled')requireState(prior.state==='active'&&step===1&&prior.dueAt===next.dueAt);
}
export function recoveryReminderCurrent(row,latest,{member,work,account}){
 requireState(member&&work&&integer(row.revision)&&row.revision>0&&integer(row.due_at)
  &&integer(row.basis_work_revision)&&row.basis_work_revision>=0&&row.basis_work_revision<=work.revision
  &&integer(row.created_at)&&integer(row.updated_at)&&latest
  &&latest.dueAt===row.due_at&&['active','cancelled','resolved'].includes(row.state));
 if(row.state==='resolved')requireState(latest.state==='active'&&row.revision===latest.revision+1);
 else requireState(latest.revision===row.revision&&latest.state===row.state);
 if(member.kind==='human')requireState(account);
 if(row.state==='active')requireState(member.active&&!terminalWork(work)&&(member.kind!=='human'||account.active));
}
