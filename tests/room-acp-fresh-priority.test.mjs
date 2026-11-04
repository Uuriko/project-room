import test from 'node:test';
import assert from 'node:assert/strict';
import {ThreadQueue} from '../room-acp/src/queue.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('one of four slots remains available to discovered fresh ordinary work behind historical backlog',async()=>{
 const started=[],release=[],active=new Set();let draining=false,overlap=false,peak=0;
 const queue=new ThreadQueue({concurrency:4,reservedPriority:1,run:async(key,batch)=>{
  if(active.has(key))overlap=true;active.add(key);peak=Math.max(peak,active.size);started.push([key,batch.map(x=>x.signalId)]);
  try{if(!draining)await new Promise(resolve=>release.push(resolve));}finally{active.delete(key);}
 }});
 try{
  for(let i=0;i<8;i++)queue.push('old-'+i,{signalId:'old-'+i});await flush();
  assert.equal(started.length,3,'recovery uses three slots while one is reserved');
  queue.push('fresh',{signalId:'fresh-question'},{priority:true});await flush();
  assert.equal(started[3]?.[0],'fresh');assert.equal(peak,4);
 }finally{draining=true;for(const done of release)done();await queue.idle();}
 assert.equal(overlap,false);assert.deepEqual(started.flatMap(x=>x[1]).sort(),[...Array.from({length:8},(_,i)=>'old-'+i),'fresh-question'].sort());
});
test('a fresh successor never preempts an active turn in the same thread',async()=>{
 const calls=[],release=[];let draining=false;
 const queue=new ThreadQueue({concurrency:4,reservedPriority:1,run:async(key,batch)=>{calls.push([key,batch.map(x=>x.signalId)]);if(!draining)await new Promise(resolve=>release.push(resolve));}});
 try{
  queue.push('same',{signalId:'original-uncertain-operation'});await flush();
  queue.push('same',{signalId:'new-question'},{priority:true});queue.push('other',{signalId:'other-question'},{priority:true});await flush();
  assert.deepEqual(calls.map(x=>x[0]),['same','other']);
  draining=true;for(const done of release)done();await queue.idle();
  assert.deepEqual(calls.filter(x=>x[0]==='same').map(x=>x[1]),[['original-uncertain-operation'],['new-question']]);
 }finally{draining=true;for(const done of release)done();await queue.idle();}
});

