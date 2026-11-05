import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { operatorMessageAuthority } from '../server/operator-message-authority.mjs';
import { createHash } from 'node:crypto';
import { createRoomServer } from '../server/http.mjs';
import { recordMessageWrite } from '../server/write-integrity.mjs';

function fixture(t, count=300) {
  const s=new RoomStore(':memory:');t.after(()=>s.close());
  const posts=Array.from({length:count},(_,i)=>event({id:'post-'+i,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'m'+i,body:'Body '+i}}));
  s.initialize([...initialRoom(),...posts]);s.initialize(initialRoom('other','other-owner'));
  const request={roomId:'commons',reason:'Bounded target preparation'};
  const plan=()=>operatorMessageAuthority(s,request);
  const prepare=(planHash,requestId='prepare-1',extra={})=>operatorMessageAuthority(s,{...request,planHash,requestId,...extra},'prepare');
  return {s,request,plan,prepare};
}
const cursor=s=>s.db.prepare("SELECT * FROM messages_backfill_cursor WHERE room_id='commons'").get();

test('prepare advances at most 200 target events, preserves another room and retries original receipt after later steps',t=>{
  const f=fixture(t),before=f.s.db.prepare("SELECT projection FROM rooms WHERE id='other'").get();
  f.s.backfillMessages=()=>{throw Error('global replay forbidden');};
  const p=f.plan(),first=f.prepare(p.planHash);
  assert.ok(first.preparation.events>0&&first.preparation.events<=200);
  assert.equal(first.preparation.caughtUp,false);
  const firstCursor=cursor(f.s);
  assert.equal(f.s.db.prepare("SELECT 1 FROM messages_backfill_cursor WHERE room_id='other'").get(),undefined);
  assert.deepEqual(f.s.db.prepare("SELECT projection FROM rooms WHERE id='other'").get(),before);
  const second=f.prepare(f.plan().planHash,'prepare-2');
  assert.ok(second.preparation.replaySeq>first.preparation.replaySeq);
  const afterSecond=cursor(f.s);
  assert.deepEqual(f.prepare(p.planHash),{...first,duplicate:true});
  assert.deepEqual(cursor(f.s),afterSecond);
  assert.notDeepEqual(firstCursor,afterSecond);
  assert.throws(()=>f.prepare(p.planHash,'prepare-1',{reason:'Changed intent'}),e=>e.code==='idempotency_conflict');
});

test('prepare receipt/audit failure rolls replay, messages and cursors back atomically',t=>{
  const f=fixture(t,20),p=f.plan();
  f.s.db.exec("CREATE TRIGGER reject_prepare BEFORE INSERT ON operator_actions WHEN NEW.action='message_authority_prepare' BEGIN SELECT RAISE(ABORT,'injected prepare receipt failure'); END");
  const before=cursor(f.s),messages=f.s.db.prepare("SELECT * FROM messages WHERE room_id='commons'").all();
  assert.throws(()=>f.prepare(p.planHash),/injected prepare receipt failure/);
  assert.deepEqual(cursor(f.s),before);
  assert.deepEqual(f.s.db.prepare("SELECT * FROM messages WHERE room_id='commons'").all(),messages);
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM message_replay_snapshots WHERE room_id='commons'").get().n,0);
});

test('prepare rejects changed source, and a completed prepare permits fresh conversion without receipt collision',t=>{
  const f=fixture(t,20),p=f.plan();
  f.s.db.prepare("INSERT INTO message_replay_snapshots VALUES('commons','{}')").run();
  assert.throws(()=>f.prepare(p.planHash),e=>e.code==='plan_changed');
  f.s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
  const prepared=f.prepare(p.planHash,'same-id');
  assert.equal(prepared.preparation.caughtUp,true);
  const next=f.plan();
  const executed=operatorMessageAuthority(f.s,{...f.request,requestId:'same-id',planHash:next.planHash},true);
  assert.equal(executed.result.changed,true);
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action IN ('message_authority_prepare','message_authority_execute')").get().n,2);
});

