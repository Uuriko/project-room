import test from 'node:test';
import assert from 'node:assert/strict';
import {initialProjectionScan,scanProjectionChunk,initialRecoveryProjectionScan,scanRecoveryProjectionChunk,decodeRecoveryProjectionSpan,recoveryProjectionFrame,REPLAY_CODEC_INPUT_BYTES,REPLAY_CODEC_CONTROL_BYTES} from '../server/replay-projection-codec.mjs';
function scan(value,{size=REPLAY_CODEC_INPUT_BYTES,maximumRecords=32}={}){
 const bytes=Buffer.from(JSON.stringify(value)),records=[];let cursor=initialRecoveryProjectionScan(bytes.length),maxControl=0,calls=0;
 while(cursor.offset<bytes.length){
  const next=scanRecoveryProjectionChunk(JSON.parse(JSON.stringify(cursor)),bytes.subarray(cursor.offset,cursor.offset+size),{maximumRecords});
  assert.ok(next.consumed>0||next.records.length>0);assert.ok(next.records.length<=maximumRecords);
  for(const span of next.records){const frame=['metadata-map','metadata-array'].includes(span.kind);records.push({...span,value:frame?recoveryProjectionFrame(span,bytes.length):decodeRecoveryProjectionSpan(bytes.subarray(span.offset,span.offset+span.length),span,bytes.length)});}
  cursor=next.state;calls++;maxControl=Math.max(maxControl,Buffer.byteLength(JSON.stringify(cursor)));
 }
 assert.equal(cursor.phase,'done');assert.ok(maxControl<=REPLAY_CODEC_CONTROL_BYTES);return{records,cursor,calls,maxControl,bytes:bytes.length};
}
test('restore-only sealed scan partitions journals, auxiliary maps and event log across cold cursors',()=>{
 const source={room:{id:'r'},seenEvents:{'evt\\"🦉':'fingerprint\n🦉',old:'second'},seenIdempotencyKeys:{same:'old'},helpOffers:{offer:{body:'🦉'}},agentHalts:{agent:{active:true}},bonds:{bond:{value:7}},eventLog:[{id:'a',nested:['é',null]},'legacy bookkeeping'],messages:[{id:'m',body:'🦉'}],messagesArchive:{retainedIds:['m']}};
 for(const size of [1,2,3,7,16384]){const result=scan(source,{size,maximumRecords:1});
  for(const domain of ['seenEvents','seenIdempotencyKeys','helpOffers','agentHalts','bonds']){const entries=result.records.filter(r=>r.kind==='metadata-entry'&&r.key===domain);assert.deepEqual(Object.fromEntries(entries.map(r=>[r.entryKey,r.value])),source[domain]);assert.equal(result.records.find(r=>r.kind==='metadata-map'&&r.key===domain).entries,entries.length);}
  assert.deepEqual(result.records.filter(r=>r.kind==='array-entry').map(r=>r.value),source.eventLog);assert.deepEqual(result.records.filter(r=>r.kind==='message').map(r=>r.value),source.messages);
 }
});
test('legal checkpoint beyond cutover4MiB and individual128KiB limits remains byte framed',()=>{
 const source={room:{id:'r'},seenEvents:Object.fromEntries(Array.from({length:1000},(_,i)=>['e'+i,'x'.repeat(5000)])),seenIdempotencyKeys:{},messages:[{id:'m',body:'🦉'.repeat(40000)}]};
 const result=scan(source);assert.ok(result.bytes>4*1024*1024);assert.ok(result.calls>300);assert.equal(result.records.filter(r=>r.key==='seenEvents'&&r.kind==='metadata-entry').length,1000);assert.deepEqual(result.records.find(r=>r.kind==='message').value,source.messages[0]);
 assert.ok(result.maxControl<2048);assert.throws(()=>scanProjectionChunk(initialProjectionScan(),new Uint8Array(16385)),/codec/); // input itself exceeds16KiB
 const old=initialProjectionScan();assert.throws(()=>scanProjectionChunk({...old,offset:4*1024*1024+1},new Uint8Array()),/codec/);
});
test('sealed source framing cannot be used by old cutover scanner or escape source bounds',()=>{
 const bytes=Buffer.from('{"room":{}}'),state=initialRecoveryProjectionScan(bytes.length);
 assert.throws(()=>scanProjectionChunk(state,bytes),/codec/);assert.throws(()=>scanRecoveryProjectionChunk(initialProjectionScan(),bytes),/codec/);
 assert.throws(()=>scanRecoveryProjectionChunk({...state,sourceBytes:2},bytes),/codec/);
 assert.throws(()=>decodeRecoveryProjectionSpan(Buffer.from('{}'),{kind:'metadata',offset:10,length:2},11),/codec/);
 assert.throws(()=>recoveryProjectionFrame({kind:'metadata-map',key:'unknown',offset:0,length:2,entries:0},2),/codec/);
 assert.throws(()=>initialRecoveryProjectionScan(Number.MAX_SAFE_INTEGER+1),/codec/);
});
test('malformed checkpoint framing and malformed complete leaves cannot grant completion',()=>{
 for(const text of ['{"eventLog":[1,]}','{"seenEvents":[],"messages":[]}','{"room":{},"room":{}}']){const bytes=Buffer.from(text);let cursor=initialRecoveryProjectionScan(bytes.length);assert.throws(()=>{while(cursor.offset<bytes.length)cursor=scanRecoveryProjectionChunk(cursor,bytes.subarray(cursor.offset,cursor.offset+16384)).state;},/codec/);}
 assert.throws(()=>decodeRecoveryProjectionSpan(Buffer.from('nope'),{kind:'metadata',offset:0,length:4},4),/JSON|Unexpected/);
});
