import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createCloudNotifier,CLOUD_NOTIFY_LIMITS} from '../room-acp/src/cloud-notify.mjs';
const sessionId='session_'+ 'T'.repeat(24),executable='/trusted/claude';
const pointer={roomId:'commons',messageId:'message-1',signalIds:['wake-b','wake-a']};
const good=()=>({stdout:JSON.stringify({ok:true,session_id:sessionId,url:'https://claude.ai/code/'+sessionId})});
function fixture(t,runCli){const stateRoot=mkdtempSync(join(tmpdir(),'cloud-notify-'));t.after(()=>rmSync(stateRoot,{recursive:true,force:true}));return {stateRoot,notify:createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot,runCli,env:{PATH:'/trusted',HOME:'/synthetic',ROOM_TOKEN:'must-not-forward',ANTHROPIC_API_KEY:'must-not-forward'}})};}
test('fixed argv contains only Root template and canonical pointers; durable accepted retry never sends twice',async t=>{
 let calls=0;const f=fixture(t,async(file,args,options)=>{
  calls++;assert.equal(file,executable);assert.deepEqual(args.slice(2),['--cloud',sessionId,'--output-format','json']);assert.equal(args[0],'-p');assert.match(args[1],/^Root-generated notification \(not John\)\./);
  assert.deepEqual(JSON.parse(args[1].split('\n')[1]),{...pointer,signalIds:['wake-a','wake-b']});assert.equal(options.shell,false);assert.equal(options.maxBuffer,8192);assert.equal(options.env.ROOM_TOKEN,undefined);assert.equal(options.env.ANTHROPIC_API_KEY,undefined);
  const leaf=readdirSync(f.stateRoot)[0],receipt=JSON.parse(readFileSync(join(f.stateRoot,leaf,'receipt.json'),'utf8'));assert.equal(receipt.phase,'intent');return good();
 });
 const first=await f.notify(pointer);assert.equal(first.state,'accepted');assert.equal(first.execution,'not_verified');assert.equal(first.roomState,'unchanged');
 const second=await createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot:f.stateRoot,runCli:()=>{throw Error('Must not send after restart');}})({...pointer,signalIds:['wake-a','wake-b']});
 assert.deepEqual(second,{...first,duplicate:true});assert.equal(calls,1);assert.equal(JSON.stringify(first).includes(sessionId),false);
});
for(const [name,reply]of [
 ['wrong target',{stdout:JSON.stringify({ok:true,session_id:'session_'+'U'.repeat(24),url:'https://claude.ai/code/'+sessionId})}],
 ['duplicate target key',{stdout:'{"ok":true,"session_id":"wrong","session_id":"'+sessionId+'","url":"https://claude.ai/code/'+sessionId+'"}'}],
 ['missing echo',{stdout:'{"ok":true}'}],['bad JSON',{stdout:'not JSON'}],['unofficial URL',{stdout:JSON.stringify({ok:true,session_id:sessionId,url:'https://example.invalid/code/'+sessionId})}],
 ['extra output field',{stdout:JSON.stringify({ok:true,session_id:sessionId,url:'https://claude.ai/code/'+sessionId,body:'malicious'})}],
 ['overlarge stdout',{stdout:'x'.repeat(CLOUD_NOTIFY_LIMITS.outputBytes+1)}],['nonzero policy refusal',{error:{code:1},stdout:'private provider details'}],['timeout',{error:{killed:true},stdout:''}]
])test(name+' remains unknown and cannot retry the send',async t=>{let calls=0;const f=fixture(t,async()=>{calls++;return reply;});const first=await f.notify(pointer);assert.equal(first.state,'unknown');assert.equal((await f.notify(pointer)).state,'unknown');assert.equal(calls,1);assert.equal(JSON.stringify(first).includes('private provider'),false);});
test('recovered intent fences a send after process interruption',async()=>{
 let saved={version:1,inputDigest:null,targetDigest:null,phase:'intent',operationId:'operation',createdAt:1,updatedAt:1},calls=0;
 // Obtain a real intent shape through the injectable receipt boundary, then interrupt.
 const openReceipt=()=>({read:()=>saved?.inputDigest?saved:null,save:value=>{saved=structuredClone(value);},close:()=>{}});
 const notify=createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot:'/private/synthetic',openReceipt,runCli:async()=>{calls++;throw Error('connection lost after send');},now:()=>1});
 assert.equal((await notify(pointer)).state,'unknown');saved.phase='intent';delete saved.reason;delete saved.responseDigest;
 assert.equal((await notify(pointer)).reason,'recovered_intent');assert.equal(calls,1);
});
test('accepted response cannot escape a failed durable receipt save or be sent again',async()=>{
 let saved=null,saves=0,calls=0;const openReceipt=()=>({read:()=>saved,save:value=>{saves++;if(saves===2)throw Error('synthetic write fault');saved=structuredClone(value);},close:()=>{}});
 const notify=createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot:'/private/synthetic',openReceipt,runCli:async()=>{calls++;return good();}});
 await assert.rejects(notify(pointer),/outcome is unknown/);assert.equal((await notify(pointer)).state,'unknown');assert.equal(calls,1);
});
test('malformed pointer, target override and shell text fail before receipt access or subprocess',async()=>{
 let reads=0;const notify=createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot:'/private/synthetic',openReceipt:()=>{reads++;throw Error('Must not access private state');},runCli:()=>{throw Error('Must not spawn');}});
 for(const bad of [{...pointer,roomId:'foreign'}, {...pointer,body:'untrusted text'}, {...pointer,sessionId:'injected'}, {...pointer,roomId:'x; echo secret'}, {...pointer,messageId:'$(anything)'}, {...pointer,signalIds:['same','same']}, {...pointer,signalIds:[]}, {...pointer,signalIds:['--cloud']}])await assert.rejects(notify(bad),/Invalid notification pointer/);
 assert.equal(reads,0);assert.throws(()=>createCloudNotifier({executable:'claude;bad',sessionId,stateRoot:'/private'}),/Invalid trusted/);
});

