import {restoreProgress,inRestoreContext,withRestoreAuditRows} from './restore-admission.mjs';
import {validateRecoveryReportStage} from './recovery-report-stage.mjs';
import {readRecoveryReportSnapshot,verifyRecoveryReportSnapshotParts} from './recovery-report-snapshot.mjs';
const scopes=new WeakMap();
const fail=()=>{throw Error('Recovery report fingerprint scope requires reconciliation');};
function authority(store,scope,verifyParts=false){
 const db=store.db;if(!db.isTransaction||!inRestoreContext(db))fail();
 const state=restoreProgress(db);scope.assertSealedSource(state);
 if(state.restore_id!==scope.restoreId||state.revision!==scope.revision||state.coverage!==scope.coverage||state.latest_receipt!==scope.latest||state.source_seal!==scope.sourceSeal)fail();
 const report=state.progress?.audit?.report;validateRecoveryReportStage(report);if(report.stage!=='complete'||JSON.stringify(report)!==scope.cursor)fail();
 withRestoreAuditRows(db,scope.restoreId,scratch=>{const snapshot=readRecoveryReportSnapshot(db,scratch,report.snapshotHash,state);if(verifyParts)verifyRecoveryReportSnapshotParts(scratch,snapshot);});
 return report;
}
// No caller-provided fingerprint/skip option exists. This scope admits ONLY
// the existing target's protected completed checkpoint in its restore TX.
export function withRecoveryReportFingerprint(store,restoreId,{assertSealedSource},operation){
 if(typeof assertSealedSource!=='function'||typeof operation!=='function'||scopes.has(store.db))fail();
 const state=restoreProgress(store.db),report=state.progress?.audit?.report;validateRecoveryReportStage(report);
 const scope={restoreId,revision:state.revision,coverage:state.coverage,latest:state.latest_receipt,sourceSeal:state.source_seal,cursor:JSON.stringify(report),assertSealedSource};authority(store,scope,true);
 scopes.set(store.db,scope);try{const value=operation();if(value?.then)fail();authority(store,scope);return value;}finally{scopes.delete(store.db);}
}
export function recoveryReportFingerprint(store){
 const scope=scopes.get(store.db);if(!scope)return null;const report=authority(store,scope);
 return {tables:report.results,dataSha256:report.dataSha256,scope:{version:1,basis:'restore-audit-instant',snapshotSha256:report.snapshotHash,restoreId:scope.restoreId}};
}
