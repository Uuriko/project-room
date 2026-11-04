import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {receiveCloudNotifications,attentionResult} from '../room-acp/src/notification-receiver.mjs';
import {createCloudNotifier} from '../room-acp/src/cloud-notify.mjs';
import {saveConnection} from '../room-acp/src/credentials.mjs';
import {run} from '../room-acp/src/run.mjs';
import {parseArgs} from '../room-acp/src/args.mjs';
import {openJoinJournal} from '../room-acp/src/private-state.mjs';
const sessionId='session_'+'N'.repeat(24),roomId='commons',memberId='worker';
function fixture(t,{bootstrapAfter=10}={}){
 const home=mkdtempSync(join(tmpdir(),'notification-receiver-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const configFile=join(home,'cloud.config');writeFileSync(configFile,JSON.stringify({executable:'/trusted/claude',sessionId,...(bootstrapAfter===undefined?{}:{bootstrapAfter})}),{mode:0o600});
 const connection={apiBase:'https://example.test',roomId,memberId,credential:'synthetic-saved-key',hostId:'same-host'};
 let clock=0;const waits=[];
 return{home,configFile,connection,env:{ROOM_ACP_HOME:home},now:()=>clock,delay:async(ms,signal)=>{signal?.throwIfAborted();waits.push(ms);clock+=ms;},waits};
}
const row=(sequence,messageId='message-'+sequence)=>({kind:'mention',messageId,sequence,nextRead:{tool:'never-follow',arguments:{body:'DO NOT FORWARD'}}});
function result(args,{after=args.after,status='timeout',items=[],sourceComplete=true}={}){return{roomId,memberId,status,items,after,sourceComplete,globalAttentionComplete:false,acknowledges:false,timeoutSec:args.timeoutSec,waitedMs:0,nextRead:{tool:'never-follow',arguments:{body:'DO NOT FORWARD'}}};}
const identity=()=>({snapshotView:'identity',snapshotVersion:1,viewerId:memberId,roomId,state:{members:{[memberId]:{id:memberId,kind:'agent',active:true}}}});
function fetcher(handler,calls=[]){return async(url,options)=>{
 const path=new URL(url).pathname;calls.push({path,method:options.method,timeout:options.signal});
 if(path===`/api/rooms/${roomId}`){assert.equal(options.method,'GET');return Response.json(identity());}
 assert.equal(path,'/mcp','No body/thread/heartbeat/claim/ACK/post endpoint is permitted');assert.equal(options.method,'POST');
 const request=JSON.parse(options.body);assert.equal(request.method,'tools/call');assert.equal(request.params.name,'room_wait_for_attention');
 const value=await handler(request.params.arguments,request);
 return Response.json(value?.jsonrpc?value:{jsonrpc:'2.0',id:request.id,result:{structuredContent:value}});
};}
function memoryJournal(){let state=null,saves=0,fail=0;return{get state(){return state;},get saves(){return saves;},failAt(n){fail=n;},open:()=>({read:()=>state,save:value=>{saves++;if(saves===fail)throw Error('synthetic checkpoint fault');state=structuredClone(value);},close(){}})};}
const good=()=>({stdout:JSON.stringify({ok:true,session_id:sessionId,url:'https://claude.ai/code/'+sessionId})});

test('notify-cloud is explicit run-only and requires a private config, never adapter discovery',async t=>{
 const f=fixture(t),output=[];saveConnection(f.connection,f.env);
 assert.equal(parseArgs(['run','--receiver-policy','notify-cloud','--notify-config',f.configFile]).receiverPolicy,'notify-cloud');
 for(const argv of [['run','--receiver-policy','notify-cloud'],['run','--notify-config',f.configFile],['doctor','--receiver-policy','notify-cloud','--notify-config',f.configFile]])assert.throws(()=>parseArgs(argv));
 let requests=0;
 const exit=await run({receiverPolicy:'notify-cloud',notifyConfig:f.configFile,agentCmd:'MUST NOT RUN',permissionApprover:'none'}, {env:f.env,print:x=>output.push(x),onBridge:()=>{throw Error('Bridge must not be constructed');},candidate:{label:'MUST NOT START'},fetchImpl:fetcher((_args,request)=>{requests++;return{jsonrpc:'2.0',id:request.id,result:{isError:true,structuredContent:{status:409,code:'attention_wait_superseded'}}};})});
 assert.equal(exit,4);assert.equal(requests,1);assert.doesNotMatch(output.join('\n'),/listening|session_N|synthetic-saved-key/);
 assert.equal(JSON.parse(readFileSync(join(f.home,'commons.json'))).permissionApproverId,undefined);
});

test('response validation refuses foreign scope, bodies, bad cursor, duplicates and HTTP200 tool errors',()=>{
 const args={roomId,memberId,after:10,timeoutSec:120},requestId='read';const valid=result(args,{after:11,status:'ready',items:[row(11)]});
 const parse=value=>attentionResult({jsonrpc:'2.0',id:requestId,result:{structuredContent:value}},{...args,requestId});
 assert.deepEqual(parse(valid).items,[{messageId:'message-11',sequence:11}]);
 for(const altered of [{...valid,roomId:'foreign'},{...valid,memberId:'foreign'},{...valid,after:9},{...valid,status:'answered'},{...valid,acknowledges:true},{...valid,items:[{...row(11),body:'PRIVATE'}]},{...valid,items:[row(11),row(11)]},{...valid,items:[row(12)]},{...valid,items:[]},{...result(args),status:'catch_up_required'}])assert.throws(()=>parse(altered),e=>e.code==='notification_context_unavailable');
 assert.throws(()=>attentionResult({jsonrpc:'2.0',id:requestId,result:{isError:true,structuredContent:{status:403,code:'insufficient_scope'}}},{...args,requestId}),e=>e.status===403&&e.code==='insufficient_scope');
});

test('four immediate ready frames become one frozen16-pointer batch, cursor commits after outcome',async t=>{
 const f=fixture(t),journal=memoryJournal(),cancel=new AbortController(),starts=[],delivered=[];let frame=0;
 const code=await receiveCloudNotifications({...f,signal:cancel.signal,openReceipt:journal.open,fetchImpl:fetcher(args=>{starts.push(args.timeoutSec);const after=args.after+4;return result(args,{after,status:'ready',sourceComplete:starts.length===4,items:Array.from({length:4},(_,i)=>row(args.after+i+1))});}),notifierFactory:()=>async batch=>{
  delivered.push(structuredClone(batch));assert.deepEqual(journal.state.inFlight.batch,batch);assert.equal(journal.state.after,10);assert.equal(batch.items.length,16);frame++;return{state:'accepted'};
 },print:line=>{if(line.startsWith('Notification accepted'))cancel.abort();}});
 assert.equal(code,0);assert.equal(frame,1);assert.equal(delivered[0].items.length,16);assert.deepEqual(starts,[120,0,0,0]);assert.equal(journal.state.after,26);assert.equal(journal.state.inFlight,null);assert.equal(f.waits.length,3);
});

for(const fault of ['before intent','after send before cursor'])test('cold exact recovery: '+fault,async t=>{
 const f=fixture(t),journal=memoryJournal(),cancel=new AbortController();let reads=0,sends=0;
 const factory=options=>createCloudNotifier({...options,runCli:async()=>{sends++;return good();}});
 const fetchImpl=fetcher(args=>{reads++;return result(args,reads===1?{after:11,status:'ready',items:[row(11)]}:{});});
 journal.failAt(fault==='before intent'?2:3);
 await assert.rejects(()=>receiveCloudNotifications({...f,openReceipt:journal.open,fetchImpl,notifierFactory:factory}),/checkpoint fault/);
 assert.equal(sends,fault==='before intent'?0:1);
 journal.failAt(0);reads=0;
 await receiveCloudNotifications({...f,signal:cancel.signal,openReceipt:journal.open,fetchImpl,notifierFactory:factory,print:line=>{if(line.startsWith('Notification accepted'))cancel.abort();}});
 assert.equal(sends,1);assert.equal(journal.state.after,11);assert.equal(journal.state.inFlight,null);
});

test('unknown batch retains exact pointers, commits discovery only, never resends after cold replay',async t=>{
 const f=fixture(t),journal=memoryJournal(),cancel=new AbortController();let calls=0,reads=0;
 const factory=options=>createCloudNotifier({...options,runCli:async()=>{calls++;return{error:{killed:true}};}});
 journal.failAt(3); // Outcome is durable, cursor save fails.
 const fetchImpl=fetcher(args=>result(args,++reads===1?{after:11,status:'ready',items:[row(11)]}:{}));
 await assert.rejects(()=>receiveCloudNotifications({...f,openReceipt:journal.open,fetchImpl,notifierFactory:factory}),/checkpoint fault/);
 journal.failAt(0);
 await receiveCloudNotifications({...f,signal:cancel.signal,openReceipt:journal.open,fetchImpl,notifierFactory:factory,print:line=>{if(line.startsWith('Notification unknown'))cancel.abort();}});
 assert.equal(calls,1);assert.equal(journal.state.after,11);
 const scopedRoot=join(f.home,'notify-state',readdirSync(join(f.home,'notify-state')).find(x=>x.startsWith('source-')));
 const receipts=readdirSync(scopedRoot).filter(x=>x.startsWith('.join-cloud-notify-')).map(x=>JSON.parse(readFileSync(join(scopedRoot,x,'receipt.json'))));
 assert.equal(receipts.length,1);assert.equal(receipts[0].phase,'unknown');assert.deepEqual(receipts[0].input,{roomId,items:[{messageId:'message-11',sequence:11}]});
});

test('quiet holds120 seconds, unchanged timeout cursor is legal; catchup is paced and no-progress refuses',async t=>{
 const f=fixture(t),journal=memoryJournal(),cancel=new AbortController(),timeouts=[];let calls=0;
 await receiveCloudNotifications({...f,signal:cancel.signal,openReceipt:journal.open,fetchImpl:fetcher(args=>{
  timeouts.push(args.timeoutSec);calls++;if(calls===3)cancel.abort();return result(args,calls===1?{after:14,status:'catch_up_required'}:{});
 }),notifierFactory:()=>()=>{throw Error('No notification permitted');}});
 assert.deepEqual(timeouts,[120,120,120]);assert.equal(journal.state.after,14);assert.equal(f.waits.length,2);assert.ok(f.waits.every(ms=>ms>=2500));
});

test('HTTP429 honors cooldown, supersession stops without a replacement wait or any mutation',async t=>{
 const f=fixture(t),journal=memoryJournal();let calls=0;const sleeps=[];
 const fetchImpl=async(url,options)=>{
  calls++;if(calls===1)return Response.json({error:{code:'rate_limited'}},{status:429,headers:{'retry-after':'1'}});
  const q=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:q.id,result:{isError:true,structuredContent:{status:409,code:'attention_wait_superseded'}}});
 };
 const started=Date.now();const code=await receiveCloudNotifications({...f,openReceipt:journal.open,fetchImpl,delay:async(ms,signal)=>{sleeps.push(ms);await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});}});
 assert.equal(code,4);assert.equal(calls,2);assert.ok(sleeps.includes(1000));assert.ok(Date.now()-started>=990);assert.equal(journal.state.after,10);
});