for(const field of ['inline-snapshot','parts-bytes','detached-bytes','parts-count','part-scalar']) {
  test(`checkpoint ${field} refuses before payload decoding`,t=>{
    const f=fixture(t,5),db=f.s.db;
    if(field==='inline-snapshot')db.prepare('INSERT INTO message_replay_snapshots VALUES(?,?)').run('commons','x'.repeat(1048577));
    if(field==='parts-bytes'||field==='detached-bytes')db.prepare('INSERT INTO messages_backfill_state VALUES(?,?,?)').run(field==='parts-bytes'?'commons':'commons\0anchor',0,'x'.repeat(1048577));
    if(field==='parts-count')for(let i=0;i<1025;i++)db.prepare('INSERT INTO messages_backfill_state VALUES(?,?,?)').run('commons',i,'');
    if(field==='part-scalar')db.prepare('INSERT INTO messages_backfill_state VALUES(?,?,?)').run('commons','x'.repeat(2097152),'');
    const prepare=db.prepare.bind(db);
    db.prepare=sql=>{
      if(/SELECT state_json FROM|SELECT room_id,part,json FROM|SELECT part,json FROM|LEFT JOIN message_replay_snapshots/.test(sql))throw Error('checkpoint payload transferred before admission');
      return prepare(sql);
    };
    assert.throws(f.plan,e=>e.code==='authority_budget_exceeded');
  });
}

for(const defect of ['torn','invalid-cursor','missing-snapshot','detached-anchor','orphan-snapshot']) {
  test(`prepare refuses ${defect} without allowing replay reset or repair`,t=>{
    const f=fixture(t,5),db=f.s.db;
    if(defect!=='orphan-snapshot')f.s.backfillMessages({limit:1});
    if(defect==='torn')db.prepare("UPDATE message_replay_snapshots SET state_json='parts:1:bad'").run();
    if(defect==='invalid-cursor')db.prepare("UPDATE messages_backfill_cursor SET replay_event_id='changed'").run();
    if(defect==='missing-snapshot')db.prepare('DELETE FROM message_replay_snapshots').run();
    if(defect==='detached-anchor')db.prepare('INSERT INTO messages_backfill_state VALUES(?,?,?)').run('commons\0anchor',-2,'[]');
    if(defect==='orphan-snapshot')db.prepare('INSERT INTO message_replay_snapshots VALUES(?,?)').run('commons','{}');
    const p=f.plan(),before=cursor(f.s),snapshots=db.prepare('SELECT * FROM message_replay_snapshots').all();
    assert.throws(()=>f.prepare(p.planHash),e=>e.code==='authority_not_ready');
    assert.deepEqual(cursor(f.s),before);
    assert.deepEqual(db.prepare('SELECT * FROM message_replay_snapshots').all(),snapshots);
  });
}

test('valid chunked checkpoint is admitted and resumes rather than replaying its prefix',t=>{
  const f=fixture(t,300);f.s.backfillMessages({limit:1});
  const state=f.s.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get().state_json;
  // Exercise the actual parts decoder without needing a large source fixture.
  const split=Math.floor(state.length/2),parts=[state.slice(0,split),state.slice(split)];
  f.s.db.prepare("UPDATE message_replay_snapshots SET state_json=? WHERE room_id='commons'").run('parts:2:'+createHash('sha256').update(state).digest('hex'));
  for(let i=0;i<2;i++)f.s.db.prepare('INSERT INTO messages_backfill_state VALUES(?,?,?)').run('commons',i,parts[i]);
  const before=cursor(f.s).state_seq,prepared=f.prepare(f.plan().planHash);
  assert.equal(prepared.preparation.replaySeq,before+200);
});

test('reducer quarantine rolls the whole prepare slice back without a block or new proof baseline',t=>{
  const f=fixture(t,20),db=f.s.db;
  db.prepare("UPDATE events SET body=json_set(body,'$.type','unknown.event') WHERE room_id='commons' AND sequence=10").run();
  const p=f.plan(),proof=db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get();
  assert.throws(()=>f.prepare(p.planHash),e=>e.code==='authority_not_ready');
  assert.equal(cursor(f.s),undefined);
  assert.equal(db.prepare("SELECT 1 FROM messages_backfill_blocks WHERE room_id='commons'").get(),undefined);
  assert.equal(db.prepare("SELECT 1 FROM messages_backfill_state WHERE room_id IN (?,?)").get('commons','commons\0anchor'),undefined);
  assert.deepEqual(db.prepare("SELECT * FROM integrity_room_state WHERE room_id='commons'").get(),proof);
});

