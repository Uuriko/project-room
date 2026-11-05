import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { operatorStatus } from '../server/operator-status.mjs';

function fixture(t, bodiesAtRest = false) {
  const store = new RoomStore(':memory:', {bodiesAtRest}); t.after(() => store.close());
  store.initialize([...initialRoom('commons'), event({ type:'message.posted', actorId:'owner', roomId:'commons', id:'selected-event', at:'2026-11-01T00:00:00.000Z', data:{messageId:'selected-message', body:'PRIVATE_SELECTED_CONTENT'.repeat(bodiesAtRest ? 300 : 1)} })]);
  while (!store.backfillMessages({limit:1000}).done) { /* setup */ }
  store.checkMessagesParity({roomId:'commons'});
  return store;
}
function selected(store, expectedHead) {
  const before = store.db.prepare('SELECT total_changes() AS n').get().n;
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
  const value = operatorStatus(store, {parityRoom:'commons', expectedHead:expectedHead ?? head});
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_SELECTED_CONTENT/);
  return value.messageParityDiagnostics.rooms[0];
}
test('explicit healthy target outside failure inventory is freshly compared without writes', t => {
  const store=fixture(t); store.room=()=>{throw Error('room read prohibited');};
  const value=selected(store); assert.equal(value?.status,'clean'); assert.equal(value.complete,true); assert.equal(value.proofsVerified,true);
});
test('selected read refuses changed head', t => {
  const store=fixture(t); assert.equal(selected(store,1)?.reason,'head_changed');
});
for (const mode of ['metadata','message','missing-proof','large-control']) test(`selected read fails closed for ${mode}`,t=>{
  const store=fixture(t);
  if(mode==='metadata')store.db.exec("UPDATE rooms SET projection=json_set(projection,'$.messages[0].body','corruption')");
  if(mode==='message')store.db.exec("UPDATE messages SET body='corruption'");
  if(mode==='missing-proof')store.db.exec('UPDATE integrity_room_state SET metadata_hash=NULL');
  if(mode==='large-control')store.db.prepare('UPDATE messages_backfill_cursor SET applied_seq=?').run('x'.repeat(300000));
  const value=selected(store); assert.equal(value?.status,'unknown'); assert.equal(value.complete,false);
});
for (const mode of ['event-count','message-count','bytes','body-hash','canonical','archive','storage','blob-scalar','large-event-id']) test(`selected admission refuses ${mode} without payload reads or writes`,t=>{
  const store=fixture(t);
  if(mode==='event-count') {
    const row=store.db.prepare('SELECT * FROM events LIMIT 1').get();
    const insert=store.db.prepare(`INSERT INTO events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`);
    for(let i=0;i<65;i++)insert.run(...Object.values({...row,id:'extra-'+i,sequence:100+i}));
  }
  if(mode==='message-count') {
    const row=store.db.prepare('SELECT * FROM messages LIMIT 1').get();
    const insert=store.db.prepare(`INSERT INTO messages(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`);
    for(let i=0;i<65;i++)insert.run(...Object.values({...row,message_id:'extra-'+i}));
  }
  if(mode==='blob-scalar')store.db.exec('UPDATE rooms SET projection=CAST(projection AS BLOB)');
  if(mode==='large-event-id')store.db.prepare('UPDATE events SET id=? WHERE sequence=1').run('x'.repeat(1000));
  if(mode==='bytes')store.db.prepare('UPDATE messages SET body=?').run('😀'.repeat(70000));
  if(mode==='body-hash')store.db.prepare('INSERT INTO projection_bodies(room_id,sha,body) VALUES(?,?,?)').run('commons','a'.repeat(64),'PRIVATE_CORRUPT_BODY');
  if(mode==='canonical'||mode==='archive')store.db.prepare('UPDATE rooms SET projection=json_set(projection,?,json(?))').run(mode==='canonical'?'$.messageAuthority':'$.messagesArchive','{}');
  const prepare=store.db.prepare.bind(store.db);let payloadReads=0;
  store.db.prepare=sql=>{
    if(mode==='storage'&&sql.includes('AS nbytes'))throw Error('synthetic storage refusal');
    if(/^SELECT (?:projection FROM|sequence,projection FROM|\* FROM messages|message_id,seq,)/.test(sql))payloadReads++;
    return prepare(sql);
  };
  const value=selected(store);
  // Unreferenced orphan bodies are admitted but do not change serving parity.
  if(mode==='body-hash')assert.equal(value.status,'clean');
  else assert.equal(value.status,'unknown');
  if(['event-count','message-count','bytes','storage','blob-scalar','large-event-id'].includes(mode))assert.equal(payloadReads,0);
});

