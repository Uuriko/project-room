// Explicit operator continuation only: never uploads or begins a restore.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
const fail = code => { throw new Error('remote_restore_' + code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = n => Number.isSafeInteger(n) && n >= 0;
const endpoint = '/api/operator/restore';
export function continuationOrigin(value) {
  let url;try { url = new URL(value); } catch { fail('invalid_origin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol)
    || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('invalid_origin');
  return url.origin;
}
function privateFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) fail('private_checkpoint_required');
  return readFileSync(path, 'utf8');
}
function save(path, value) {
  if (existsSync(path)) privateFile(path);
  const temp = path + '.' + randomUUID() + '.tmp', fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, path); const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
function lock(path) {
  const name = path + '.lock';
  let fd;try { fd=openSync(name, 'wx', 0o600); } catch(error) { if(error.code==='EEXIST')fail('checkpoint_locked');throw error; }
  try { writeFileSync(fd, JSON.stringify({pid:process.pid,host:hostname()}));fsyncSync(fd); } finally { closeSync(fd); }
  // Never steal a stale lock: a second restart could otherwise remove a new
  // owner's lock between observation and unlink. Operator reconciliation is
  // explicit and preserves the durable request checkpoint.
  return () => unlinkSync(name);
}
function binding(value) {
  if (!value || typeof value.restoreId !== 'string' || !/^[-_a-zA-Z0-9]{1,128}$/.test(value.restoreId) || !/^[a-f0-9]{64}$/.test(value.sourceSeal)) fail('invalid_binding');
  return {restoreId:value.restoreId,sourceSeal:value.sourceSeal};
}
function sameBinding(a, b) { if (a.restoreId !== b.restoreId || a.sourceSeal !== b.sourceSeal) fail('changed_binding'); }
function next(receipt, bound) {
  if (receipt?.ok !== true) fail('invalid_receipt');
  if (receipt.pending === true && receipt.verified === false) {
    sameBinding(binding(receipt), bound);
    if (!integer(receipt.revision) || !['coverage', 'audit_pending'].includes(receipt.phase) || !['rows','bytes','tableIndex','tables'].every(key=>integer(receipt.progress?.[key]))
      || receipt.progress.tableIndex>receipt.progress.tables) fail('invalid_coverage');
    return {restoreId:bound.restoreId,sourceSeal:bound.sourceSeal,expectedRevision:receipt.revision,requestId:randomUUID()};
  }
  if (receipt.verified !== true || receipt.pending !== false) fail('invalid_receipt');
  if (receipt.cleanup) {
    if (!['revision','nextIndex','total','removed','remaining','verifiedGuardCount'].every(key => integer(receipt.cleanup[key]))
      || receipt.cleanup.nextIndex + receipt.cleanup.remaining !== receipt.cleanup.total
      || receipt.cleanup.verifiedGuardCount !== receipt.cleanup.remaining) fail('invalid_cleanup_progress');
    const keys=['scratchTotal','scratchRemaining','scratchRemoved'],present=keys.filter(key=>Object.hasOwn(receipt.cleanup,key));
    if(present.length&&(present.length!==3||!keys.every(key=>integer(receipt.cleanup[key]))||receipt.cleanup.scratchRemaining>receipt.cleanup.scratchTotal||receipt.cleanup.scratchRemoved>128))fail('invalid_scratch_progress');
  }
  if (receipt.cleanupComplete === true) {
    sameBinding(binding(receipt), bound);
    if (receipt.nextCleanup !== null || receipt.cleanup?.remaining !== 0 || receipt.cleanup?.verifiedGuardCount !== 0 || receipt.cleanup?.scratchRemaining !== undefined && receipt.cleanup.scratchRemaining !== 0) fail('missing_zero_proof');
    return null;
  }
  const hint = receipt.nextCleanup, body = hint?.body;
  if (receipt.cleanupComplete !== false || hint?.method !== 'POST' || hint.path !== endpoint
    || !body || Object.keys(body).sort().join(',') !== 'cleanup,expectedRevision,requestId,restoreId,sourceSeal'
    || body.cleanup !== true || !integer(body.expectedRevision) || typeof body.requestId !== 'string' || !/^[-_a-zA-Z0-9]{1,128}$/.test(body.requestId)) fail('invalid_cleanup_hint');
  sameBinding(binding(body), bound);
  if (receipt.cleanup) sameBinding(binding(receipt), bound);
  return body;
}
function progress(receipt) {
  return hash(JSON.stringify(receipt.pending ? {phase:receipt.phase,progress:receipt.progress,audit:receipt.auditProgress} : {verified:receipt.verified,cleanup:receipt.cleanup,complete:receipt.cleanupComplete}));
}
async function responseJson(response) {
  if (![200, 202].includes(response.status) || response.redirected) fail('http_refused');
  const reader=response.body?.getReader();if(!reader)fail('invalid_response');
  const chunks=[];let bytes=0;
  for (;;) { const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();fail('response_too_large');}chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_response'); }
}
export async function continueRemoteRestore({receiptFile, origin, checkpointFile, runMs=900000, fetchImpl=fetch}) {
  origin=continuationOrigin(origin);if(!integer(runMs)||runMs<1||runMs>900000)fail('invalid_run_budget');
  const token=process.env.ROOM_RESTORE_TOKEN;if(typeof token!=='string'||token.length<16)fail('token_required');
  if(resolve(receiptFile)===resolve(checkpointFile))fail('invalid_checkpoint_path');
  const initialText=readFileSync(receiptFile,'utf8');if(Buffer.byteLength(initialText)>1048576)fail('receipt_too_large');
  let initial;try{initial=JSON.parse(initialText);}catch{fail('invalid_receipt');}
  const initialBinding=binding(initial.pending?initial:initial.nextCleanup?.body??initial);
  next(initial,initialBinding);
  const path=resolve(checkpointFile), parent=dirname(path);mkdirSync(parent,{recursive:true,mode:0o700});
  const parentInfo=lstatSync(parent);if(!parentInfo.isDirectory()||parentInfo.uid!==process.getuid()||(parentInfo.mode&0o022))fail('private_directory_required');
  const unlock=lock(path), deadline=Date.now()+runMs;
  try {
    let state;
    if(existsSync(path)){try{state=JSON.parse(privateFile(path));}catch{fail('invalid_checkpoint');}
      if(state.version!==1||state.origin!==origin||state.initialHash!==hash(initialText))fail('checkpoint_binding');sameBinding(binding(state.binding),initialBinding);if(!integer(state.requests))fail('invalid_checkpoint');
    }else{state={version:1,origin,initialHash:hash(initialText),binding:initialBinding,receipt:initial,pending:null,requests:0};save(path,state);}
    for(;;){
      const planned=next(state.receipt,state.binding);
      if(!planned)return{status:'complete',verified:true,requests:state.requests,cleanupRemaining:0};
      if(Date.now()>=deadline)return{status:'pending',verified:state.receipt.verified===true,requests:state.requests,cleanupRemaining:state.receipt.cleanup?.remaining??null};
      if(!state.pending){state.pending={body:JSON.stringify(planned)};state.requests++;save(path,state);}
      let request;try{request=JSON.parse(state.pending.body);}catch{fail('invalid_checkpoint');}
      sameBinding(binding(request),state.binding);
      const keys = request.cleanup ? 'cleanup,expectedRevision,requestId,restoreId,sourceSeal' : 'expectedRevision,requestId,restoreId,sourceSeal';
      if(Object.keys(request).sort().join(',')!==keys || !/^[-_a-zA-Z0-9]{1,128}$/.test(request.requestId??'')
        || request.cleanup && request.requestId!==planned.requestId)fail('checkpoint_request');
      if(request.expectedRevision!==planned.expectedRevision || Boolean(request.cleanup)!==Boolean(planned.cleanup))fail('checkpoint_request');
      let response;try{response=await fetchImpl(origin+endpoint,{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:state.pending.body,signal:AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now())))});}catch{fail('transport_interrupted');}
      const receipt=await responseJson(response), following=next(receipt,state.binding);
      const expectedStatus=receipt.pending||request.cleanup&&receipt.cleanupComplete===false?202:200;
      if(response.status!==expectedStatus)fail('invalid_response_status');
      if(receipt.pending){
        if(request.cleanup||receipt.revision!==request.expectedRevision+1)fail('invalid_revision');
        if(['rows','bytes','tableIndex'].some(key=>receipt.progress[key]<state.receipt.progress[key])
          || receipt.progress.tables!==state.receipt.progress.tables
          || state.receipt.phase==='audit_pending'&&receipt.phase!=='audit_pending')fail('no_progress');
      }
      else if(request.cleanup){
        const prior=state.receipt.cleanup;
        if(!integer(receipt.cleanup?.revision)||receipt.cleanup.revision!==request.expectedRevision+1)fail('invalid_revision');
        if(receipt.cleanup.removed+(receipt.cleanup.scratchRemoved??0)<1||receipt.cleanup.nextIndex!==(prior?.nextIndex??0)+receipt.cleanup.removed
          || prior&&receipt.cleanup.total!==prior.total)fail('no_progress');
        const scratch=receipt.cleanup.scratchRemaining!==undefined,hadScratch=prior?.scratchRemaining!==undefined;
        if(prior&&scratch!==hadScratch)fail('invalid_scratch_progress');
        if(scratch&&(receipt.cleanup.scratchRemaining+receipt.cleanup.scratchRemoved!==(hadScratch?prior.scratchRemaining:receipt.cleanup.scratchTotal)||hadScratch&&receipt.cleanup.scratchTotal!==prior.scratchTotal))fail('invalid_scratch_progress');
      }
      else if(following?.cleanup && following.expectedRevision!==0)fail('invalid_revision');
      if(following&&progress(receipt)===progress(state.receipt))fail('no_progress');
      if(request.cleanup&&following&&(!integer(receipt.cleanup?.remaining)||!integer(state.receipt.cleanup?.remaining)&&request.expectedRevision!==0||receipt.cleanup.remaining>=(state.receipt.cleanup?.remaining??Infinity)&&!(receipt.cleanup.scratchRemaining!==undefined&&receipt.cleanup.scratchRemaining<(state.receipt.cleanup?.scratchRemaining??Infinity))))fail('no_progress');
      state={...state,receipt,pending:null};save(path,state);
    }
  } finally { unlock(); }
}