test('bootstrap is mandatory only without journal; cancellation preserves frontier and releases ownership',async t=>{
 const f=fixture(t);writeFileSync(f.configFile,JSON.stringify({executable:'/trusted/claude',sessionId}),{mode:0o600});
 await assert.rejects(()=>receiveCloudNotifications({...f,fetchImpl:()=>{throw Error('No HTTP');}}),/explicit bootstrapAfter/);
 const cancel=new AbortController();cancel.abort();writeFileSync(f.configFile,JSON.stringify({executable:'/trusted/claude',sessionId,bootstrapAfter:123}),{mode:0o600});
 assert.equal(await receiveCloudNotifications({...f,signal:cancel.signal,fetchImpl:()=>{throw Error('No HTTP');}}),0);
 writeFileSync(f.configFile,JSON.stringify({executable:'/trusted/claude',sessionId}),{mode:0o600});
 assert.equal(await receiveCloudNotifications({...f,signal:cancel.signal,fetchImpl:()=>{throw Error('No HTTP');}}),0);
});

test('actual Node HTTP + fake CLI sees fixed source-only argv, stdin EOF and no adapter/Room mutation',async t=>{
 const f=fixture(t),cancel=new AbortController(),calls=[],output=join(f.home,'argv.json'),executable=join(f.home,'fake-cli');
 writeFileSync(executable,'#!'+process.execPath+'\n'+`import fs from 'node:fs';let input='';for await(const c of process.stdin)input+=c;if(input)process.exit(3);fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)));const session=process.argv[5];console.log(JSON.stringify({ok:true,session_id:session,url:'https://claude.ai/code/'+session}));`,{mode:0o700});
 writeFileSync(f.configFile,JSON.stringify({executable,sessionId,bootstrapAfter:10}),{mode:0o600});
 let frames=0;const server=createServer(async(req,res)=>{
  calls.push(req.method+' '+req.url);res.setHeader('content-type','application/json');
  if(req.method==='GET'){res.end(JSON.stringify(identity()));return;}
  let raw='';for await(const c of req)raw+=c;const q=JSON.parse(raw);const args=q.params.arguments;
  assert.equal(q.params.name,'room_wait_for_attention');assert.equal(req.url,'/mcp');
  const value=result(args,++frames===1?{after:11,status:'ready',items:[row(11)]}:{});
  res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{structuredContent:value}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 f.connection.apiBase='http://127.0.0.1:'+server.address().port;
 await receiveCloudNotifications({...f,signal:cancel.signal,print:line=>{if(line.startsWith('Notification accepted'))cancel.abort();}});
 const argv=JSON.parse(readFileSync(output));assert.equal(argv[0],'-p');assert.deepEqual(JSON.parse(argv[1].split('\n')[1]),{roomId,items:[{messageId:'message-11',sequence:11}]});assert.deepEqual(argv.slice(2),['--cloud',sessionId,'--output-format','json']);
 assert.deepEqual(calls,['POST /mcp','GET /api/rooms/commons?view=identity']);assert.equal(JSON.stringify(argv).includes('DO NOT FORWARD'),false);
});

test('one private owner excludes simultaneous couriers and cancellation releases the exact owner',async t=>{
 const f=fixture(t),cancel=new AbortController();let entered;const ready=new Promise(r=>entered=r);
 const fetchImpl=async(_url,options)=>{entered();await new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});};
 const first=receiveCloudNotifications({...f,signal:cancel.signal,fetchImpl});await ready;
 await assert.rejects(()=>receiveCloudNotifications({...f,fetchImpl:()=>{throw Error('No second HTTP');}}),/Another join owns/);
 cancel.abort();assert.equal(await first,0);
 const stopped=new AbortController();stopped.abort();assert.equal(await receiveCloudNotifications({...f,signal:stopped.signal,fetchImpl:()=>{throw Error('No HTTP');}}),0);
});

