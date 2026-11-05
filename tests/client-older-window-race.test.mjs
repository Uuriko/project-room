import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomClient} from '../src/client.js';

const owner={roomId:'commons',viewerId:'human',viewerAccountId:'account',viewerAuthEpoch:0,viewerSessionBinding:'binding'};
const message=(id,body=id)=>({id,body,authorId:'human',channelId:'general',replyToId:null});
const window=(sequence,cursor,messages)=>({...owner,snapshotVersion:2,sequence,state:{messages},messagesWindow:{mode:'recent',omitted:null,complete:false},messagesPage:{cursor,limit:100,hasMore:true}});
const page=(messages)=>({...owner,mode:'replace',messages,nextCursor:null});
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
function fixture(t){
 let snapshot=window(1,'older-1',[message('new')]);const pending=[],seen=[],requested=[];let started=deferred();
 const client=new RoomClient({lazyHistory:true,onSnapshot:value=>seen.push(value),fetcher:async url=>{
  if(url==='/api/rooms/commons?messages=recent'||url==='/api/rooms/commons')return{ok:true,status:200,json:async()=>snapshot};
  assert.match(url,/^\/api\/rooms\/commons\/conversation\?cursor=older-[123]&limit=100$/);
  const hold=deferred();pending.push(hold);requested.push(url);started.resolve();return{ok:true,status:200,json:()=>hold.promise};
 }});
 client.session={account:{id:'account',authEpoch:0},member:{id:'human'},roomId:'commons',sessionBinding:'binding'};
 t.after(()=>client.disconnect());
 return{client,pending,seen,requested,nextRequest:()=>started.promise,resetRequest:()=>{started=deferred();},replace:async(sequence,cursor,messages)=>{snapshot=window(sequence,cursor,messages);await client.refresh();}};
}

test('v2 older page retries a replaced window once without losing newer messages or showing stale rows',async t=>{
 const f=fixture(t);await f.client.refresh();const reading=f.client.pageOlder();await f.nextRequest();
 await f.replace(2,'older-2',[message('new','edited'),message('newest')]);f.resetRequest();
 f.pending[0].resolve(page([message('stale-private')]));
 // A deterministic turn boundary lets the bounded retry issue its request.
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.requested.length,2,'the reader gesture must retry the current cursor after snapshot replacement');
 assert.match(f.requested[1],/cursor=older-2/);
 f.pending[1].resolve(page([message('older'),message('new','obsolete')]));
 assert.equal(await reading,true);assert.deepEqual(f.seen.at(-1).state.messages.map(m=>[m.id,m.body]),[['older','older'],['new','edited'],['newest','newest']]);
 assert.equal(f.client.owesHistory,false);assert.equal(f.seen.some(s=>s.state.messages.some(m=>m.id==='stale-private')),false);
});

test('v2 older page stops after one retry and keeps its current cursor visible under repeated replacement',async t=>{
 const f=fixture(t);await f.client.refresh();const reading=f.client.pageOlder();await f.nextRequest();
 await f.replace(2,'older-2',[message('newest')]);f.pending[0].resolve(page([message('stale-first')]));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.requested.length,2);await f.replace(3,'older-3',[message('latest')]);f.pending[1].resolve(page([message('stale-second')]));
 assert.equal(await reading,false);assert.equal(f.requested.length,2);assert.equal(f.client.owesHistory,true);
 assert.equal(f.client.live.snapshot.messagesPage.cursor,'older-3');assert.deepEqual(f.seen.at(-1).state.messages.map(m=>m.id),['latest']);
});

test('v2 older page never retries or publishes after the session changes',async t=>{
 const f=fixture(t);await f.client.refresh();const reading=f.client.pageOlder();await f.nextRequest();
 f.client.session={...f.client.session,sessionBinding:'different'};f.pending[0].resolve(page([message('private-old-session')]));
 assert.equal(await reading,false);assert.equal(f.requested.length,1);assert.equal(f.seen.length,1);
});

test('one loadHistory gesture publishes older messages after an intervening refresh',async t=>{
 const f=fixture(t);await f.client.refresh();assert.equal(f.client.loadHistory(),true);await f.nextRequest();
 await f.replace(2,'older-2',[message('newest')]);f.pending[0].resolve(page([message('discarded')]));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.requested.length,2);f.pending[1].resolve(page([message('older')]));
 for(let turn=0;turn<20&&f.client.paging;turn++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.client.paging,false);assert.deepEqual(f.seen.at(-1).state.messages.map(m=>m.id),['older','newest']);assert.equal(f.client.owesHistory,false);
});

test('retried older page still refuses a mismatched viewer binding',async t=>{
 const f=fixture(t);await f.client.refresh();const reading=f.client.pageOlder();await f.nextRequest();
 await f.replace(2,'older-2',[message('newest')]);f.pending[0].resolve(page([message('discarded')]));await new Promise(resolve=>setImmediate(resolve));
 f.pending[1].resolve({...page([message('wrong-viewer')]),viewerSessionBinding:'wrong'});
 await assert.rejects(reading);assert.equal(f.client.session,null);assert.equal(f.requested.length,2);
 assert.equal(f.seen.some(s=>s?.state?.messages?.some(m=>m.id==='wrong-viewer')),false);
});