test('historic crosspost expansion exceeding output budget rolls the whole slice back',t=>{
  const s=new RoomStore(':memory:');t.after(()=>s.close());
  const events=[...initialRoom(),event({id:'parent-post',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'parent',body:'Root'}})];
  for(let i=0;i<120;i++)events.push(event({id:'cross-'+i,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'reply-'+i,replyToId:'parent',alsoSendToChannel:true,body:'x'.repeat(5000)}}));
  for(let i=0;i<120;i++)for(const suffix of ['',':channel'])events.push(event({id:'delete-'+i+suffix,roomId:'commons',actorId:'owner',type:'message.deleted',data:{messageId:'reply-'+i+suffix,expectedMessageRevision:0}}));
  s.initialize(events);
  const request={roomId:'commons',reason:'Output expansion negative'},plan=operatorMessageAuthority(s,request);
  assert.ok(plan.domains.events.bytes<1048576);
  assert.throws(()=>operatorMessageAuthority(s,{...request,planHash:plan.planHash,requestId:'expanded'},'prepare'),e=>e.code==='authority_budget_exceeded');
  assert.equal(cursor(s),undefined);
  assert.equal(s.db.prepare("SELECT 1 FROM message_replay_snapshots WHERE room_id='commons'").get(),undefined);
});

for(const corruption of ['metadata','missing-metadata-proof','canonical-message','body']) {
  test(`prepare refuses ${corruption} serving proof corruption`,t=>{
    const f=fixture(t,5),db=f.s.db;
    if(corruption==='metadata')db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.title','unregistered change') WHERE id='commons'").run();
    if(corruption==='missing-metadata-proof')db.prepare("UPDATE integrity_room_state SET metadata_hash=NULL WHERE room_id='commons'").run();
    if(corruption==='canonical-message'){
      f.s.backfillMessages({limit:200});f.s.checkMessagesParity({roomId:'commons'});f.s.migrateMessageAuthority('commons');
      db.prepare("UPDATE messages SET body='unregistered' WHERE room_id='commons' AND message_id='m0'").run();
    }
    if(corruption==='body')db.prepare('INSERT INTO projection_bodies VALUES(?,?,?)').run('commons','a'.repeat(64),'unregistered body');
    const p=f.plan(),before=cursor(f.s);
    assert.throws(()=>f.prepare(p.planHash),e=>e.code==='authority_integrity_failure');
    assert.deepEqual(cursor(f.s),before);
  });
}

test('prepare HTTP endpoint shares operator authentication, strict input and no-store response',async t=>{
  const prior=process.env.ROOM_OPERATOR_TOKEN_SHA256,token='synthetic-prepare-operator-credential';
  process.env.ROOM_OPERATOR_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
  const f=fixture(t,20),server=createRoomServer({store:f.s});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(prior===undefined)delete process.env.ROOM_OPERATOR_TOKEN_SHA256;else process.env.ROOM_OPERATOR_TOKEN_SHA256=prior;});
  const url='http://127.0.0.1:'+server.address().port+'/api/operator/messages/authority/prepare';
  const call=(input,auth=true)=>fetch(url,{method:'POST',headers:{origin:'http://127.0.0.1:'+server.address().port,'content-type':'application/json',...(auth?{authorization:'Operator '+token}:{cookie:'operator='+token})},body:JSON.stringify(input)});
  const input={...f.request,planHash:f.plan().planHash,requestId:'http-prepare'};
  assert.equal((await call(input,false)).status,404);
  assert.equal((await call({...input,extra:true})).status,422);
  assert.equal((await call({...input,reverse:true})).status,422);
  const response=await call(input);assert.equal(response.status,200,await response.clone().text());
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.equal((await response.json()).preparation.caughtUp,true);
});

