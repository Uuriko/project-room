import {recoveryReminderReceipt,recoveryReminderStep,recoveryReminderCurrent} from './recovery-reminder-rules.mjs';
import {validateRecoveryReminders} from './recovery-reminder-continuation.mjs';
import {inRestoreContext,restoreProgress,RESTORE_AUDIT_VERSION} from './restore-admission.mjs';
import {verifyRestoreFreeze} from './writer-fence.mjs';
const consumed=new WeakMap();
const requireState=condition=>{if(!condition)throw Error('Recovery data requires operator reconciliation');};
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
function originalReminderAudit(store,rooms){
    const reminders = store.db.prepare("SELECT * FROM private_reminders").all();
    const receipts = store.db.prepare("SELECT * FROM private_reminder_commands").all();
    const byWork = new Map();
    for (const row of receipts) {
      const receipt = recoveryReminderReceipt(row);
      const key = canonical([row.room_id, row.member_id, receipt.workItemId]);
      const history = byWork.get(key) ?? [];
      requireState(!history.some(item => item.revision === receipt.revision));
      history.push(receipt); byWork.set(key, history);
    }
    for (const history of byWork.values()) {
      history.sort((a, b) => a.revision - b.revision);
      for (let i = 0; i < history.length; i++) recoveryReminderStep(i ? history[i - 1] : null, history[i]);
    }
    for (const row of reminders) {
      const state = rooms.get(row.room_id), member = state?.members[row.member_id], work = state?.workItems[row.work_item_id];
      const key = canonical([row.room_id, row.member_id, row.work_item_id]);
      const history = byWork.get(key), latest = history?.reduce((a, b) => a.revision > b.revision ? a : b);
      const account = store.accountForMember(row.room_id, row.member_id);
      recoveryReminderCurrent(row, latest, { member, work, account });
      byWork.delete(key);
    }
    requireState(byWork.size === 0);
    return{reminders:reminders.length,reminderReceipts:receipts.length};
}
function authority(store,id,sealId){
 const db=store.db;requireState(db.isTransaction&&inRestoreContext(db));
 const state=restoreProgress(db),audit=state.progress?.audit;
 requireState(state.state==='pending'&&state.phase==='audit_pending'&&state.restore_id===id&&state.seal?.id===sealId
   && state . seal . auditVersion === RESTORE_AUDIT_VERSION && audit ?. version === RESTORE_AUDIT_VERSION && audit . stage === 'full_audit_pending' ) ;
 const cursor=audit.reminders;validateRecoveryReminders(cursor);
 const entry=table=>state.seal.tables.find(e=>e.name===table);
 requireState(cursor.stage==='complete'&&cursor.version===2&&cursor.receipts===entry('private_reminder_commands')?.expected.rows
  &&cursor.rows===entry('private_reminders')?.expected.rows&&cursor.rows===cursor.groups);
 return{state,cursor};
}
// A synchronous target-local capability for this ONE complete subsystem.
// Ordinary audits always run the original global reminder predicates above.
export function withCompletedRecoveryReminders(store,id,sealId,operation){
 const{state,cursor}=authority(store,id,sealId);verifyRestoreFreeze(store.db,state.seal.inventory);
 const before=consumed.get(store.db);consumed.set(store.db,{id,sealId,revision:state.revision,cursor:JSON.stringify(cursor)});
 try{const result=operation();requireState(!result?.then);return result;}
 finally{if(before)consumed.set(store.db,before);else consumed.delete(store.db);}
}
export function verifyRemindersForRecovery(store,rooms){
 const permit=consumed.get(store.db);if(!permit)return originalReminderAudit(store,rooms);
 const{state,cursor}=authority(store,permit.id,permit.sealId);requireState(state.revision===permit.revision&&JSON.stringify(cursor)===permit.cursor);
 return{reminders:cursor.rows,reminderReceipts:cursor.receipts};
}