import {RoomClient,RoomError} from '../room-acp/src/room.mjs';
import {Bridge,MAX_POLL_PAGES} from '../room-acp/src/bridge.mjs';
test('explicit newest selection requires exact selector and room echo; an older server cannot be mistaken for fresh discovery',async()=>{
 for(const value of [{roomId:'r',pendingWakes:[]},{roomId:'r',order:'oldest',pendingWakes:[]},{roomId:'other',order:'newest',pendingWakes:[]},{roomId:'r',order:'newest',pendingWakes:[{roomId:'other'}]}]){
  let path;const client=new RoomClient({apiBase:'https://example.test',roomId:'r',fetchImpl:async url=>{path=new URL(url);return Response.json(value);}});
  await assert.rejects(client.poll({hostId:'h',waitMs:0,order:'newest'}),e=>e instanceof RoomError&&e.code==='wake_scope_unavailable');assert.equal(path.searchParams.get('order'),'newest');assert.equal(path.searchParams.get('roomId'),'r');
 }
 const client=new RoomClient({apiBase:'https://example.test',roomId:'r',fetchImpl:async()=>Response.json({roomId:'r',order:'newest',pendingWakes:[]})});assert.equal((await client.poll({hostId:'h',waitMs:0,order:'newest'})).order,'newest');
});
test('only exact same-room acquired listener capability enables recent probes and reserves one slot',async()=>{
 for(const capability of [undefined,{version:2,newest:true,roomId:'r'},{version:1,newest:true,roomId:'other'},{version:1,newest:true,roomId:'r',extra:true},{version:1,newest:true,roomId:'r'}]){
  const b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m'},persistSessions:false,host:{}});
  b.room.heartbeat=async()=>({listener:{acquired:true,fencingToken:'fence',leaseExpiresAt:Date.now()+60000},wakeSelection:capability});await b.lease();
  const enabled=capability?.version===1&&capability.roomId==='r'&&!capability.extra;assert.equal(b.freshWakeDiscovery,Boolean(enabled));assert.equal(b.queue.reservedPriority,enabled?1:0);
 }
});
test('a quiet thread outside every recent head is eventually discovered through the independent oldest cursor despite ongoing arrivals',async()=>{
 const calls=[],accepted=[],b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},persistSessions:false,host:{},minPollIntervalMs:0});b.lease=async()=>true;b.freshWakeDiscovery=true;
 let newest=0,done=false;
 b.room.poll=async({order='oldest',cursor,waitMs})=>{
  assert.equal(waitMs,order==='oldest'&&cursor===null?b.waitMs:0);calls.push({order,cursor});
  if(order==='newest'){assert.equal(cursor,undefined);return{roomId:'r',order,pendingWakes:[{signalId:'new-'+newest++,roomId:'r'}],more:true,nextCursor:'unused-newest-position'};}
  const n=cursor===null?0:Number(cursor.slice(1));if(n===MAX_POLL_PAGES+2){done=true;return{pendingWakes:[{signalId:'quiet-outside-recent-window'}],more:false};}
  return{pendingWakes:[{signalId:'old-'+n}],more:true,nextCursor:'c'+(n+1)};
 };
 b.accept=async(signal,options)=>accepted.push({id:signal.signalId,priority:options?.priority===true});
 await b.pollOnce();assert.equal(b.wakeCursor,'c'+MAX_POLL_PAGES);assert.equal(done,false);
 await b.pollOnce();assert.equal(done,true);assert.equal(b.wakeCursor,null);
 assert.equal(accepted.filter(x=>x.id==='quiet-outside-recent-window').length,1);assert.equal(accepted.find(x=>x.id==='quiet-outside-recent-window').priority,false);
 assert.ok(accepted.some(x=>x.id.startsWith('new-')&&x.priority));assert.equal(calls.filter(x=>x.order==='oldest').length,MAX_POLL_PAGES+3);
});

test('fifty historical newest roots cannot create an unbounded priority backlog; newer pending root replaces priority only and recovery keeps moving',async()=>{
 const calls=[],gates=[];let draining=false;
 const queue=new ThreadQueue({concurrency:4,reservedPriority:1,run:async(key,batch)=>{calls.push([key,batch.map(x=>x.signalId)]);if(!draining)await new Promise(resolve=>gates.push({key,resolve}));}});
 const input=[];const push=(key,priority,createdAt)=>{input.push(key);queue.push(key,{signalId:key},{priority,priorityPosition:{createdAt,signalId:key}});};
 try{
  for(let i=0;i<8;i++)push('recovery-'+i,false,i);await flush();
  for(let i=0;i<50;i++)push('head-'+i,true,100+i);await flush();
  assert.equal(queue.priorityActive,1);assert.equal([...queue.threads.values()].filter(x=>x.priority).length,1);
  push('new-question',true,1000);assert.equal(queue.pendingPriorityKey,'new-question');
  assert.equal([...queue.threads.values()].filter(x=>x.priority).length,1);
  gates.find(x=>x.key==='head-0').resolve();await flush();assert.equal(calls.at(-1)[0],'new-question');
  push('newer-question',true,1001);gates.find(x=>x.key==='recovery-0').resolve();await flush();
  assert.equal(calls.at(-1)[0],'recovery-3','a free recovery slot still advances old FIFO while priority is active and waiting');
 }finally{draining=true;for(const x of gates)x.resolve();await queue.idle();}
 assert.deepEqual(calls.flatMap(x=>x[1]).sort(),input.sort());
});
test('an older candidate cannot demote a newer waiting question, and concurrency1 retains FIFO without reservation',async()=>{
 const releases=[];let drain=false;const calls=[];
 const queue=new ThreadQueue({concurrency:2,reservedPriority:1,run:async(key)=>{calls.push(key);if(!drain)await new Promise(r=>{releases.push(r);});}});
 queue.push('active',{signalId:'a'},{priority:true,priorityPosition:{createdAt:10,signalId:'a'}});await flush();
 queue.push('new',{signalId:'n'},{priority:true,priorityPosition:{createdAt:30,signalId:'n'}});
 queue.push('older',{signalId:'o'},{priority:true,priorityPosition:{createdAt:20,signalId:'o'}});await flush();
 assert.equal(queue.pendingPriorityKey,'new');drain=true;for(const done of releases)done();await queue.idle();
 const order=[],single=new ThreadQueue({concurrency:1,run:async key=>{order.push(key);}});
 single.push('first',{signalId:'1'});single.push('second',{signalId:'2'});single.push('fresh',{signalId:'3'},{priority:true});await single.idle();assert.deepEqual(order,['first','second','fresh']);
});

