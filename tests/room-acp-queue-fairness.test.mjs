import test from 'node:test';
import assert from 'node:assert/strict';
import {ThreadQueue} from '../room-acp/src/queue.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('four refilled threads yield the next slot to an already-routed fresh thread without losing any batch',async()=>{
 const calls=[],releases=[],running=new Set(),inputs=[],counts=new Map();let draining=false,peak=0,overlap=false;
 const push=(key,id)=>{inputs.push(id);queue.push(key,{signalId:id});};
 const queue=new ThreadQueue({concurrency:4,run:async(key,batch)=>{
  if(running.has(key))overlap=true;running.add(key);peak=Math.max(peak,running.size);
  calls.push({key,ids:batch.map(item=>item.signalId)});
  const count=(counts.get(key)??0)+1;counts.set(key,count);
  // Each busy historical thread continually receives another batch. Finite
  // rounds let cleanup finish even when the causal assertion fails.
  if(key.startsWith('old-')&&count<4)push(key,key+'-'+count);
  try{if(!draining)await new Promise(resolve=>releases.push({key,resolve}));}
  finally{running.delete(key);}
 }});
 try{
  for(let i=0;i<4;i++)push('old-'+i,'old-'+i+'-0');await flush();assert.equal(calls.length,4);
  push('fresh','fresh-question');assert.equal(calls.length,4,'fresh waits while all four slots are occupied');
  releases.find(row=>row.key==='old-0').resolve();await flush();
  assert.equal(calls[4]?.key,'fresh','an already waiting thread must get the first freed slot before the completing root refills it');
 }finally{draining=true;for(const row of releases)row.resolve();await queue.idle();}
 assert.equal(overlap,false);assert.equal(peak,4);
 assert.deepEqual(calls.flatMap(row=>row.ids).sort(),inputs.sort(),'every original and refilled input runs exactly once');
 assert.equal(calls.filter(row=>row.key==='fresh').length,1);
});
test('round-robin scheduling preserves same-thread batching and FIFO order among waiting threads',async()=>{
 const calls=[],release=[];let drain=false;
 const queue=new ThreadQueue({concurrency:1,run:async(key,batch)=>{calls.push([key,batch.map(item=>item.signalId)]);if(!drain)await new Promise(resolve=>release.push(resolve));}});
 queue.push('active',{signalId:'a0'});await flush();
 queue.push('active',{signalId:'a1'});queue.push('active',{signalId:'a2'});
 queue.push('formal',{signalId:'formal-obligation'});queue.push('uncertain',{signalId:'original-unknown-delivery'});
 release.shift()();await flush();assert.equal(calls[1][0],'formal');
 release.shift()();await flush();assert.equal(calls[2][0],'uncertain');
 drain=true;release.shift()();await queue.idle();
 assert.deepEqual(calls,[['active',['a0']],['formal',['formal-obligation']],['uncertain',['original-unknown-delivery']],['active',['a1','a2']]]);
});
test('a failed batch still yields its slot and does not drop the next same-thread or waiting batch',async()=>{
 const calls=[];let rejectFirst;
 const queue=new ThreadQueue({concurrency:1,run:async(key,batch)=>{calls.push([key,batch.map(item=>item.signalId)]);if(calls.length===1)await new Promise((_resolve,reject)=>{rejectFirst=reject;});}});
 queue.push('a',{signalId:'a0'});await flush();queue.push('a',{signalId:'a1'});queue.push('b',{signalId:'b0'});
 rejectFirst(Error('Synthetic execution failure'));await queue.idle();
 assert.deepEqual(calls,[['a',['a0']],['b',['b0']],['a',['a1']]]);
});