test('cancellation during error backoff stops successfully without frontier or provider changes',async t=>{
 const f=fixture(t),journal=memoryJournal(),cancel=new AbortController();
 const result=await receiveCloudNotifications({...f,signal:cancel.signal,openReceipt:journal.open,fetchImpl:async()=>{throw Error('transport down');},delay:async()=>{cancel.abort();throw cancel.signal.reason;},notifierFactory:()=>()=>{throw Error('No provider');}});
 assert.equal(result,0);assert.equal(journal.state.after,10);assert.equal(journal.state.inFlight,null);
});

test('cold corrupted checkpoint refuses before network or provider and keeps original frontier',async t=>{
 const f=fixture(t),journal=memoryJournal(),cancel=new AbortController();let reads=0;
 journal.failAt(3);
 await assert.rejects(()=>receiveCloudNotifications({...f,openReceipt:journal.open,fetchImpl:fetcher(args=>result(args,++reads===1?{after:11,status:'ready',items:[row(11)]}:{})),notifierFactory:()=>async()=>({state:'accepted'})}),/checkpoint fault/);
 journal.failAt(0);journal.state.inFlight.batch.items[0].sequence=99;
 await assert.rejects(()=>receiveCloudNotifications({...f,signal:cancel.signal,openReceipt:journal.open,fetchImpl:()=>{throw Error('No HTTP');},notifierFactory:()=>()=>{throw Error('No provider');}}),e=>e.code==='notification_context_unavailable');
 assert.equal(journal.state.after,10);
});

