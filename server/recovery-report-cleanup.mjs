import {applicationTables} from './writer-fence.mjs';
import {inRestoreContext,RESTORE_CONTROL_GUARDS,withExactRestoreGuards} from './restore-admission.mjs';
const fail=()=>{throw Error('Restore report workspace ownership requires reconciliation');};
const order='restore_id,lane,room_id,domain,unit_key,part';
export function verifyRecoveryReportScratch(db,id,remaining){
 if(!db.isTransaction||!inRestoreContext(db)||!Number.isSafeInteger(remaining)||remaining<0)fail();
 const first=db.prepare(`SELECT restore_id=? own,lane='report' report FROM current_restore_audit_scratch ORDER BY ${order} LIMIT 1`).get(id);
 if(remaining===0){if(first)fail();return;}
 const last=db.prepare("SELECT restore_id=? own,lane='report' report FROM current_restore_audit_scratch ORDER BY restore_id DESC,lane DESC,room_id DESC,domain DESC,unit_key DESC,part DESC LIMIT 1").get(id);
 if(first?.own!==1||first.report!==1||last?.own!==1||last.report!==1)fail();
}
function owned(row){
 if(row.domain==='fingerprint-snapshot')return row.room_id===''&&(row.unit_key==='header'&&row.part===0||['source_seal','coverage','latest_receipt'].includes(row.unit_key)&&row.part>=1&&row.part<=16);
 return applicationTables.includes(row.room_id)&&['fingerprint-data','fingerprint-index0','fingerprint-index1'].includes(row.domain)&&/^[0-9]{16}$/.test(row.unit_key)&&Number.isSafeInteger(Number(row.unit_key))&&(row.domain==='fingerprint-data'||row.part===0);
}
export function deleteRecoveryReportScratch(db,id,remaining){
 verifyRecoveryReportScratch(db,id,remaining);if(remaining===0)return{removed:0,remaining:0};const want=Math.min(128,remaining);
 const scalars=db.prepare(`SELECT rowid AS rid,length(CAST(room_id AS BLOB)) room_bytes,length(CAST(domain AS BLOB)) domain_bytes,length(CAST(unit_key AS BLOB)) key_bytes,part FROM current_restore_audit_scratch WHERE restore_id=? AND lane='report' ORDER BY room_id,domain,unit_key,part LIMIT ?`).all(id,want);
 if(scalars.length!==want||scalars.some(r=>!Number.isSafeInteger(r.rid)||!Number.isSafeInteger(r.part)||r.part<0||r.room_bytes>128||r.domain_bytes>64||r.key_bytes>128||[r.room_bytes,r.domain_bytes,r.key_bytes].some(n=>!Number.isSafeInteger(n)||n<0)))fail();
 for(const scalar of scalars){const row=db.prepare('SELECT room_id,domain,unit_key,part FROM current_restore_audit_scratch WHERE rowid=? AND restore_id=? AND lane=\'report\'').get(scalar.rid,id);if(!row||!owned(row))fail();}
 withExactRestoreGuards(db,RESTORE_CONTROL_GUARDS.filter(([name])=>name==='current_restore_audit_scratch_delete'),()=>{
  for(const row of scalars){const result=db.prepare("DELETE FROM current_restore_audit_scratch WHERE rowid=? AND restore_id=? AND lane='report'").run(row.rid,id);if(result.changes!==1)fail();}
 });
 const next=remaining-scalars.length;verifyRecoveryReportScratch(db,id,next);return{removed:scalars.length,remaining:next};
}
