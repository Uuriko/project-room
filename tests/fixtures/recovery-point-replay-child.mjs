import {readFileSync} from 'node:fs';
import {RoomStore} from '../../server/store.mjs';
import {restoreProgress,checkpointRestore,withRestoreTransaction,withRestoreAuditRows} from '../../server/restore-admission.mjs';
import {applyRecoveryReplayStep} from '../../server/recovery-replay-step.mjs';
import {planRecoveryReplayValue,writeRecoveryReplayValue,readRecoveryReplayValue} from '../../server/recovery-replay-value.mjs';
const [filename,eventsFile,mode]=process.argv.slice(2),events=JSON.parse(readFileSync(eventsFile,'utf8')),store=new RoomStore(filename),maximum=1024*1024;
// Executable synthetic composition fixture. This does not bind a production
// source seal or replace the still-required independent recovery oracle.
withRestoreTransaction(store,()=>{
 const before=restoreProgress(store.db),sequence=before.progress.replay,counts=before.progress.counts;
 withRestoreAuditRows(store.db,before.restore_id,scratch=>{
  const result=applyRecoveryReplayStep((domain,key)=>readRecoveryReplayValue(scratch,'commons',domain,key,maximum),events[sequence],counts);if(!result.supported)throw Error('Unqualified replay plan');
  const plans=result.patches.map(patch=>({...patch,plan:planRecoveryReplayValue(patch.value,maximum)}));if(plans.reduce((n,p)=>n+p.plan.rows,0)>scratch.remaining)throw Error('Fixture atom exceeds scratch row admission');
  for(const patch of plans)if(!writeRecoveryReplayValue(scratch,'commons',patch.domain,patch.key,patch.plan))throw Error('Fixture partial atom');
  checkpointRestore(store.db,{restoreId:before.restore_id,expectedRevision:before.revision,phase:'audit_pending',seal:before.seal,progress:{replay:sequence+1,counts:result.counts},latest:{requestId:'replay_'+sequence}});
 });
 if(mode==='before-commit')process.exit(77);
});
const after=restoreProgress(store.db);process.stdout.write(JSON.stringify({revision:after.revision,replay:after.progress.replay,receipt:after.latest})+'\n');process.exit(77);
