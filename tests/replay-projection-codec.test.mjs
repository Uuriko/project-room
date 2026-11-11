import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {projectionMessageAtRest} from '../server/projection-at-rest.mjs';
import {initialProjectionScan,scanProjectionChunk,decodeProjectionSpan,projectionMapFrame,projectionArrayFrame,REPLAY_CODEC_INPUT_BYTES,REPLAY_CODEC_CONTROL_BYTES} from '../server/replay-projection-codec.mjs';
function scan(text,size=REPLAY_CODEC_INPUT_BYTES,maximumRecords=32){
  const bytes=Buffer.from(text),out=[];let state=initialProjectionScan(),steps=0,maxControl=0,maxFetched=0;
  while(state.offset<bytes.length){
    const step=scanProjectionChunk(JSON.parse(JSON.stringify(state)),bytes.subarray(state.offset,state.offset+size),{maximumRecords});
    assert.ok(step.consumed>0||step.records.length>0,'must make honest bounded progress');
    for(const span of step.records){
      if(span.kind==='metadata-map'){out.push({...span,value:projectionMapFrame(span)});continue;}
      if(span.kind==='metadata-array'){out.push({...span,value:projectionArrayFrame(span)});continue;}
      assert.ok(span.length<=128*1024);maxFetched=Math.max(maxFetched,span.length);out.push({...span,value:decodeProjectionSpan(bytes.subarray(span.offset,span.offset+span.length),span)});
    }
    assert.ok(step.records.length<=maximumRecords);state=step.state;steps++;maxControl=Math.max(maxControl,Buffer.byteLength(JSON.stringify(state)));
  }
  assert.equal(state.phase,'done','incomplete captured JSON refuses completion');return{state,out,steps,maxControl,maxFetched};
}

test('scanner preserves byte ranges across every UTF-8/escape/container boundary',()=>{
  const source={room:{id:'synthetic',name:'🦉 \\"\n'},messages:[{id:'m0',body:'é中🦉',nested:{array:[null,true,1,{deep:'"'}]}},{id:'m1',body:'line\n\r\t\\'}],members:{owner:{role:'owner'}},scalar:42,truth:true,none:null};
  const text=JSON.stringify(source);
  for(const size of [1,2,3,7,63,64,257]){
    const result=scan(text,size,1);assert.deepEqual(result.state.keys,Object.keys(source));
    assert.deepEqual(result.out.filter(x=>x.kind==='message').map(x=>x.value),source.messages);
    for(const record of result.out.filter(x=>x.kind==='metadata'))assert.deepEqual(record.value,source[record.key]);
  }
});

test('17,405 message codec bootstrap uses constant control state and bounded records',()=>{
  const messages=Array.from({length:17405},(_,i)=>({id:'m'+i,authorId:'owner',body:'Synthetic Muse-sized body 🦉 '+i,channelId:'general',_nul:1,createdAt:'2026-01-01T00:00:00.000Z'}));
  const source={room:{id:'synthetic'},messages,members:{owner:{role:'owner'}}},text=JSON.stringify(source),result=scan(text);
  assert.ok(Buffer.byteLength(text)>2376000,'Muse-sized synthetic captured projection');
  assert.equal(result.state.messageIndex,17405);assert.ok(result.maxControl<=REPLAY_CODEC_CONTROL_BYTES);
  assert.deepEqual(result.out.filter(x=>x.kind==='message').map(x=>x.value),messages);
  assert.ok(result.steps>500);assert.ok(result.maxFetched<1000,'complete small leaves need no whole-array hydration');
});

test('one spanning maximum leaf is fetched once, without a growing persisted token buffer',()=>{
  const body='x'.repeat(128*1024-100),text=JSON.stringify({messages:[{id:'large',body}],room:{id:'synthetic'}}),result=scan(text,16384);
  assert.equal(result.out.filter(x=>x.kind==='message').length,1);assert.equal(result.out.find(x=>x.kind==='message').value.body,body);
  assert.ok(result.maxControl<1024);assert.ok(result.steps>=8);
});

