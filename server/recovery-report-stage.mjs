import {Buffer} from 'node:buffer';
import {applicationTables} from './writer-fence.mjs';
import {restoreProgress,inRestoreContext,withRestoreAuditRows,RESTORE_AUDIT_UNIT_BYTES} from './restore-admission.mjs';
import {captureRecoveryReportSnapshot,readRecoveryReportSnapshot} from './recovery-report-snapshot.mjs';
import {initialRecoveryReportRow,recoveryReportRowReader,recoveryReportRowid} from './recovery-report-source.mjs';
import {initialRecoveryReportTable,appendRecoveryReportChunk,sealRecoveryReportTable,advanceRecoveryReportTable,recoveryReportTableResult,initialRecoveryReportDigest,appendRecoveryReportDigest,finishRecoveryReportDigest} from './recovery-report-continuation.mjs';
const fail=()=>{throw Error('Recovery report stage requires reconciliation');};
export function validateRecoveryReportStage(p){
 if(!p||Object.keys(p).sort().join(',')!=='dataHash,dataSha256,results,rowAfter,scratchRows,snapshotHash,source,stage,table,tableIndex,version'||p.version!==1
  ||!['source','sort','complete'].includes(p.stage)||!/^[a-f0-9]{64}$/.test(p.snapshotHash??'')
   || ! Number . isSafeInteger ( p . scratchRows ) || p . scratchRows < 1 || ! Number . isInteger ( p . tableIndex ) || p . tableIndex < 0 || p . tableIndex > applicationTables . length || p . rowAfter !== null && typeof p . rowAfter !== 'string'
  ||!Array.isArray(p.results)||p.results.length!==p.tableIndex||p.results.some((v,i)=>v.table!==applicationTables[i]||!Number.isSafeInteger(v.rows)||v.rows<0||!/^[a-f0-9]{64}$/.test(v.sha256??''))
  ||Buffer.byteLength(JSON.stringify(p))>512*1024)fail();
 if(p.rowAfter!==null)recoveryReportRowid(p.rowAfter);
  if ( p . stage === 'complete' ) { if ( p . tableIndex !== applicationTables . length || p . table !== null || p . source !== null || p . dataSha256 !== finishRecoveryReportDigest ( p . dataHash ) ) fail ( ) ; }
 else if(p.tableIndex>=applicationTables.length||p.table?.table!==applicationTables[p.tableIndex]||p.dataSha256!==null
  ||(p.stage==='source'&&p.table.stage!=='ingest')||(p.stage==='sort'&&p.table.stage==='ingest')
  ||p.source!==null&&(p.stage!=='source'||p.source.table!==applicationTables[p.tableIndex]||(p.rowAfter!==null&&BigInt(p.source.rowid)<=BigInt(p.rowAfter))))fail();
}
// Fixed payload/output and work accounting; this confers no restore authority.
export function recoveryReportRequestBudget(){
  const limit=4*1024*1024,chunkStore=6*8192+128;let remaining=limit,work=16384;
  const budget={get remainingBytes(){return remaining;},get usedWork(){return 16384-work;},charge(bytes){if(!Number.isSafeInteger(bytes)||bytes<0||bytes>remaining)throw Error('Recovery report request payload budget exceeded');remaining-=bytes;},unit(){if(work<1)throw Error('Recovery report request work budget exceeded');work--;},
   canSourceUnit(){return work>0&&remaining>=2*(RESTORE_AUDIT_UNIT_BYTES+512)+16384+chunkStore+1024;},
   canSortUnit(){return work>0&&remaining>=5*(RESTORE_AUDIT_UNIT_BYTES+512)+2*chunkStore+1024;}};
  return budget;
}
// The existing restore entrypoint supplies its existing exact sealed-schema
// admission callback; it must not create a second, weaker source/freeze check.
// Caller commits returned cursor + scratch + normal CAS/request receipt in ONE
// privileged synchronous restore transaction, and returns latest receipts on ACK loss.
export function advanceRecoveryReport(store,restoreId,previous,{assertSealedSource}={}){
 const db=store.db;if(!db.isTransaction||!inRestoreContext(db)||typeof assertSealedSource!=='function')fail();
 const state=restoreProgress(db);if(state.state!=='pending'||state.phase!=='audit_pending'||state.restore_id!==restoreId)fail();assertSealedSource(state);
 return withRestoreAuditRows(db,restoreId,scratch=>{
  let p;
  if(previous===null){
   const capture=captureRecoveryReportSnapshot(db,scratch,state);
   p={version:1,stage:'source',snapshotHash:capture.digest,scratchRows:capture.rows,tableIndex:0,rowAfter:null,source:null,table:initialRecoveryReportTable(applicationTables[0]),results:[],dataHash:initialRecoveryReportDigest(),dataSha256:null};
   validateRecoveryReportStage(p);return p;
  }
  validateRecoveryReportStage(previous);p=structuredClone(previous);const snapshot=readRecoveryReportSnapshot(db,scratch,p.snapshotHash,state);
  // This is a logical report-payload/output budget, not the outer control and
  // schema admission cost. Each largest legal unit fits a fresh request.
  const budget=recoveryReportRequestBudget();let sourceRows=p.source?1:0;
  const ownerScratch=scratch;scratch={...ownerScratch,get remaining(){return ownerScratch.remaining;},get(...args){const value=ownerScratch.get(...args);budget.charge(Buffer.byteLength(JSON.stringify(value)??'null')+512);return value;},set(...args){budget.charge(Buffer.byteLength(JSON.stringify(args[4]))+512);return ownerScratch.set(...args);}};
  if(p.stage==='complete')return p;
  const readRow=recoveryReportRowReader(db,{snapshot,scratch,budget});
  let sourceBudget=16384,sortBudget=1024;
  for(let transitions=0;transitions<256&&p.stage!=='complete';transitions++){
  const name=applicationTables[p.tableIndex];
  if(p.stage==='sort'){
   if(sortBudget===0||!budget.canSortUnit())break;const sorted=advanceRecoveryReportTable(scratch,p.table,{maxUnits:sortBudget,budget});p.table=sorted.state;sortBudget-=sorted.units;if(sorted.units===0&&p.table.stage!=='complete')break;
   if(p.table.stage==='complete'){
    const result=recoveryReportTableResult(p.table),entry=state.seal.tables.find(t=>t.name===name),expected=name==='current_restore_audit_scratch'?0:name==='current_restore_admission'||name==='current_room_writer_permit'||name==='public_work_claim_writer_permit'?1:entry?.expected?.rows??0;if(result.rows!==expected)fail();if(result.rows>1)p.scratchRows+=result.rows;budget.charge(1024);p.results.push(result);p.dataHash=appendRecoveryReportDigest(p.dataHash,result,p.tableIndex===0);p.tableIndex++;p.rowAfter=null;p.source=null;
    if(p.tableIndex===applicationTables.length){p.table=null;p.stage='complete';p.dataSha256=finishRecoveryReportDigest(p.dataHash);}
    else{p.table=initialRecoveryReportTable(applicationTables[p.tableIndex]);p.stage='source';}
   }
  }else{
   if(scratch.remaining<2||!budget.canSourceUnit())break;
   if(p.source===null){
    if (sourceRows >= 64 || budget.remainingBytes < 65536 + 2 * (RESTORE_AUDIT_UNIT_BYTES + 512) + 16384 + (6 * 8192 + 128) + 1024) break;
    const next=name==='current_restore_audit_scratch'?undefined:name==='current_restore_admission'?(p.rowAfter===null?{__report_rid:'1'}:undefined):db.prepare(`SELECT CAST(rowid AS TEXT) AS __report_rid FROM "${name}"${p.rowAfter===null?'':' WHERE rowid>?'} ORDER BY rowid LIMIT 1`).get(...(p.rowAfter===null?[]:[p.rowAfter]));
    if(!next){p.table=sealRecoveryReportTable(p.table);p.stage='sort';continue;}
    recoveryReportRowid(next.__report_rid);
    // maxRowBytes is sealed from the actual original source. Only target-owned
    // control/permit rows may exist outside that list; others must be empty.
    const entry=state.seal.tables.find(t=>t.name===name),target=name==='current_restore_admission'||name==='current_room_writer_permit'||name==='public_work_claim_writer_permit';
    if(!entry&&!target)fail();const maximum=name==='current_restore_admission'?3*1024*1024:entry?.maxRowBytes??4096;
    budget.charge(65536);sourceRows++;p.source=initialRecoveryReportRow(db,name,next.__report_rid,maximum);
   }
   if(sourceBudget===0)break;const result=readRow(p.source,{maxUnits:sourceBudget});p.source=result.state;sourceBudget-=result.units;if(result.units===0&&result.chunk===null)break;
   if(result.chunk!==null){p.table=appendRecoveryReportChunk(scratch,p.table,result.chunk,result.last);p.scratchRows+=1+(result.last?1:0);}
   if(result.last){p.rowAfter=p.source.rowid;p.source=null;}
  }
  }
  validateRecoveryReportStage(p);return p;
 });
}