test('HTTP Operator auth and method gates precede ambiguous selector parsing and target reads',async t=>{
  const {createHash}=await import('node:crypto');
  const {createRoomServer}=await import('../server/http.mjs');
  const token='synthetic-selected-parity-operator-0123456789',prior=process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
  const store=fixture(t),server=createRoomServer({store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(prior===undefined)delete process.env.ROOM_OPERATOR_TOKEN_SHA256;else process.env.ROOM_OPERATOR_TOKEN_SHA256=prior;});
  const origin=`http://127.0.0.1:${server.address().port}`,prepare=store.db.prepare.bind(store.db);let reads=0;
  store.db.prepare=sql=>{if(/FROM (rooms|events|messages|projection_bodies|work_entities|integrity_room_state|messages_backfill_cursor)\b/.test(sql))reads++;return prepare(sql);};
  const call=(query,auth=true,method='GET')=>fetch(origin+'/api/operator/status'+query,{method,headers:{origin,...(auth?{authorization:'Operator '+token}:{})}});
  const {createOperatorRoutes}=await import('../server/operator-routes.mjs');
  const dispatch=createOperatorRoutes({store,json:()=>{},reject:(status)=>{throw Object.assign(new Error('refused'),{status});},body:async()=>({}),rate:()=>{}});
  for(const query of ['?parityRoom=&expectedHead=3','?parityRoom=commons&parityRoom=other&expectedHead=3','?parityRoom=commons&expectedHead=3&expectedHead=4','?parityRoom=commons','?expectedHead=3','?parityRoom=commons&expectedHead=03','?parityRoom=commons&expectedHead=65','?parityRoom=%20&expectedHead=3']){
    reads=0;
    await assert.rejects(dispatch({method:'GET',headers:{}},{setHeader(){}},{url:new URL(origin+'/api/operator/status'+query),remoteAddress:'127.0.0.1',requestId:'synthetic'}),error=>error.status===404);assert.equal(reads,0);
    await assert.rejects(dispatch({method:'GET',headers:{authorization:'Operator '+token}},{setHeader(){}},{url:new URL(origin+'/api/operator/status'+query),remoteAddress:'127.0.0.1',requestId:'synthetic'}),error=>error.status===422);assert.equal(reads,0);
  }
  reads=0;
  for (const headers of [{cookie:'room_session=synthetic'}, {cookie:'account_session=synthetic'}, {authorization:'Bearer placeholder-room-credential'}]) {
    await assert.rejects(dispatch({method:'GET',headers},{setHeader(){}},{url:new URL(origin+'/api/operator/status?parityRoom=&expectedHead=bad')}),error=>error.status===404);
    assert.equal(reads,0);
  }
  const configured=process.env.ROOM_OPERATOR_TOKEN_SHA256;
  delete process.env.ROOM_OPERATOR_TOKEN_SHA256;
  assert.equal(await dispatch({method:'GET',headers:{authorization:'Operator '+token}},{setHeader(){}},{url:new URL(origin+'/api/operator/status?parityRoom=&expectedHead=bad')}),false);assert.equal(reads,0);
  process.env.ROOM_OPERATOR_TOKEN_SHA256=configured;
  assert.equal((await fetch(origin+'/api/operator/status?parityRoom=&expectedHead=bad',{headers:{origin:'https://untrusted.example',authorization:'Operator '+token}})).status,403);assert.equal(reads,0);
  assert.equal((await call('?parityRoom=&expectedHead=3',false)).status,404);
  reads=0;assert.equal((await call('?parityRoom=&expectedHead=3',true,'POST')).status,405);assert.equal(reads,0);
  const head=prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
  const response=await call('?parityRoom=commons&expectedHead='+head);assert.equal(response.status,200);assert.equal((await response.json()).messageParityDiagnostics.rooms[0].status,'clean');
});

for (const mode of ['healthy','corrupt','missing']) test(`selected body-reference verification ${mode} and exactly one read transaction`,t=>{
  const store=fixture(t,true);
  assert.ok(store.db.prepare('SELECT count(*) AS n FROM projection_bodies').get().n>0);
  if(mode==='corrupt')store.db.exec("UPDATE projection_bodies SET body='PRIVATE_CORRUPT'");
  if(mode==='missing')store.db.exec('DELETE FROM projection_bodies');
  let transactions=0;const transaction=store.readTransaction.bind(store);
  store.readTransaction=fn=>{transactions++;return transaction(fn);};
  store.integrityFailures=()=>{throw Error('No global failure sample');};
  const result=selected(store);assert.equal(transactions,1);
  assert.equal(result.status,mode==='healthy'?'clean':'unknown');
});

test('selected proof uses exact protected serialization, not reserialized JSON',async t=>{
  const {projectionDigest}=await import('../server/write-integrity.mjs');
  const store=fixture(t),row=store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
  const text=JSON.stringify(JSON.parse(row.projection),null,2);
  store.transaction(()=>{store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(text);store.db.prepare("UPDATE integrity_room_state SET metadata_hash=? WHERE room_id='commons'").run(projectionDigest(text));});
  assert.equal(selected(store).status,'clean');
});

test('healthy selected room is checked even when five other failures fill the global sample',t=>{
  const store=fixture(t);
  for(let i=0;i<6;i++)store.recordIntegrityFailure('messages_parity','a'+i,new Error('synthetic recorded failure'));
  const sample=operatorStatus(store).messageParityDiagnostics;
  assert.equal(sample.rooms.length,5);assert.equal(sample.truncated,true);assert.ok(sample.rooms.every(room=>room.roomId!=='commons'));
  assert.equal(selected(store).status,'clean');
});

test('coherent message-row tamper with valid row hash and plausible cursor still mismatches protected snapshot',async t=>{
  const {messageProofHash}=await import('../server/write-integrity.mjs');
  const store=fixture(t),proof=store.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash;
  const row={...store.db.prepare("SELECT * FROM messages WHERE room_id='commons'").get(),body:'PRIVATE_COHERENT_CORRUPTION'};
  store.db.prepare('UPDATE messages SET body=?,entity_hash=? WHERE room_id=? AND message_id=?').run(row.body,messageProofHash(row),'commons',row.message_id);
  const head=store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
  const eventId=store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND sequence=?").get(head).id;
  store.db.prepare("UPDATE messages_backfill_cursor SET applied_seq=?,applied_event_id=?,parity_at_seq=? WHERE room_id='commons'").run(head,eventId,head);
  const result=selected(store);assert.equal(result.status,'mismatch');assert.equal(result.complete,true);assert.equal(result.proofsVerified,true);assert.ok(result.fields.includes('body'));assert.equal(result.mismatchedRows,1);
  assert.equal(store.db.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash,proof);
});
