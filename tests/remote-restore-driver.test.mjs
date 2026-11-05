import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {continuationOrigin} from '../scripts/restore-remote-continuation.mjs';
const exec=promisify(execFile),script=fileURLToPath(new URL('../scripts/restore-room-backup.mjs',import.meta.url));
const token='synthetic-remote-continuation-only',binding={restoreId:'synthetic_restore',sourceSeal:'a'.repeat(64)};
const initial={ok:true,verified:false,pending:true,...binding,revision:1,phase:'coverage',progress:{rows:0,bytes:0,tableIndex:0,tables:1},auditProgress:null};
const coverage={...initial,revision:2,progress:{...initial.progress,rows:1,bytes:10}};
const hint=revision=>({method:'POST',path:'/api/operator/restore',body:{cleanup:true,requestId:'cleanup_'+revision,expectedRevision:revision,...binding}});
const publication={ok:true,verified:true,pending:false,cleanupComplete:false,nextCleanup:hint(0)};
function cleaned(final){return{ok:true,verified:true,pending:false,...binding,cleanupComplete:final,cleanup:{revision:final?2:1,nextIndex:final?16:15,total:16,removed:final?1:15,remaining:final?0:1,verifiedGuardCount:final?0:1},nextCleanup:final?null:hint(1)};}
async function setup(t,handle){
 const dir=mkdtempSync(join(tmpdir(),'remote-restore-driver-'));const receipt=join(dir,'receipt.json'),checkpoint=join(dir,'checkpoint.json');writeFileSync(receipt,JSON.stringify(initial),{mode:0o600});
 const posts=[],server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{assert.equal(req.url,'/api/operator/restore');assert.equal(req.headers.authorization,'Bearer '+token);assert.equal(req.method,'POST');assert.equal(JSON.parse(readFileSync(checkpoint,'utf8')).pending.body,body,'request durable before send');posts.push(body);handle({req,res,body,input:JSON.parse(body),posts,checkpoint});});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 const args=['--continue-receipt',receipt,'--origin',origin,'--checkpoint',checkpoint];
 const run=async extra=>{try{const result=await exec(process.execPath,[script,...args,...(extra??[])],{env:{...process.env,ROOM_RESTORE_TOKEN:token},timeout:30000});return{code:0,...result};}catch(error){return{code:error.code,stdout:error.stdout,stderr:error.stderr};}};
 return{run,posts,checkpoint,args,receipt,origin};
}
const send=(res,body)=>{res.writeHead(body.pending||!body.cleanupComplete&&body.cleanup?202:200,{'content-type':'application/json'});res.end(JSON.stringify(body));};
test('lost ACK restarts exact request, then finishes coverage and cleanup zero proof',async t=>{
 let lost=false;const f=await setup(t,({res,req,input})=>{if(input.expectedRevision===1&&!input.cleanup){if(!lost){lost=true;req.socket.destroy();return;}return send(res,coverage);}if(!input.cleanup)return send(res,publication);send(res,cleaned(input.expectedRevision===1));});
 const failed=await f.run();assert.equal(failed.code,1);const saved=readFileSync(f.checkpoint,'utf8');assert.equal(JSON.parse(saved).pending.body,f.posts[0]);assert.equal(statSync(f.checkpoint).mode&0o777,0o600);
 const done=await f.run();assert.equal(done.code,0,done.stderr);assert.equal(JSON.parse(done.stdout).status,'complete');assert.equal(f.posts[0],f.posts[1]);assert.equal(f.posts.length,5);
 assert.doesNotMatch(saved+failed.stderr+done.stdout,new RegExp(token));assert.doesNotMatch(done.stdout,/sourceSeal|restoreId|requestId|Bearer/);
});
test('redirect is refused without sending authorization to another endpoint',async t=>{
 let leaked=0;const other=createServer((_req,res)=>{leaked++;res.end('{}');});await new Promise(r=>other.listen(0,'127.0.0.1',r));t.after(()=>other.close());
 const f=await setup(t,({res})=>{res.writeHead(307,{location:'http://127.0.0.1:'+other.address().port+'/stolen'});res.end();});
 assert.equal((await f.run()).code,1);assert.equal(leaked,0);assert.equal(f.posts.length,1);assert.ok(JSON.parse(readFileSync(f.checkpoint,'utf8')).pending);
});
test('changed binding and revision-only progress preserve the pending exact request',async t=>{
 let wrong=true;const f=await setup(t,({res})=>send(res,wrong?{...coverage,sourceSeal:'b'.repeat(64)}:{...initial,revision:2}));
 assert.equal((await f.run()).code,1);wrong=false;const stopped=await f.run();assert.equal(stopped.code,1);assert.match(stopped.stderr,/no_progress/);assert.equal(f.posts[0],f.posts[1]);
});
test('response-supplied cleanup URL cannot change the fixed endpoint',async t=>{
 const f=await setup(t,({res})=>send(res,{...publication,nextCleanup:{...hint(0),path:'https://elsewhere.example/steal'}}));assert.equal((await f.run()).code,1);assert.equal(f.posts.length,1);
});
test('explicit origins reject remote HTTP, credentials, path, query and fragment',()=>{
 for(const origin of['http://room.example','https://u:p@room.example','https://room.example/path','https://room.example?x=1','https://room.example#x'])assert.throws(()=>continuationOrigin(origin));
 assert.equal(continuationOrigin('https://room.example/'),'https://room.example');assert.equal(continuationOrigin('http://[::1]:8000'),'http://[::1]:8000');
});
test('remote mode refuses local restore options',async()=>{
 await assert.rejects(exec(process.execPath,[script,'--continue-receipt','unused','--origin','https://room.example','--checkpoint','unused','--to','must-not-create'],{env:{...process.env,ROOM_RESTORE_TOKEN:token}}),error=>error.code===1&&/remote_restore_invalid_options/.test(error.stderr));
});

