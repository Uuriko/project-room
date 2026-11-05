import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomClient} from '../src/client.js';

const path = '/api/rooms/fresh/assistant';
const ok = value => ({ok:true,status:200,json:async()=>value});
function timedClient(t, fetcher) {
  t.mock.timers.enable({apis:['setTimeout']});
  return new RoomClient({fetcher});
}
const hanging = (_url,{signal}) => new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));

test('owned assistant read timeout has actionable copy instead of the native abort reason',async t=>{
  const client=timedClient(t,hanging);
  const pending=client.request(path);
  const rejected=assert.rejects(pending,error=>{
    assert.equal(error.name,'AbortError');
    assert.equal(error.code,'request_timeout');
    assert.equal(error.message,'The request timed out before confirmation. Please try again.');
    assert.equal(error.status,undefined);
    assert.equal(error.cause.name,'AbortError');
    return true;
  });
  t.mock.timers.tick(10000);
  await rejected;
});

test('an uncertain assistant write can retry the exact original body and request ID',async t=>{
  const sent=[];
  const receipt={result:{id:'ask',revision:1},duplicate:true};
  const client=timedClient(t,(url,options)=>{
    sent.push({url,body:options.body});
    return sent.length===1?hanging(url,options):Promise.resolve(ok(receipt));
  });
  const data={action:'invoke',requestId:'saved-before-send',runId:'ask',sourceMessageId:'opening'};
  const pending=client.request(path,{method:'POST',data});
  const rejected=assert.rejects(pending,error=>error.name==='AbortError'&&error.code==='request_timeout'&&error.status===undefined);
  t.mock.timers.tick(10000); await rejected;
  assert.deepEqual(await client.request(path,{method:'POST',data}),receipt);
  assert.deepEqual(sent[0],sent[1]);
  assert.equal(data.requestId,'saved-before-send');
});

test('a timed-out coalesced read is released so the next refresh can recover',async t=>{
  let calls=0;
  const client=timedClient(t,(url,options)=>++calls===1?hanging(url,options):Promise.resolve(ok({assistant:{name:'Room'},runs:[]})));
  const first=client.request(path),joined=client.request(path);
  const settled=Promise.allSettled([first,joined]);
  t.mock.timers.tick(10000);
  assert.equal((await settled).filter(item=>item.status==='rejected').length,2);
  assert.deepEqual(await client.request(path),{assistant:{name:'Room'},runs:[]});
  assert.equal(calls,2);
});

test('an unowned cancellation or network failure is not reclassified as the owned timeout',async()=>{
  for(const original of [new DOMException('External cancellation','AbortError'),new TypeError('Network disconnected')]){
    const client=new RoomClient({fetcher:async()=>{throw original;}});
    await assert.rejects(client.request(path),error=>error===original);
  }
});

test('real assistant service failures retain their code and status',async()=>{
  const client=new RoomClient({fetcher:async()=>({ok:false,status:503,json:async()=>({error:{code:'assistant_host_unavailable',message:'The host is unavailable'}})})});
  await assert.rejects(client.request(path),error=>error.status===503&&error.code==='assistant_host_unavailable'&&!error.message.includes('timed out'));
});


test('a real service response that finishes at the deadline is not relabeled a timeout',async t=>{
  let resolveBody;
  const body=new Promise(resolve=>{resolveBody=resolve;});
  const client=timedClient(t,async()=>({ok:false,status:503,json:()=>body}));
  const pending=client.request(path);
  await Promise.resolve();
  t.mock.timers.tick(10000);
  resolveBody({error:{code:'assistant_host_unavailable',message:'The host is unavailable'}});
  await assert.rejects(pending,error=>error.status===503&&error.code==='assistant_host_unavailable');
});