test('valid JSON staging tamper cannot publish new message proofs at the final head',t=>{
  const f=fixture(t,300),db=f.s.db;
  f.prepare(f.plan().planHash);
  db.prepare("UPDATE message_replay_snapshots SET state_json=json_set(state_json,'$.messages[0].body','Untrusted staged body') WHERE room_id='commons'").run();
  const p=f.plan(),before=cursor(f.s),messages=db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all();
  assert.throws(()=>f.prepare(p.planHash,'final-step'),e=>e.code==='authority_not_ready');
  assert.deepEqual(cursor(f.s),before);
  assert.deepEqual(db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all(),messages);
  assert.equal(db.prepare("SELECT 1 FROM operator_actions WHERE action='message_authority_prepare' AND request_id='final-step'").get(),undefined);
});

for(const control of ['rooms','events','integrity_room_state','messages_backfill_cursor']) {
  test(`unsafe stored integer in ${control} refuses through SQL admission`,t=>{
    const f=fixture(t,5);f.s.backfillMessages({limit:1});
    const column=control==='messages_backfill_cursor'?'state_seq':'sequence';
    f.s.db.prepare(`UPDATE ${control} SET ${column}=? WHERE ${control==='rooms'?'id':'room_id'}='commons'${control==='events'?" AND sequence=(SELECT MIN(sequence) FROM events WHERE room_id='commons')":''}`).run(9007199254740992n);
    assert.throws(f.plan,e=>['authority_budget_exceeded','authority_not_ready'].includes(e.code));
  });
}

for(const mode of ['canonical','reference'])for(const door of ['prepare','global'])for(const damage of ['posting-sequence','missing-row']) {
  test(`${door} preserves ${mode} serving authority against ${damage} laundering`,t=>{
    const s=new RoomStore(':memory:',{maintainMessageCertification:true,messageProjectionWindow:mode==='reference'?20:null,messageEntityProjection:mode==='reference'});
    t.after(()=>s.close());s.initialize(initialRoom());s.backfillMessages({limit:200});s.checkMessagesParity({roomId:'commons'});
    const key=s.issueAccessKey('commons','owner');
    for(let i=0;i<5;i++)s.command(key,'commons',{id:'post-'+i,type:'message.posted',data:{messageId:'m'+i,body:'Original '+i}});
    s.checkMessagesParity({roomId:'commons'});
    if(mode==='canonical')s.migrateMessageAuthority('commons');
    const db=s.db;
    db.prepare("UPDATE messages_backfill_cursor SET applied_seq=?,applied_event_id=?,state_seq=?,replay_event_id=?,parity_at_seq=NULL WHERE room_id='commons'")
      .run(damage==='posting-sequence'?0:2,damage==='posting-sequence'?'':db.prepare("SELECT id FROM events WHERE room_id='commons' AND sequence=2").get().id,
        damage==='posting-sequence'?0:2,damage==='posting-sequence'?'':db.prepare("SELECT id FROM events WHERE room_id='commons' AND sequence=2").get().id);
    if(damage==='posting-sequence') {
      db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
      s.transaction(()=>{
        // The final key set still satisfies command FKs. Defer their check
        // while constructing the raw reordered-log corruption fixture.
        db.exec('PRAGMA defer_foreign_keys=ON');
        db.prepare("UPDATE events SET sequence=2000 WHERE room_id='commons' AND sequence=3").run();
        db.prepare("UPDATE events SET sequence=3 WHERE room_id='commons' AND sequence=4").run();
        db.prepare("UPDATE events SET sequence=4 WHERE room_id='commons' AND sequence=2000").run();
      });
    } else {
      db.prepare("DELETE FROM messages WHERE room_id='commons' AND message_id='m0'").run();
      db.prepare("UPDATE events SET body=json_set(body,'$.data.body','Forged') WHERE room_id='commons' AND sequence=3").run();
    }
    const before=db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all();
    if(door==='prepare') {
      const request={roomId:'commons',reason:'Independent authority preservation negative'},plan=operatorMessageAuthority(s,request);
      assert.throws(()=>operatorMessageAuthority(s,{...request,planHash:plan.planHash,requestId:'authority-negative'},'prepare'),
        error=>['authority_integrity_failure','authority_not_ready'].includes(error.code));
    } else assert.throws(()=>s.backfillMessages({limit:200}),/reconciliation|proof|corrupt|parity/);
    assert.deepEqual(db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all(),before,'all existing serving payload/proof bytes remain untouched');
    assert.equal(db.prepare("SELECT body FROM messages WHERE room_id='commons' AND message_id='m0'").get()?.body,damage==='missing-row'?undefined:'Original 0');
  });
}