for(const text of ['{"messages":[{"id":"a"},]}','{"room":{},}','{"room":{},"room":{}}','{"messages":[{"id":"a"}]}garbage','{"messages":{}}','{"messages":[null]}','{"messages":[{"id":"a","body":"'+ 'x'.repeat(128*1024)+'"}]}'])test('invalid or oversized shape refuses '+text.slice(0,35),()=>assert.throws(()=>scan(text),/codec|JSON|incomplete/));

test('input/control admission refuses oversized fields and impossible depth before progress',()=>{
  assert.throws(()=>scanProjectionChunk(initialProjectionScan(),new Uint8Array(16385)),/codec/);
  assert.throws(()=>scanProjectionChunk({...initialProjectionScan(),depth:65},new Uint8Array()),/codec/);
  assert.throws(()=>scanProjectionChunk({...initialProjectionScan(),keyBytes:Array(513).fill(1)},new Uint8Array()),/codec/);
  const invalid=Buffer.from('{"messages":[{"id":"m","body":"');assert.throws(()=>decodeProjectionSpan(Buffer.concat([invalid,Buffer.from([255]),Buffer.from('"}]}')]),{kind:'metadata',length:invalid.length+5}),/encoded|codec|JSON/);
});

for(const enabled of [false,true])test('pure shared message-at-rest transform exactly matches normal writer: enabled='+enabled,t=>{
  const s=new RoomStore(':memory:',{bodiesAtRest:enabled});t.after(()=>s.close());s.initialize(initialRoom());
  const templates=[
    {id:'short',authorId:'owner',body:'Short',workItemId:null,replyToId:null,toMemberId:null,createdAt:'now'},
    {id:'large',authorId:'owner',body:'🦉'.repeat(300),workItemId:null,replyToId:null,toMemberId:null,createdAt:'now'},
    {id:'ineligible-run',body:'x'.repeat(300),replyToId:null,workItemId:null,toMemberId:null,revision:2,editHistory:[{body:'prior',editedAt:'before'}]},
    {id:'redacted',body:null,redacted:true,workItemId:null,replyToId:null,toMemberId:null},
    {id:'receipt',body:'x'.repeat(300),kind:'receipt_card',claimId:'claim',receiptId:'rc_claim',reactions:null,revision:0}
  ];
  const state={...structuredClone(s.room('commons').state),messages:templates};
  const normal=s.transaction(()=>JSON.parse(s.storedProjection('commons',state)).messages);
  const pure=templates.map(message=>projectionMessageAtRest(message,{enabled}));
  assert.equal(JSON.stringify(pure),JSON.stringify(normal));assert.deepEqual(state.messages,templates);
});


test('reply map preserves exact parent and escaped child key framing across byte boundaries',()=>{
  const text='{"replyRequests": { "a\\u0062": {"nested":"🦉"}, "other": {"open":true} },"messages":[]}';
  const bytes=Buffer.from(text);
  for(const size of [1,2,3,7,63]){
    const result=scan(text,size,1),entries=result.out.filter(x=>x.kind==='metadata-entry');
    assert.deepEqual(entries.map(x=>x.entryKey),['ab','other']);
    assert.deepEqual(entries.map(x=>JSON.parse(bytes.subarray(x.keyOffset,x.keyOffset+x.keyLength).toString())),['ab','other']);
    const parent=result.out.find(x=>x.kind==='metadata-map');assert.equal(parent.entries,2);
    assert.equal(bytes.subarray(parent.offset,parent.offset+parent.length).toString(),'{ "a\\u0062": {"nested":"🦉"}, "other": {"open":true} }');
    assert.ok(result.maxControl<2048);
  }
});

test('fatal span decoding preserves a BOM inside a string but refuses one outside JSON',()=>{
  const valid=Buffer.from('{"body":"\ufeffinside"}');
  assert.equal(decodeProjectionSpan(valid,{kind:'metadata',length:valid.length}).body,'\ufeffinside');
  const invalid=Buffer.concat([Buffer.from([239,187,191]),Buffer.from('{"body":"outside"}')]);
  assert.throws(()=>decodeProjectionSpan(invalid,{kind:'metadata',length:invalid.length}),/JSON|Unexpected/);
});