test('process death blocks simultaneous restarts until explicit lock reconciliation',async t=>{
 let first=true;
 const f=await setup(t,({res,input})=>{
   if(first){first=false;child.kill('SIGKILL');res.destroy();return;}
   if(!input.cleanup)return send(res,input.expectedRevision===1?coverage:publication);
   send(res,cleaned(input.expectedRevision===1));
 });
 const child=execFile(process.execPath,[script,...f.args],{env:{...process.env,ROOM_RESTORE_TOKEN:token}},()=>{});
 const signal=await new Promise(resolve=>child.once('exit',(_code,signal)=>resolve(signal)));
 assert.equal(signal,'SIGKILL');assert.equal(JSON.parse(readFileSync(f.checkpoint,'utf8')).pending.body,f.posts[0]);
 const lockBefore=readFileSync(f.checkpoint+'.lock','utf8');const blocked=await Promise.all([f.run(),f.run()]);
 assert.ok(blocked.every(r=>r.code===1&&/checkpoint_locked/.test(r.stderr)));assert.equal(f.posts.length,1);
 assert.equal(readFileSync(f.checkpoint+'.lock','utf8'),lockBefore);
 // Explicit operator reconciliation after the owner exited and both other drivers stopped.
 unlinkSync(f.checkpoint+'.lock');
 const result=await f.run();assert.equal(result.code,0,result.stderr);assert.equal(f.posts[0],f.posts[1]);
});