for(const mode of ['canonical','reference'])for(const door of ['prepare','global']) {
  test(`${door} retains all proven ${mode} row bytes during legitimate reconstruction`,t=>{
    const s=new RoomStore(':memory:',{maintainMessageCertification:true,messageProjectionWindow:mode==='reference'?20:null,messageEntityProjection:mode==='reference'});
    t.after(()=>s.close());s.initialize(initialRoom());s.backfillMessages({limit:200});s.checkMessagesParity({roomId:'commons'});
    const key=s.issueAccessKey('commons','owner');
    s.command(key,'commons',{id:'posted',type:'message.posted',data:{messageId:'kept',body:'Original'}});
    s.checkMessagesParity({roomId:'commons'});if(mode==='canonical')s.migrateMessageAuthority('commons');
    // Model a genuine previously code-proven representation with semantically
    // equivalent JSON spacing in both record and reducer-extra columns.
    // Replay must preserve these bytes, not manufacture a fresh normalized proof.
    s.transaction(()=>{
      const record=JSON.parse(s.db.prepare("SELECT record_json FROM messages WHERE message_id='kept'").get().record_json);
      s.db.prepare("UPDATE messages SET record_json=?,reducer_extras_json=' { } ' WHERE message_id='kept'").run(JSON.stringify(record,null,1));
      recordMessageWrite(s.db,'commons','kept');
    });
    const before=s.db.prepare("SELECT * FROM messages WHERE message_id='kept'").get();
    s.db.prepare("UPDATE messages_backfill_cursor SET applied_seq=0,applied_event_id='',state_seq=0,replay_event_id='',parity_at_seq=NULL WHERE room_id='commons'").run();
    s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
    if(door==='prepare') {
      const request={roomId:'commons',reason:'Proven representation preservation'},plan=operatorMessageAuthority(s,request);
      assert.equal(operatorMessageAuthority(s,{...request,planHash:plan.planHash,requestId:'preserve'},'prepare').preparation.caughtUp,true);
    } else assert.equal(s.backfillMessages({limit:200}).done,true);
    assert.deepEqual(s.db.prepare("SELECT * FROM messages WHERE message_id='kept'").get(),before);
  });
}

for(const stage of ['event-read','snapshot-write','parity-sql']) {
  test(`unexpected SQLite ${stage} fault escapes prepare and rolls the whole step back`,t=>{
    const f=fixture(t,stage==='snapshot-write'?300:5),db=f.s.db,p=f.plan();
    const before=cursor(f.s),messages=db.prepare("SELECT * FROM messages WHERE room_id='commons'").all();
    const prepare=db.prepare.bind(db);let injected=null;
    db.prepare=sql=>{
      const target=stage==='event-read'?sql.includes('SELECT sequence, id, body FROM events')
        :stage==='snapshot-write'?sql.includes('INSERT INTO message_replay_snapshots')
        :sql.includes('SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS lastSeq');
      if(target){try{prepare('SELECT * FROM nonexistent_authority_storage_probe').get();}catch(error){injected=error;throw error;}}
      return prepare(sql);
    };
    assert.throws(()=>f.prepare(p.planHash),error=>{assert.equal(error,injected);assert.equal(error.code,'ERR_SQLITE_ERROR');return true;});
    assert.ok(injected,'the fault must occur inside the admitted replay/parity phase');
    assert.deepEqual(cursor(f.s),before);
    assert.deepEqual(prepare("SELECT * FROM messages WHERE room_id='commons'").all(),messages);
    assert.equal(prepare("SELECT count(*) AS n FROM message_replay_snapshots WHERE room_id='commons'").get().n,0);
    assert.equal(prepare("SELECT count(*) AS n FROM operator_actions WHERE action='message_authority_prepare'").get().n,0);
  });
}