test('growing members, channels and work maps partition into bounded addressed entries',()=>{
  for(const parent of ['members','channels','workItems']){
    const source={room:{id:'synthetic'},[parent]:Object.fromEntries(Array.from({length:180},(_,i)=>['entry-'+i,{id:'entry-'+i,text:'x'.repeat(1024)}])),messages:[]};
    const text=JSON.stringify(source);assert.ok(Buffer.byteLength(JSON.stringify(source[parent]))>131072);
    const result=scan(text,997,3);
    const entries=result.out.filter(x=>x.kind==='metadata-entry'&&x.key===parent);
    assert.equal(entries.length,180,'RED: a growing top-level map must not be one oversized token');
    assert.deepEqual(Object.fromEntries(entries.map(x=>[x.entryKey,x.value])),source[parent]);
    assert.equal(result.out.find(x=>x.kind==='metadata-map'&&x.key===parent).entries,180);
    assert.ok(result.maxFetched<2048);assert.ok(result.maxControl<=REPLAY_CODEC_CONTROL_BYTES);
  }
});

test('growing archive retainedIds partition by exact nested array position without token growth',()=>{
  const retainedIds=Array.from({length:6000},(_,i)=>'message-'+String(i).padStart(6,'0')+'-x'.repeat(12));
  const source={room:{id:'synthetic'},messagesArchive:{throughSeq:9000,count:3000,retainedIds},messages:[]};
  assert.ok(Buffer.byteLength(JSON.stringify(retainedIds))>131072);
  const result=scan(JSON.stringify(source),4093,3);
  const entries=result.out.filter(x=>x.kind==='metadata-index');
  assert.equal(entries.length,retainedIds.length,'RED: retained identities must be independently addressed instead of one oversized archive token');
  assert.deepEqual(entries.map(x=>x.value),retainedIds);
  assert.deepEqual(entries.map(x=>x.index),retainedIds.map((_,i)=>i));
  assert.equal(result.out.find(x=>x.kind==='metadata-array').entries,retainedIds.length);
  assert.equal(result.out.find(x=>x.kind==='metadata-map'&&x.key==='messagesArchive').entries,3);
  assert.ok(result.maxFetched<256);assert.ok(result.maxControl<=REPLAY_CODEC_CONTROL_BYTES);
});

for(const size of [1,2,7,63])test('nested retained framing survives escaped keys and UTF8 boundaries: '+size,()=>{
  const text='{"messagesArchive":{"throughSeq":7,"retained\\u0049ds":["first","🦉\\\"\\\\\\n","last"],"count":2},"messages":[]}';
  const result=scan(text,size,1);
  assert.deepEqual(result.out.filter(x=>x.kind==='metadata-index').map(x=>x.value),JSON.parse(text).messagesArchive.retainedIds);
  const frame=result.out.find(x=>x.kind==='metadata-array');assert.equal(frame.entryKey,'retainedIds');assert.equal(frame.entries,3);
  assert.equal(result.out.find(x=>x.kind==='metadata-map').entries,3);
});
for(const archive of [null,{retainedIds:[]},{}])test('nested archive empty/null shape remains explicit '+JSON.stringify(archive),()=>{
  const result=scan(JSON.stringify({messagesArchive:archive,messages:[]}),2,1);
  if(archive===null)assert.equal(result.out.find(x=>x.kind==='metadata').value,null);
  else if(archive.retainedIds)assert.equal(result.out.find(x=>x.kind==='metadata-array').entries,0);
});
for(const retainedIds of [{},[7],['x'.repeat(201)]])test('nested archive refuses malformed identity shape '+JSON.stringify(retainedIds).slice(0,30),()=>{
  assert.throws(()=>scan(JSON.stringify({messagesArchive:{retainedIds},messages:[]})),/codec/);
});