test('seen, parked, formal, unknown-author and uncertain receipts do not consume the single priority candidate',async()=>{
 const {createHash}=await import('node:crypto'),queued=[],selected=[];
 const b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},persistSessions:false,host:{},minPollIntervalMs:0});b.freshWakeDiscovery=true;
 const ids=['seen','formal','parked','unknown-author','uncertain','eligible','not-admitted-by-head'];
 b.seen.add('seen');b.chatReceipts.begin('uncertain',{phase:'started',threadKey:'uncertain',messageIds:['uncertain'],signalIds:['uncertain']});
 const root=id=>({id,authorId:'author',body:'Synthetic question'});
 b.readThread=async id=>{selected.push(id);return{thread:root(id),...(id==='formal'?{replyRequest:{recipientId:'m',status:'open'}}:{})};};
 b.readParkedThread=id=>id==='parked'?{rootHash:createHash('sha256').update(JSON.stringify(root(id))).digest('hex')}:undefined;
 b.messageAuthority=async([id])=>new Map([[id,id==='unknown-author'?'unresolved':'allowed']]);
 b.queue.push=(key,item,options)=>{queued.push({key,id:item.signalId,priority:options.priority});return true;};
 b.room.poll=async()=>({roomId:'r',order:'newest',pendingWakes:ids.map((id,i)=>({signalId:id,messageId:id,kind:'mention',createdAt:100-i,roomId:'r'}))});
 await b.discoverRecent();assert.deepEqual(queued.filter(x=>x.priority).map(x=>x.key),['eligible']);
 assert.deepEqual(queued.filter(x=>!x.priority).map(x=>x.key),['formal','parked','unknown-author','uncertain']);
 assert.ok(!selected.includes('seen'));assert.ok(!selected.includes('not-admitted-by-head'));assert.equal(b.wakeCursor,null);
});

test('a single-session bridge retains original oldest-only discovery even when newest capability is advertised',async()=>{
 const b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m'},maxSessions:1,persistSessions:false,host:{}});
 b.room.heartbeat=async()=>({listener:{acquired:true,fencingToken:'fence',leaseExpiresAt:Date.now()+60000},wakeSelection:{version:1,newest:true,roomId:'r'}});
 await b.lease();assert.equal(b.freshWakeDiscovery,false);assert.equal(b.queue.reservedPriority,0);
 let polls=0;b.room.poll=async()=>{polls++;};await b.discoverRecent();assert.equal(polls,0);
});

test('an advertised idle host retains the existing oldest long wait after its bounded recent peek',async()=>{
 const polls=[],b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},waitMs:12345,minPollIntervalMs:0,persistSessions:false,host:{}});
 b.freshWakeDiscovery=true;b.lease=async()=>true;
 b.room.poll=async options=>{polls.push({order:options.order??'oldest',waitMs:options.waitMs,cursor:options.cursor});return{pendingWakes:[],more:false};};
 await b.pollOnce();assert.deepEqual(polls,[{order:'newest',waitMs:0,cursor:undefined},{order:'oldest',waitMs:12345,cursor:null}]);
});