test('actual protected normalized MCP attention sends pointers only and leaves formal/wake authority untouched',async t=>{
 const {RoomStore}=await import('../server/store.mjs'),{createRoomServer}=await import('../server/http.mjs'),{seedScopedInbox}=await import('./helpers/scoped-inbox-source.mjs');
 const f=fixture(t,{bootstrapAfter:42}),store=new RoomStore(':memory:');t.after(()=>store.close());const saved=seedScopedInbox(store);
 store.room=()=>{throw Error('No whole-room hydration');};
 const server=createRoomServer({store}),requests=[];server.on('request',req=>requests.push(req.method+' '+req.url));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeStreams();server.closeAllConnections();server.close();});
 f.connection.apiBase='http://127.0.0.1:'+server.address().port;f.connection.credential=saved.token;
 const cancel=new AbortController(),received=[];
 await receiveCloudNotifications({...f,signal:cancel.signal,notifierFactory:()=>async batch=>{received.push(batch);return{state:'accepted'};},print:line=>{if(line.startsWith('Notification accepted'))cancel.abort();}});
 assert.equal(received.length,1);assert.deepEqual([...received[0].items].sort((a,b)=>a.sequence-b.sequence).map(item=>item.messageId),['mention','dm','reply','overlap']);
 assert.equal(JSON.stringify(received).includes('PRIVATE-OTHER-PAIR'),false);assert.equal(JSON.stringify(received).includes('private instruction'),false);
 assert.equal(store.db.prepare("SELECT json_extract(payload,'$.status') status FROM current_room_records WHERE room_id='commons' AND domain='replyRequests' AND record_key='dm'").get()?.status,'open');
 assert.ok(requests.every(path=>path==='POST /mcp'||path==='GET /api/rooms/commons?view=identity'));
});


