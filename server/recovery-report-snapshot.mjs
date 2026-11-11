import {Buffer} from 'node:buffer';
import {applicationTables} from './writer-fence.mjs';
import {inRestoreContext,verifyRestoreControl} from './restore-admission.mjs';
import {initialReplayHash,advanceReplayHash,finishReplayHash} from './replay-sha256.mjs';
const fail=()=>{throw Error('Recovery report audit-instant snapshot requires reconciliation');};
const fields=['source_seal','coverage','latest_receipt'];
const PART=65536,MAX=1024*1024;
const hash=bytes=>{let p=initialReplayHash();for(let i=0;i<bytes.length;i+=PART)p=advanceReplayHash(p,bytes.subarray(i,i+PART));return finishReplayHash(p);};
const headerHash=h=>hash(Buffer.from(JSON.stringify(h)));
const get=(s,key,part=0)=>s.get('report','','fingerprint-snapshot',key,part);
function permits(db){
 const current=db.prepare('SELECT * FROM current_room_writer_permit').all(),claims=db.prepare('SELECT * FROM public_work_claim_writer_permit').all();
 if(current.length!==1||claims.length!==1||current[0].enabled!==0||current[0].room_id!==null||current[0].receipt_id!==null||claims[0].enabled!==0)fail();
 return{current,claims};
}
export function captureRecoveryReportSnapshot(db,scratch,state){
 if(!db.isTransaction||!inRestoreContext(db))fail();verifyRestoreControl(db);
 if(state.state!=='pending'||state.phase!=='audit_pending'||state.progress?.audit?.stage!=='full_audit_pending'||!state.seal?.id)fail();
 if(db.prepare('SELECT 1 FROM current_restore_audit_scratch LIMIT 1').get())fail();
 const scalar=db.prepare('SELECT singleton,state,restore_id,phase,revision,length(CAST(source_seal AS BLOB)) source_seal_bytes,length(CAST(coverage AS BLOB)) coverage_bytes,length(CAST(latest_receipt AS BLOB)) latest_receipt_bytes FROM current_restore_admission WHERE singleton=1').get();
 if(!scalar||scalar.state!=='pending'||scalar.phase!=='audit_pending'||scalar.restore_id!==state.restore_id||scalar.revision!==state.revision||Buffer.byteLength(scalar.restore_id)>128)fail();
 for(const field of fields)if(scalar[field+'_bytes']!==null&&(!Number.isSafeInteger(scalar[field+'_bytes'])||scalar[field+'_bytes']<0||scalar[field+'_bytes']>MAX))fail();
 // Exact SQL text comparison, not parsed JSON equality. Parameters come ONLY
 // from the caller's already authenticated restoreProgress read in this TX.
 if(!db.prepare('SELECT 1 ok FROM current_restore_admission WHERE singleton=1 AND source_seal IS ? AND coverage IS ? AND latest_receipt IS ?').get(state.source_seal,state.coverage,state.latest_receipt))fail();
 const h={version:1,restoreId:state.restore_id,sourceSeal:state.seal.id,revision:state.revision,inventory:[...applicationTables],schemaHash:state.seal.schemaHash,
  control:{singleton:scalar.singleton,state:scalar.state,restore_id:scalar.restore_id,phase:scalar.phase,revision:scalar.revision},fields:{},permits:permits(db)};
 const required=1+fields.reduce((n,f)=>n+Math.ceil((scalar[f+'_bytes']??0)/PART),0);if(scratch.remaining<required)fail();
 for(const field of fields){
  const bytes=scalar[field+'_bytes'];if(bytes===null){h.fields[field]={kind:'null'};continue;}
  const info={kind:'text',bytes,parts:[]};let whole=initialReplayHash();
  for(let offset=0;offset<bytes;offset+=PART){
   const count=Math.min(PART,bytes-offset),hex=db.prepare(`SELECT hex(substr(CAST(${field} AS BLOB),?,?)) value FROM current_restore_admission WHERE singleton=1`).get(offset+1,count)?.value;
   if(typeof hex!=='string'||hex.length!==2*count||!/^[0-9A-F]*$/.test(hex))fail();const data=Buffer.from(hex,'hex');whole=advanceReplayHash(whole,data);info.parts.push(hash(data));scratch.put('report','','fingerprint-snapshot',field,data.toString('base64'),info.parts.length);
  }
  info.sha256=finishReplayHash(whole);h.fields[field]=info;
 }
 const digest=headerHash(h);scratch.put('report','','fingerprint-snapshot','header',h);return {digest,rows:required};
}
export function readRecoveryReportSnapshot(db,scratch,digest,state){
 if(!db.isTransaction||!inRestoreContext(db)||!/^[a-f0-9]{64}$/.test(digest??''))fail();verifyRestoreControl(db);
 const h=get(scratch,'header');if(!h||h.version!==1||headerHash(h)!==digest||h.restoreId!==state.restore_id||h.sourceSeal!==state.seal?.id||h.schemaHash!==state.seal?.schemaHash||state.state!=='pending'||state.phase!=='audit_pending'||state.revision<h.revision
  ||JSON.stringify(h.inventory)!==JSON.stringify(applicationTables)||JSON.stringify(h.permits)!==JSON.stringify(permits(db)))fail();
 return h;
}
function part(scratch,h,field,index,cache){
 const cacheKey=field+':'+index;if(cache?.has(cacheKey))return cache.get(cacheKey);
 const info=h.fields[field];if(info?.kind!=='text'||!Number.isInteger(index)||index<0||index>=info.parts.length)fail();
 const encoded=get(scratch,field,index+1);if(typeof encoded!=='string'||encoded.length>4*Math.ceil(PART/3))fail();const data=Buffer.from(encoded,'base64');
 if(data.toString('base64')!==encoded||data.length!==Math.min(PART,info.bytes-index*PART)||hash(data)!==info.parts[index])fail();if(cache){if(cache.size===2)cache.delete(cache.keys().next().value);cache.set(cacheKey,data);}return data;
}
// Tiny scalar fields and all NULLs retain their SQL type. Text parts remain
// raw UTF-8; source quoting occurs in the same streaming encoder as live cells.
export function reportSnapshotCellInfo(h,column){
 if(Object.hasOwn(h.control,column)){const value=h.control[column];return{kind:typeof value==='number'?'integer':'text',bytes:typeof value==='string'?Buffer.byteLength(value):Buffer.byteLength(String(value))};}
 const info=h.fields[column];if(!info)fail();return{kind:info.kind,bytes:info.kind==='null'?null:info.bytes};
}
export function reportSnapshotCellValue(h,column){if(!Object.hasOwn(h.control,column))fail();return h.control[column];}
export function reportSnapshotCellBytes(scratch,h,column,offset,count,cache){
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(count)||count<0||count>2048)fail();
 if(Object.hasOwn(h.control,column))return Buffer.from(String(h.control[column])).subarray(offset,offset+count).toString('hex').toUpperCase();
 const info=h.fields[column];if(info?.kind!=='text'||offset+count>info.bytes)fail();let out=Buffer.alloc(count),written=0;
 while(written<count){const index=Math.floor((offset+written)/PART),start=(offset+written)%PART,data=part(scratch,h,column,index,cache),take=Math.min(count-written,data.length-start);if(take<1)fail();out.set(data.subarray(start,start+take),written);written+=take;}
 return out.toString('hex').toUpperCase();
}

export function verifyRecoveryReportSnapshotParts(scratch,h){
 for(const field of fields){const info=h.fields[field];if(info?.kind==='null')continue;
  if(info?.kind!=='text'||!Number.isSafeInteger(info.bytes)||info.bytes<0||info.bytes>MAX||!Array.isArray(info.parts)||info.parts.length!==Math.ceil(info.bytes/PART))fail();
  let whole=initialReplayHash();for(let i=0;i<info.parts.length;i++)whole=advanceReplayHash(whole,part(scratch,h,field,i));
  if(finishReplayHash(whole)!==info.sha256)fail();
 }
}
