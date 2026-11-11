// Intentional pre-implementation controls. Run explicitly with node --test.
// No production payloads, benchmark reruns, network calls or runtime imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomStore } from '../../server/store.mjs';
import { initialRoom } from '../../server/bootstrap.mjs';
import { replay, event } from '../../src/events.js';
import { repairLegacyMessages } from '../../server/operator-legacy-message-repair.mjs';
import { seedLegacyFixture } from '../../tests/helpers/legacy-session-fixture.mjs';
import { schema, step, digest } from '../prototypes/bounded-replay-staging.mjs';
import { messageProofMatches } from '../../server/write-integrity.mjs';

function postedRoom(t, count=12) {
  const s=new RoomStore(':memory:');t.after(()=>s.close());
  const events=[...initialRoom()];
  for(let i=0;i<count;i++)events.push(event({id:'post-'+i,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'m'+i,body:'Synthetic '+i}}));
  s.initialize(events);
  while(!s.backfillMessages({limit:200}).done){}
  s.checkMessagesParity({roomId:'commons'});
  return s;
}

test('required archive qualification rejects a changed archived event even when current archived rows and independent proofs remain healthy',t=>{
  const s=postedRoom(t);
  assert.equal(s.archiveMessages('commons',{keepNewest:1,dryRun:false}).ok,true);
  const row=s.db.prepare("SELECT * FROM messages WHERE room_id='commons' AND message_id='m0'").get();
  assert.equal(messageProofMatches(row),true);
  s.db.prepare("UPDATE events SET body=json_set(body,'$.data.body','Different synthetic journal content') WHERE room_id='commons' AND id='post-0'").run();
  // Counts, head and all serving entity proofs are unchanged. The new final
  // verifier must bind source epoch/content AND compare every archived record.
  assert.throws(()=>s.checkMessagesParity({roomId:'commons'}),/source|archiv|parity/i);
});

test('required publication does not materialize a whole room after a one-event replay allowance',t=>{
  const s=postedRoom(t,40),db=s.db;
  db.prepare("UPDATE messages_backfill_cursor SET applied_seq=0,applied_event_id='',parity_at_seq=NULL WHERE room_id='commons'").run();
  const original=db.prepare.bind(db);let largestResult=0;
  db.prepare=sql=>{const statement=original(sql);return new Proxy(statement,{get(target,key){if(key==='all')return(...args)=>{const rows=target.all(...args);largestResult=Math.max(largestResult,rows.length);return rows;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
  s.backfillMessages({limit:1});
  assert.ok(largestResult<=8,`publication materialized ${largestResult} rows; selected control budget is 8`);
});

test('required historical replay contract survives derived checkpoint loss and a later modern append',t=>{
  const s=new RoomStore(':memory:');t.after(()=>s.close());const f=seedLegacyFixture(s);
  const plan=repairLegacyMessages(s,f.request);
  repairLegacyMessages(s,{...f.request,planHash:plan.planHash,requestId:'derived-loss-control'},true);
  const key=s.issueAccessKey('legacy-room','owner');
  s.command(key,'legacy-room',{id:'modern-after-historical-prefix',type:'message.posted',data:{messageId:'later',body:'A modern synthetic append'}});
  s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='legacy-room'").run();
  s.db.prepare("DELETE FROM messages_backfill_state WHERE room_id='legacy-room'").run();
  const result=s.backfillMessages({limit:64});
  assert.equal(result.quarantined.length,0,'a proved historical prefix must not be silently re-quarantined after its disposable checkpoint is lost');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM messages_backfill_blocks WHERE room_id='legacy-room'").get().n,0);
});

test('required source binding notices a previously processed event changed behind the immediate anchor',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE rooms(id TEXT PRIMARY KEY,sequence INTEGER);CREATE TABLE events(room_id TEXT,sequence INTEGER,id TEXT,body TEXT,PRIMARY KEY(room_id,sequence));CREATE TABLE messages_backfill_cursor(room_id TEXT PRIMARY KEY,applied_seq INTEGER,applied_event_id TEXT,state_seq INTEGER,replay_event_id TEXT,parity_at_seq INTEGER);`);
  db.exec(schema);
  const {messages,eventLog,seenEvents,seenIdempotencyKeys,...metadata}=replay(initialRoom());
  const text=JSON.stringify(metadata),message=JSON.stringify({id:'m0',authorId:'owner',body:'Seed',revision:0});
  const anchor=event({id:'anchor',roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'m0',body:'Seed'}});
  db.prepare('INSERT INTO rooms VALUES(?,?)').run('commons',1);
  db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('commons',1,anchor.id,JSON.stringify(anchor));
  db.prepare('INSERT INTO messages_backfill_cursor VALUES(?,?,?,?,?,?)').run('commons',0,'',1,anchor.id,null);
  db.prepare('INSERT INTO message_replay_formats VALUES(?,1,?,?,?)').run('commons',text,digest(text),digest(JSON.stringify(anchor)));
  db.prepare('INSERT INTO message_replay_units VALUES(?,?,?,?)').run('commons','m0',message,digest(message));
  const append=n=>{const e=event({id:'edit-'+n,roomId:'commons',actorId:'owner',type:'message.edited',data:{messageId:'m0',body:'Edit '+n,expectedMessageRevision:n-2}});db.prepare('INSERT INTO events VALUES(?,?,?,?)').run('commons',n,e.id,JSON.stringify(e));db.prepare('UPDATE rooms SET sequence=?').run(n);};
  const advance=()=>{db.exec('BEGIN');try{const result=step(db,'commons');db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  append(2);assert.equal(advance().advanced,true);
  db.prepare("UPDATE events SET body=json_set(body,'$.data.body','Changed older prefix') WHERE sequence=1").run();
  append(3);
  assert.throws(advance,/source|epoch|prefix|changed/i);
});

test('modern work transition remains strict; historical handling cannot be date-based amnesty',t=>{
  const s=new RoomStore(':memory:');t.after(()=>s.close());
  s.initialize(initialRoom());const key=s.issueAccessKey('commons','owner');
  for(const [type,data]of [['work.proposed',{workItemId:'task',title:'Synthetic',definitionOfDone:'Synthetic result',accountableMemberId:'owner',mode:'read'}],['session.started',{workItemId:'task'}],['session.status_changed',{workItemId:'task',status:'active'}],['session.stopped',{workItemId:'task',status:'done'}]])s.command(key,'commons',{id:'control-'+type,type,data});
  assert.throws(()=>s.command(key,'commons',{id:'illegal-accept',type:'work.accepted',data:{workItemId:'task'}}),/Invalid transition from working/);
});
