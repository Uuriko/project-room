import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
const cursor=s=>s.db.prepare("SELECT * FROM messages_backfill_cursor WHERE room_id='commons'").get();
const rows=s=>s.db.prepare("SELECT * FROM messages WHERE room_id='commons' ORDER BY message_id").all();
function fixture(t){
 const dir=mkdtempSync(join(process.env.TMPDIR,'recovery-')),file=join(dir,'room.sqlite');let store=new RoomStore(file);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const seed=[...initialRoom(),...Array.from({length:80},(_,i)=>event({id:'event-'+i,roomId:'commons',actorId:'owner',type:'message.posted',data:{messageId:'m'+i,body:'body '+i}}))];
 store.initialize(seed);store.backfillMessages({limit:10});const behind={cursor:cursor(store),snapshot:store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get().state_json};
 assert.equal(store.backfillMessages({limit:400}).done,true);
 store.db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id='commons'").run();
 const token=store.issueAccessKey('commons','owner');store.command(token,'commons',{id:'tail',type:'message.posted',data:{messageId:'tail',body:'new visible tail'}});
 return {get store(){return store;},behind,reopen(){store.close();store=new RoomStore(file);}};
}
for(const kind of ['absent','malformed','digest-mismatch','behind'])test(`${kind}: bounded recovery preserves serving rows and restarts`,t=>{
 const f=fixture(t),s=f.store,published=cursor(s).applied_seq,serving=rows(s);
 if(kind==='absent')s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
 if(kind==='malformed')s.db.prepare("UPDATE message_replay_snapshots SET state_json='{' WHERE room_id='commons'").run();
 if(kind==='digest-mismatch'){
  s.db.prepare("INSERT INTO messages_backfill_state(room_id,part,json) VALUES('commons',0,'{}')").run();
  s.db.prepare("UPDATE message_replay_snapshots SET state_json='parts:1:wrong' WHERE room_id='commons'").run();
 }
 if(kind==='behind'){
  s.db.prepare("UPDATE messages_backfill_cursor SET state_seq=?,replay_event_id=? WHERE room_id='commons'").run(f.behind.cursor.state_seq,f.behind.cursor.replay_event_id);
  s.db.prepare("UPDATE message_replay_snapshots SET state_json=? WHERE room_id='commons'").run(f.behind.snapshot);
 }
 const start=kind==='behind'?10:0;
 let r=s.backfillMessages({limit:3});assert.equal(r.events,3);assert.equal(r.replaySeq,start+3,'all replay work must count toward caller limit');assert.equal(r.done,false);
 assert.equal(cursor(s).applied_seq,published);assert.deepEqual(rows(s),serving);
 f.reopen();r=f.store.backfillMessages({limit:3});assert.equal(r.replaySeq,start+6);assert.equal(cursor(f.store).applied_seq,published);assert.deepEqual(rows(f.store),serving);
 for(let i=0;i<30&&!r.done;i++)r=f.store.backfillMessages({limit:7});
 assert.equal(r.done,true);assert.equal(f.store.checkMessagesParity().ok,true);assert.equal(rows(f.store).length,81);assert.equal(rows(f.store).find(x=>x.message_id==='tail').body,'new visible tail');
 const before=rows(f.store);assert.equal(f.store.backfillMessages({limit:3}).events,0);assert.deepEqual(rows(f.store),before);
});

test('expired deadline does no replay or serving mutation',t=>{
 const f=fixture(t),s=f.store;s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
 const before=cursor(s),serving=rows(s),r=s.backfillMessages({limit:3,deadline:Date.now()-1});
 assert.equal(r.events,0);assert.equal(r.budgetExceeded,true);assert.deepEqual(cursor(s),before);assert.deepEqual(rows(s),serving);
});

test('interrupt after checkpoint persists staging without publishing',t=>{
 const f=fixture(t),s=f.store;s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
 const serving=rows(s),published=cursor(s).applied_seq,stop=new Error('synthetic interruption');
 assert.throws(()=>s.backfillMessages({limit:60,yieldBetween(){throw stop;}}),e=>e===stop);
 assert.equal(cursor(s).state_seq,25);assert.equal(cursor(s).applied_seq,published);assert.deepEqual(rows(s),serving);
 f.reopen();assert.equal(f.store.backfillMessages({limit:3}).replaySeq,28);assert.deepEqual(rows(f.store),serving);
});

test('corrupt event during snapshot rebuild is surfaced, never silently certified',t=>{
 const f=fixture(t),s=f.store;s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
 s.db.prepare("UPDATE events SET body=json_set(body,'$.type','invalid.synthetic.event') WHERE room_id='commons' AND sequence=20").run();
 const r=s.backfillMessages({limit:25});
 assert.ok(r.quarantined.some(x=>x.sequence===20)||r.blocked.length||r.failed.length,'corrupt event must be explicitly diagnosed');
 assert.equal(cursor(s).parity_at_seq,null);
 assert.equal(JSON.parse(s.db.prepare("SELECT body FROM events WHERE room_id='commons' AND sequence=20").get().body).type,'invalid.synthetic.event');
});

test('invalid positive staging anchor below serving is refused',t=>{
 const f=fixture(t),s=f.store;
 s.db.prepare("UPDATE messages_backfill_cursor SET state_seq=10,replay_event_id='wrong-anchor' WHERE room_id='commons'").run();
 s.db.prepare("UPDATE message_replay_snapshots SET state_json=? WHERE room_id='commons'").run(f.behind.snapshot);
 const r=s.backfillMessages({limit:3});assert.equal(r.replaySeq,3,'invalid checkpoint cannot be trusted');assert.equal(cursor(s).parity_at_seq,null);
});

test('live reply and second edit during rebuild remain in final serving history',t=>{
 const f=fixture(t),s=f.store,token=s.issueAccessKey('commons','owner');
 s.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
 s.backfillMessages({limit:3});
 s.command(token,'commons',{id:'reply-live',type:'message.posted',data:{messageId:'reply-live',body:'reply while recovering',replyToId:'m0'}});
 s.command(token,'commons',{id:'edit-one',type:'message.edited',data:{messageId:'m0',body:'first edit',expectedMessageRevision:0}});
 s.backfillMessages({limit:3});
 s.command(token,'commons',{id:'edit-two',type:'message.edited',data:{messageId:'m0',body:'second edit',expectedMessageRevision:1}});
 let r;for(let i=0;i<30;i++){r=s.backfillMessages({limit:7});if(r.done)break;}
 assert.equal(r.done,true);assert.equal(s.checkMessagesParity().ok,true);
 assert.equal(rows(s).find(x=>x.message_id==='m0').body,'second edit');
 assert.equal(rows(s).find(x=>x.message_id==='reply-live').reply_to_id,'m0');
 const original=s.room('commons').state.messages.find(x=>x.id==='m0');assert.equal(original.editHistory.length,2);
});