test('head-complete ready frame sends immediately without a redundant timeout-zero drain',async t=>{
 const f=fixture(t),cancel=new AbortController(),calls=[];
 await receiveCloudNotifications({...f,signal:cancel.signal,fetchImpl:fetcher(args=>{calls.push(args.timeoutSec);return result(args,{after:11,status:'ready',items:[row(11)]});}),notifierFactory:()=>async()=>({state:'accepted'}),print:line=>{if(line.startsWith('Notification accepted'))cancel.abort();}});
 assert.deepEqual(calls,[120]);assert.deepEqual(f.waits,[]);
});

test('a newer re-mention of the same message across valid frames coalesces once at its newest sequence',async t=>{
 const f=fixture(t),cancel=new AbortController(),journal=memoryJournal(),batches=[];let frame=0;
 await receiveCloudNotifications({...f,signal:cancel.signal,openReceipt:journal.open,fetchImpl:fetcher(args=>result(args,{after:args.after+1,status:'ready',sourceComplete:++frame===2,items:[row(args.after+1,'same-message')]})),notifierFactory:()=>async batch=>{batches.push(batch);return{state:'accepted'};},print:line=>{if(line.startsWith('Notification accepted'))cancel.abort();}});
 assert.equal(frame,2);assert.deepEqual(batches,[{roomId,items:[{messageId:'same-message',sequence:12}]}]);assert.equal(journal.state.after,12);assert.equal(f.waits.length,1);
});


for(const dimension of ['origin','member'])test(`actuator namespaces isolate two ${dimension}s and exact-scope cold retry still sends once`,async t=>{
 const f=fixture(t);let calls=0,failCursor=true;
 const openReceipt=(...args)=>{const journal=openJoinJournal(...args);return{...journal,save:value=>{if(failCursor&&value.after===11&&value.inFlight===null)throw Error('synthetic cursor commit fault');journal.save(value);}};};
 const notifierFactory=options=>createCloudNotifier({...options,runCli:async(_file,argv)=>{calls++;assert.deepEqual(JSON.parse(argv[1].split('\n')[1]),{roomId,items:[{messageId:'same-source',sequence:11}]});return good();}});
 const connections=[{...f.connection},{...f.connection,...(dimension==='origin'?{apiBase:'https://different.test'}:{memberId:'other-worker'})}];
 const fetchFor=connection=>async(url,options)=>{
  if(new URL(url).pathname!== '/mcp')return Response.json({snapshotView:'identity',snapshotVersion:1,roomId,viewerId:connection.memberId,state:{members:{[connection.memberId]:{id:connection.memberId,kind:'agent',active:true}}}});
  const q=JSON.parse(options.body),args=q.params.arguments;return Response.json({jsonrpc:'2.0',id:q.id,result:{structuredContent:{...result(args,{after:11,status:'ready',items:[row(11,'same-source')]}),memberId:connection.memberId}}});
 };
 for(const connection of connections)await assert.rejects(()=>receiveCloudNotifications({...f,connection,openReceipt,fetchImpl:fetchFor(connection),notifierFactory}),/cursor commit fault/);
 assert.equal(calls,2,'different authenticated source scopes must not share an accepted actuator receipt');
 failCursor=false;
 for(const connection of connections){const cancel=new AbortController();assert.equal(await receiveCloudNotifications({...f,connection,openReceipt,fetchImpl:fetchFor(connection),notifierFactory,signal:cancel.signal,print:line=>{if(line.startsWith('Notification accepted'))cancel.abort();}}),0);}
 assert.equal(calls,2,'same exact scope reuses its frozen accepted receipt after cursor-commit loss');
});
