// Finite local contract qualification; no production entrypoint changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),sha=body=>createHash('sha256').update(body).digest('hex');
const token=['synthetic','native','driver','restore','only'].join('-');
const exporter=['synthetic','native','driver','export','only'].join('-');
assert.equal(token,'synthetic-native-driver-restore-only');
assert.equal(exporter,'synthetic-native-driver-export-only');
const root=fileURLToPath(new URL('..',import.meta.url));
async function bundle(seed){
 const path=join(root,'cloudflare',seed?'durable-coverage-seed.test-fixture.mjs':'durable-coverage-native.test-fixture.mjs');
 const options={bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']};
 if(!seed)return(await build({...options,entryPoints:[path]})).outputFiles[0].text;
 const original=await readFile(path,'utf8');assert.match(original,/n<1000/);
 return(await build({...options,stdin:{contents:original.replace('n<1000','n<32').replace('count:1000','count:32'),resolveDir:join(root,'cloudflare'),sourcefile:'small-existing-seed.mjs'}})).outputFiles[0].text;
}
test('actual CLI resumes sealed Native coverage, loses cleanup ACK, cold-restarts and proves zero guards',{timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'remote-native-contract-')),receiptFile=join(directory,'receipt.json'),checkpointFile=join(directory,'checkpoint.json');
 let script=await bundle(true),mf;const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(directory,'durable'),durableObjects:{ROOM:{className:'DurableCoverageRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_RESTORE_TOKEN:token,ROOM_EXPORT_TOKEN:exporter},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});mf=create();
 const call=(surface,path,options={})=>mf.dispatchFetch('https://room.example.test'+path+(path.includes('?')?'&':'?')+'surface='+surface,{...options,headers:{Host:'room.example.test',...Object.fromEntries(new Headers(options.headers))}});
 const json=async(surface,path,status=200,options)=>{const response=await call(surface,path,options),text=await response.text();assert.equal(response.status,status,path+' '+text);return JSON.parse(text);};
 let bridge,lost=null,lostResponse=null,publication=null,postCount=0;const observations=[];
 try{
  assert.equal((await json('source','/__seed-history')).count,32);
  const work=await json('source','/__work'),saved=await json('source','/post?id=saved'),{key}=await json('source','/__key');assert.equal(JSON.parse(work.capacity.payload).open,true);
  const backup=await call('source','/__export'),text=await backup.text();assert.equal(backup.status,200);
  const partial=await json('target','/__partial',200,{method:'POST',body:text});assert.equal(partial.pending,true);
  await mf.dispose();script=await bundle(false);mf=create();await json('target','/api/ready',503);
  const initial=await json('target','/api/operator/restore?resume=1',202,{method:'POST',headers:{Authorization:'Bearer '+token},body:text});assert.equal(initial.phase,'coverage');
  await writeFile(receiptFile,JSON.stringify(initial),{mode:0o600});
  bridge=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{(async()=>{
   assert.equal(req.url,'/api/operator/restore');assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer '+token);
   const checkpoint=JSON.parse(await readFile(checkpointFile,'utf8'));assert.equal(checkpoint.pending.body,body);
   const input=JSON.parse(body),response=await call('target','/api/operator/restore',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body}),responseText=await response.text();postCount++;
   const receipt=JSON.parse(responseText);observations.push({cleanup:input.cleanup===true,status:response.status,phase:receipt.phase??null,stage:receipt.auditProgress?.stage??null,revision:receipt.revision??receipt.cleanup?.revision??null,remaining:receipt.cleanup?.remaining??null});
   if(!input.cleanup&&receipt.verified)publication={input,result:receipt};
   if(input.cleanup&&input.expectedRevision===0&&!lost){assert.equal(response.status,202);lost=body;lostResponse=responseText;req.socket.destroy();return;}
   if(input.cleanup&&input.expectedRevision===0){assert.equal(body,lost);assert.equal(responseText,lostResponse);}
   res.writeHead(response.status,{'content-type':'application/json'});res.end(responseText);
  })().catch(error=>{res.writeHead(500);res.end(JSON.stringify({error:'local qualification failed'}));observations.push({qualificationError:error.message});});});});
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  const args=[join(root,'scripts/restore-room-backup.mjs'),'--continue-receipt',receiptFile,'--origin','http://127.0.0.1:'+bridge.address().port,'--checkpoint',checkpointFile];
  const run=async()=>{try{return{code:0,...await exec(process.execPath,args,{env:{...process.env,ROOM_RESTORE_TOKEN:token},timeout:90000})};}catch(error){return{code:error.code,stdout:error.stdout,stderr:error.stderr};}};
  const interrupted=await run();assert.equal(interrupted.code,1,JSON.stringify({interrupted,last:observations.slice(-3)}));assert.match(interrupted.stderr,/transport_interrupted/);assert.ok(lost);
  assert.equal(JSON.parse(await readFile(checkpointFile,'utf8')).pending.body,lost);
  await mf.dispose();mf=create();await json('target','/api/ready');
  const finished=await run();assert.equal(finished.code,0,JSON.stringify({finished,last:observations.slice(-3)}));assert.equal(JSON.parse(finished.stdout).status,'complete');
  const final=JSON.parse(await readFile(checkpointFile,'utf8')).receipt;assert.equal(final.cleanupComplete,true);assert.equal(final.cleanup.remaining,0);assert.equal(final.cleanup.verifiedGuardCount,0);
  assert.equal(final.nextCleanup,null);assert.doesNotMatch(finished.stdout+interrupted.stderr,new RegExp(token));
  const retry=await json('target','/api/operator/restore',200,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(publication.input)});assert.deepEqual(retry,publication.result);
  await mf.dispose();mf=create();await json('target','/api/ready');
  for(const [command,original]of[[{id:'command-saved',type:'message.posted',data:{messageId:'saved',body:'A useful saved message'}},saved.result],[work.proposal,work.proposed]]){
   const result=await json('target','/api/rooms/commons/commands',200,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:'https://room.example.test','Content-Type':'application/json'},body:JSON.stringify(command)});assert.equal(result.duplicate,true);assert.equal(result.event.id,original.event.id);assert.equal(result.sequence,original.sequence);
  }
  const receipt={source:'fe6f1fbf4f9e7e277ffa755b237eef683a7d5e64',actualNative:true,actualCLI:true,seedMessages:32,postCount,coveragePosts:observations.filter(x=>!x.cleanup).length,cleanupPosts:observations.filter(x=>x.cleanup).length,cleanupRevision:final.cleanup.revision,cleanupTotal:final.cleanup.total,zeroGuards:final.cleanup.verifiedGuardCount,lostAckExactRetry:true,coldCleanupResume:true,publicationRetryImmutable:true,coldUsefulWorkMessageRetry:true,lostRequestSha256:sha(lost),observations};
  await mkdir('/tmp/remote-driver-native-1102',{recursive:true,mode:0o700});
  await writeFile('/tmp/remote-driver-native-1102/result.json',JSON.stringify(receipt,null,2));console.log('REMOTE_NATIVE_DRIVER '+JSON.stringify({...receipt,observations:undefined}));
 }finally{bridge?.closeAllConnections();if(bridge)await new Promise(resolve=>bridge.close(resolve));await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