for(const door of ['prepare','global']) {
  test(`${door} propagates typed SQLite IOERR without blaming room data`,t=>{
    const f=fixture(t,5),db=f.s.db,p=f.plan(),prepare=db.prepare.bind(db);
    const fault=Object.assign(new Error('injected storage outage'),{code:'SQLITE_IOERR',errcode:10});
    db.prepare=sql=>{if(sql.includes('SELECT sequence, id, body FROM events'))throw fault;return prepare(sql);};
    assert.throws(()=>door==='prepare'?f.prepare(p.planHash):f.s.backfillMessages({limit:200}),error=>door==='prepare'
      ?error.code==='storage_unavailable'&&error.status===503&&error.cause===fault:error===fault);
    assert.equal(cursor(f.s),undefined);
    assert.equal(prepare("SELECT count(*) AS n FROM messages_backfill_blocks WHERE room_id='commons'").get().n,0);
  });
}

test('unexpected non-verdict parity exception propagates unchanged with atomic rollback',t=>{
  const f=fixture(t,5),p=f.plan(),fault=new Error('unexpected parity implementation fault');
  f.s.checkMessagesParity=()=>{throw fault;};
  assert.throws(()=>f.prepare(p.planHash),error=>error===fault);
  assert.equal(cursor(f.s),undefined);
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM messages WHERE room_id='commons'").get().n,0);
  assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM operator_actions WHERE action='message_authority_prepare'").get().n,0);
});

test('prepare HTTP reports unexpected admitted storage failure as standard 500 with operationId',async t=>{
  const prior=process.env.ROOM_OPERATOR_TOKEN_SHA256,token='synthetic-storage-fault-operator';
  process.env.ROOM_OPERATOR_TOKEN_SHA256=createHash('sha256').update(token).digest('hex');
  const f=fixture(t,5),server=createRoomServer({store:f.s});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(prior===undefined)delete process.env.ROOM_OPERATOR_TOKEN_SHA256;else process.env.ROOM_OPERATOR_TOKEN_SHA256=prior;});
  const input={...f.request,planHash:f.plan().planHash,requestId:'http-storage-fault'},prepare=f.s.db.prepare.bind(f.s.db);
  f.s.db.prepare=sql=>{if(sql.includes('SELECT sequence, id, body FROM events'))return prepare('SELECT * FROM nonexistent_authority_storage_probe');return prepare(sql);};
  const origin='http://127.0.0.1:'+server.address().port;
  const response=await fetch(origin+'/api/operator/messages/authority/prepare',{method:'POST',headers:{origin,'content-type':'application/json',authorization:'Operator '+token},body:JSON.stringify(input)});
  const body=await response.json();
  assert.equal(response.status,500);assert.equal(body.error.code,'ERR_SQLITE_ERROR');assert.match(body.operationId,/^op_/);
  assert.doesNotMatch(body.error.message,/nonexistent_authority_storage_probe|reconcil/i);
  assert.equal(cursor(f.s),undefined);
  assert.equal(prepare("SELECT count(*) AS n FROM operator_actions WHERE action='message_authority_prepare'").get().n,0);
});

test('prepare retains the existing typed storage refusal for filesystem EIO',t=>{
  const f=fixture(t,5),db=f.s.db,p=f.plan(),prepare=db.prepare.bind(db);
  const fault=Object.assign(new Error('injected filesystem outage'),{code:'EIO'});
  db.prepare=sql=>{if(sql.includes('SELECT sequence, id, body FROM events'))throw fault;return prepare(sql);};
  assert.throws(()=>f.prepare(p.planHash),error=>error.code==='storage_unavailable'&&error.status===503&&error.cause===fault);
  assert.equal(f.s.storageFailures,1,'one outer rollback counts one storage failure');
  assert.equal(cursor(f.s),undefined);
  assert.equal(prepare("SELECT count(*) AS n FROM messages_backfill_blocks WHERE room_id='commons'").get().n,0);
});