for(const status of [0,502,503,504])test(`optional recent transport failure ${status} cannot starve oldest continuation`,async()=>{
 const calls=[],b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},minPollIntervalMs:0,persistSessions:false,host:{}});
 b.freshWakeDiscovery=true;b.lease=async()=>true;b.wakeCursor='old-cursor';
 let cycle=0;
 b.room.poll=async({order='oldest',cursor})=>{
  calls.push(order);
  if(order==='newest')throw new RoomError(status,'temporary_failure','Unavailable');
  assert.equal(cursor,cycle===0?'old-cursor':null);cycle++;return{pendingWakes:[],more:false};
 };
 for(let i=0;i<3;i++)await b.pollOnce();
 assert.equal(cycle,3);assert.equal(b.wakeCursor,null);
 assert.deepEqual(calls,['newest','oldest','newest','oldest','newest','oldest']);
});
for(const [status,code]of [[401,'authentication_failed'],[403,'access_denied'],[409,'wake_scope_unavailable'],[429,'rate_limited']])test(`recent ${status} ${code} does not bypass access, binding or shared cooldown`,async()=>{
 const calls=[],b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},minPollIntervalMs:0,persistSessions:false,host:{}});
 b.freshWakeDiscovery=true;b.lease=async()=>true;b.wakeCursor='old-cursor';
 const expected=new RoomError(status,code,'Refused',status===429?5000:null);
 b.room.poll=async({order='oldest'})=>{calls.push(order);throw expected;};
 await assert.rejects(()=>b.pollOnce(),error=>error===expected);
 assert.deepEqual(calls,['newest']);assert.equal(b.wakeCursor,'old-cursor');
});
test('a recent wake acceptance failure is not hidden as a failed optional transport',async()=>{
 const b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},minPollIntervalMs:0,persistSessions:false,host:{}});
 b.freshWakeDiscovery=true;b.lease=async()=>true;
 b.room.poll=async()=>({pendingWakes:[{signalId:'protected'}]});
 const expected=new RoomError(503,'context_unavailable','Protected context refused');b.accept=async()=>{throw expected;};
 await assert.rejects(()=>b.pollOnce(),error=>error===expected);
});
test('a recent503 Retry-After is honored before the independent oldest request through the real client wrapper',async()=>{
 const calls=[],started=Date.now(),b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},minPollIntervalMs:0,persistSessions:false,host:{}});
 b.freshWakeDiscovery=true;b.lease=async()=>true;
 b.room=new RoomClient({apiBase:'https://example.test',roomId:'r',fetchImpl:async input=>{
  const order=new URL(input).searchParams.get('order')??'oldest';calls.push(order);
  if(order==='newest')return Response.json({error:{code:'storage_unavailable',message:'Unavailable'}},{status:503,headers:{'retry-after':'1'}});
  assert.ok(Date.now()-started>=900,'oldest request must respect the server wait');
  return Response.json({roomId:'r',pendingWakes:[],more:false});
 }});
 await b.pollOnce();assert.deepEqual(calls,['newest','oldest']);
});
test('cancellation during recent503 Retry-After never makes an oldest request',async()=>{
 const calls=[],b=new Bridge({connection:{apiBase:'https://example.test',roomId:'r',memberId:'m',hostId:'h'},minPollIntervalMs:0,persistSessions:false,host:{}});
 b.freshWakeDiscovery=true;b.lease=async()=>true;
 b.room.poll=async({order='oldest'})=>{calls.push(order);setTimeout(()=>b.controller.abort(),10);throw new RoomError(503,'temporary_failure','Unavailable',1000);};
 await assert.rejects(()=>b.pollOnce(),error=>error.name==='AbortError');assert.deepEqual(calls,['newest']);
});