test('pending HTTP200 and a false cleanup zero proof cannot complete',async t=>{
 let mode='status';const f=await setup(t,({res})=>{
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify(mode==='status'?coverage:{...cleaned(true),cleanup:{...cleaned(true).cleanup,verifiedGuardCount:1}}));
 });
 let result=await f.run();assert.equal(result.code,1);assert.match(result.stderr,/invalid_response_status/);
 mode='zero';result=await f.run();assert.equal(result.code,1);assert.match(result.stderr,/invalid_cleanup_progress|missing_zero_proof/);
 assert.equal(f.posts[0],f.posts[1]);
});
for(const at of [0,1])test(`cleanup batch ${at} lost ACK resumes latest checkpoint instead of publication rev0`,async t=>{
 let lost=false;const replies=new Map();
 const f=await setup(t,({req,res,input,body})=>{
   let reply=replies.get(input.requestId);
   if(!reply){reply=input.cleanup?cleaned(input.expectedRevision===1):input.expectedRevision===1?coverage:publication;replies.set(input.requestId,reply);}
   if(input.cleanup&&input.expectedRevision===at&&!lost){lost=true;req.socket.destroy();return;}
   send(res,reply);
 });
 assert.equal((await f.run()).code,1);
 const pending=JSON.parse(readFileSync(f.checkpoint,'utf8')).pending.body;
 assert.equal(JSON.parse(pending).expectedRevision,at);assert.equal(JSON.parse(pending).cleanup,true);
 const count=f.posts.length;const done=await f.run();assert.equal(done.code,0,done.stderr);assert.equal(f.posts[count],pending);
});
test('more than400 progressing receipts complete without a fixed step cap',async t=>{
 const f=await setup(t,({res,input})=>{
   if(input.cleanup)return send(res,cleaned(input.expectedRevision===1));
   if(input.expectedRevision>501)return send(res,publication);
   const revision=input.expectedRevision+1;send(res,{...coverage,revision,progress:{...coverage.progress,rows:revision-1,bytes:(revision-1)*10}});
 });
 const result=await f.run();assert.equal(result.code,0,result.stderr);assert.ok(JSON.parse(result.stdout).requests>500);
});
function workspace(revision){const scratchRemaining=revision===1?172:revision===2?44:0,complete=revision===3;return{ok:true,verified:true,pending:false,...binding,cleanupComplete:complete,cleanup:{revision,nextIndex:1,total:1,removed:revision===1?1:0,remaining:0,verifiedGuardCount:0,scratchTotal:300,scratchRemaining,scratchRemoved:revision===3?44:128},nextCleanup:complete?null:hint(revision)};}
test('workspace-only maintenance keeps exact lost-ACK request and requires both independent zero proofs',async t=>{
 let lost=false;const f=await setup(t,({req,res,input})=>{if(!input.cleanup)return send(res,input.expectedRevision===1?coverage:publication);const receipt=workspace(input.expectedRevision+1);if(input.expectedRevision===1&&!lost){lost=true;req.socket.destroy();return;}send(res,receipt);});
 assert.equal((await f.run()).code,1);const pending=JSON.parse(readFileSync(f.checkpoint,'utf8')).pending.body;assert.equal(JSON.parse(pending).expectedRevision,1);const count=f.posts.length;const done=await f.run();assert.equal(done.code,0,done.stderr);assert.equal(f.posts[count],pending);const final=JSON.parse(readFileSync(f.checkpoint,'utf8')).receipt;assert.equal(final.cleanup.verifiedGuardCount,0);assert.equal(final.cleanup.scratchRemaining,0);
});
for(const defect of ['partial','no-progress','inconsistent','false-zero'])test('workspace driver refuses '+defect+' reply without accepting a new checkpoint',async t=>{
 const f=await setup(t,({res,input})=>{if(!input.cleanup)return send(res,input.expectedRevision===1?coverage:publication);let receipt=workspace(1);
  if(defect==='partial')delete receipt.cleanup.scratchTotal;
  if(defect==='no-progress')Object.assign(receipt.cleanup,{nextIndex:0,remaining:1,verifiedGuardCount:1,removed:0,scratchRemaining:300,scratchRemoved:0});
  if(defect==='inconsistent')receipt.cleanup.scratchRemaining=170;
  if(defect==='false-zero'){receipt.cleanupComplete=true;receipt.nextCleanup=null;Object.assign(receipt.cleanup,{scratchTotal:1,scratchRemaining:1,scratchRemoved:0});}
  send(res,receipt);
 });
 const result=await f.run();assert.equal(result.code,1);assert.match(result.stderr,/invalid_scratch_progress|no_progress|missing_zero_proof/);assert.equal(JSON.parse(readFileSync(f.checkpoint,'utf8')).pending.body,f.posts.at(-1));
});