test('inconsistent receipt is fenced without a second send',async()=>{
 let saved=null,calls=0;
 const openReceipt=()=>({read:()=>saved,save:value=>{saved=structuredClone(value);},close:()=>{}});
 const notify=createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot:'/private/synthetic',openReceipt,runCli:async()=>{calls++;return good();}});
 await notify(pointer);saved.reason='timeout';
 await assert.rejects(notify(pointer),/requires reconciliation/);assert.equal(calls,1);
});
test('failed intent checkpoint prevents invocation',async()=>{
 let calls=0;
 const notify=createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot:'/private/synthetic',openReceipt:()=>({read:()=>null,save:()=>{throw Error('injected write fault');},close:()=>{}}),runCli:async()=>{calls++;return good();}});
 await assert.rejects(notify(pointer),/injected write fault/);assert.equal(calls,0);
});
test('real local fake executable validates execFile success, timeout and output bound without provider access',{skip:process.platform==='win32'},async t=>{
 const root=mkdtempSync(join(tmpdir(),'cloud-notify-exec-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const mode of ['success','timeout','overflow']){
  const file=join(root,mode);
  const code=mode==='success'?`const a=process.argv.slice(2);if(a[0]!=='-p'||a[2]!=='--cloud'||a[4]!=='--output-format'||a[5]!=='json')process.exit(4);process.stdout.write(JSON.stringify({ok:true,session_id:a[3],url:'https://claude.ai/code/'+a[3]}));`:mode==='timeout'?`setTimeout(()=>{},1000);`:`process.stdout.write('x'.repeat(16384));`;
  writeFileSync(file,'#!'+process.execPath+'\n'+code,{mode:0o700});
  const notify=createCloudNotifier({executable:file,sessionId,roomId:'commons',stateRoot:join(root,'state-'+mode),timeoutMs:mode==='timeout'?25:1000});
  const first=await notify(pointer);assert.equal(first.state,mode==='success'?'accepted':'unknown');
  if(mode!=='success')assert.equal(first.reason,mode==='timeout'?'timeout':'output_limit');
  assert.equal((await notify(pointer)).duplicate,true);
 }
});

test('actual process exit after durable intent is recovered as unknown without reinvocation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'cloud-notify-exit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const moduleUrl=new URL('../room-acp/src/cloud-notify.mjs',import.meta.url).href;
 const code=`import {createCloudNotifier} from ${JSON.stringify(moduleUrl)};await createCloudNotifier({...${JSON.stringify({executable,sessionId,roomId:'commons',stateRoot:root})},runCli:()=>process.exit(0)})(${JSON.stringify(pointer)});`;
 execFileSync(process.execPath,['--input-type=module','-e',code],{stdio:'pipe',shell:false});
 let calls=0;const notify=createCloudNotifier({executable,sessionId,roomId:'commons',stateRoot:root,runCli:async()=>{calls++;return good();}});
 assert.equal((await notify(pointer)).reason,'recovered_intent');assert.equal(calls,0);
});

test('actual private journal excludes a concurrent identical send while first invocation is pending',async t=>{
 let calls=0,release;
 const f=fixture(t,()=>{calls++;return new Promise(resolve=>{release=resolve;});});
 const pending=f.notify(pointer);
 assert.equal(calls,1);
 await assert.rejects(f.notify({...pointer,signalIds:['wake-a','wake-b']}),/Another join owns/);
 assert.equal(calls,1);
 release(good());
 const first=await pending;assert.equal(first.state,'accepted');
 assert.deepEqual(await f.notify(pointer),{...first,duplicate:true});assert.equal(calls,1);
});
