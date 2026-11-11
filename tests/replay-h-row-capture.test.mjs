import test from 'node:test';
import assert from 'node:assert/strict';
import { withCurrentRoomWriter } from '../server/current-room-repository.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { MESSAGE_PROOF_SELECT, messageProofMatches } from '../server/write-integrity.mjs';
import { replayCutoverSchema, captureReplayWitness, readReplayHMessage, readReplayHMessagePage } from '../server/replay-cutover.mjs';

// Synthetic trigger probes use the same transactional room scope as serving
// writers. Unscoped/old writers must remain rejected after capture admission.
function scopedProbe(store, operation) {
  const result = store.transaction(() => withCurrentRoomWriter(store.db, 'commons', operation));
  assert.deepEqual({ ...store.db.prepare('SELECT enabled,room_id,receipt_id FROM current_room_writer_permit').get() },
    { enabled: 0, room_id: null, receipt_id: null });
  return result;
}

function fixture(t, body = 'Independently proved original', beforeCapture = () => {}) {
  const store = new RoomStore(':memory:', { maintainMessageCertification: true });
  t.after(() => store.close());
  store.initialize([...initialRoom(), event({
    id: 'before-capture', roomId: 'commons', actorId: 'owner', type: 'message.posted',
    data: { messageId: 'existing', body }
  })]);
  while (!store.backfillMessages({ limit: 200 }).done) {}
  store.checkMessagesParity({ roomId: 'commons' });
  const key = store.issueAccessKey('commons', 'owner');
  const current = () => store.db.prepare(
    `SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages WHERE room_id=? AND message_id=?`
  ).get('commons', 'existing');
  const original = current();
  assert.equal(messageProofMatches(original), true, 'fixture starts with independent valid proof');
  beforeCapture(store);
  store.db.exec(replayCutoverSchema());
  const captured = captureReplayWitness(store, {
    roomId: 'commons', requestId: 'capture', expectedHead: store.headSequence('commons'),
    reason: 'Synthetic current-state H-row consistency'
  });
  const unit = (domain, id = 'existing') => store.db.prepare(
    'SELECT payload FROM message_replay_units WHERE room_id=? AND generation=? AND domain=? AND unit_key=?'
  ).get('commons', captured.generation, domain, id);
  const edit = (revision, body) => store.command(key, 'commons', {
    id: 'edit-' + revision, type: 'message.edited',
    data: { messageId: 'existing', body, expectedMessageRevision: revision }
  });
  return { store, key, original, captured, current, unit, edit };
}

test('a post-H edit preserves the exact independently proved H row before overwrite', t => {
  const f = fixture(t);
  f.edit(0, 'Current T differs from H');
  assert.equal(f.current().body, 'Current T differs from H');
  assert.equal(messageProofMatches(f.current()), true);
  const shadow = f.unit('h-message');
  assert.ok(shadow, 'RED: mutable current T must not substitute for the missing H row');
  assert.deepEqual(JSON.parse(Buffer.from(shadow.payload).toString('utf8')), { ...f.original });
});

test('successive post-H edits retain the first H fields and proof, never an intermediate T', t => {
  const f = fixture(t);
  f.edit(0, 'Intermediate T');
  f.edit(1, 'Later T');
  const shadow = f.unit('h-message');
  assert.ok(shadow, 'RED: H row needs one durable first-change capture');
  assert.deepEqual(JSON.parse(Buffer.from(shadow.payload).toString('utf8')), { ...f.original });
  assert.equal(f.current().body, 'Later T');
  assert.equal(messageProofMatches(f.current()), true);
});

test('a post-H insertion records independently distinguishable absence at H', t => {
  const f = fixture(t);
  f.store.command(f.key, 'commons', {
    id: 'after-capture', type: 'message.posted',
    data: { messageId: 'new-after-h', body: 'This ID was absent at H' }
  });
  assert.ok(f.unit('h-message-absent', 'new-after-h'),
    'RED: current membership alone cannot distinguish an ID introduced after H');
  assert.equal(f.unit('h-message', 'new-after-h'), undefined);
});

test('an actual shadow-write storage failure rolls back the enclosing serving edit', t => {
  const f = fixture(t);
  f.store.db.exec(`CREATE TRIGGER synthetic_h_capture_storage_failure
    BEFORE INSERT ON message_replay_units WHEN NEW.domain='h-message'
    BEGIN SELECT RAISE(ABORT,'synthetic dependency storage failure'); END`);
  const head = f.store.headSequence('commons');
  assert.throws(() => f.edit(0, 'Must roll back'), /synthetic dependency storage failure/);
  assert.equal(f.store.headSequence('commons'), head);
  assert.deepEqual(f.current(), f.original);
});


function readH(f, messageId = 'existing', generation = f.captured.generation, roomId = 'commons') {
  return readReplayHMessage(f.store, { roomId, generation, messageId });
}

test('H reader validates the immutable old proof rather than a later valid current row', t => {
  const f = fixture(t);
  f.edit(0, 'Valid current T');
  assert.deepEqual(readH(f).row, { ...f.original });
  const replacement = Buffer.from(JSON.stringify(f.current()));
  f.store.db.prepare(`UPDATE message_replay_units SET payload=?,payload_bytes=?
    WHERE generation=? AND domain='h-message' AND unit_key='existing'`)
    .run(replacement, replacement.length, f.captured.generation);
  assert.equal(messageProofMatches(f.current()), true);
  assert.throws(() => readH(f), /independent replay H-row proof changed/);
});

test('insert then proof update permanently remains absent at H', t => {
  const f = fixture(t);
  f.store.command(f.key, 'commons', { id:'new', type:'message.posted',
    data:{messageId:'new-after-h',body:'New current row'} });
  assert.equal(readH(f, 'new-after-h').absent, true);
  scopedProbe(f.store, () => f.store.db.prepare(`UPDATE messages SET entity_hash=entity_hash
    WHERE room_id='commons' AND message_id='new-after-h'`).run());
  assert.equal(readH(f, 'new-after-h').absent, true);
  assert.equal(f.unit('h-message', 'new-after-h'), undefined);
});

test('proof-only updates preserve old proof bytes without rewriting current authority', t => {
  const f = fixture(t);
  scopedProbe(f.store, () => f.store.db.prepare(`UPDATE messages SET entity_hash=entity_hash
    WHERE room_id='commons' AND message_id='existing'`).run());
  assert.deepEqual(readH(f).row, { ...f.original });
  assert.deepEqual(f.current(), f.original);
});

test('a message key move preserves old H membership and records new-key H absence', t => {
  const f = fixture(t);
  scopedProbe(f.store, () => f.store.db.prepare(`UPDATE messages SET message_id='moved'
    WHERE room_id='commons' AND message_id='existing'`).run());
  assert.deepEqual(readH(f).row, { ...f.original });
  assert.equal(readH(f, 'moved').absent, true);
});

test('cross-room raw moves are refused and both active generations stay intact', t => {
  const f = fixture(t);
  f.store.initialize(initialRoom('other'));
  const other = captureReplayWitness(f.store, { roomId:'other', requestId:'capture-other',
    expectedHead:2, reason:'Synthetic second-room consistency' });
  const move = () => f.store.db.prepare(`UPDATE messages SET room_id='other'
    WHERE room_id='commons' AND message_id='existing'`).run();
  assert.throws(move, /unsupported current room writer/);
  assert.throws(() => scopedProbe(f.store, move), /unsupported current room writer/);
  assert.deepEqual(f.current(), f.original);
  assert.equal(f.store.db.prepare("SELECT 1 FROM messages WHERE room_id='other' AND message_id='existing'").get(), undefined);
  assert.deepEqual(readH(f).row, { ...f.original });
  assert.throws(() => readH(f, 'existing', other.generation, 'other'), /unchanged H row admission required/,
    'a refused move cannot create an authoritative absence marker');
  assert.equal(f.store.db.prepare("SELECT 1 FROM message_replay_units WHERE generation=? AND domain='h-message-absent' AND unit_key='existing'").get(other.generation), undefined);
});

test('legal oversized old row abandons derived capture without rejecting ordinary edit', t => {
  const f = fixture(t, 'x'.repeat(65536));
  f.edit(0, 'Smaller current body');
  assert.equal(f.current().body, 'Smaller current body');
  assert.equal(messageProofMatches(f.current()), true);
  assert.equal(f.unit('h-message'), undefined);
  assert.throws(() => readH(f), /replay capture abandoned/);
  const saved = f.store.db.prepare(`SELECT counts_json FROM operator_actions
    WHERE action='replay_cutover_abandon'`).get();
  assert.equal(JSON.parse(saved.counts_json).reason, 'dependency_admission');
});

test('explicit message deletion purges first-H old edited bodies and shared witness bytes', t => {
  const f = fixture(t);
  f.edit(0, 'Edited body before explicit deletion');
  assert.ok(f.unit('h-message'));
  f.store.command(f.key, 'commons', { id:'delete-current',type:'message.deleted',
    data:{messageId:'existing',expectedMessageRevision:1} });
  assert.equal(f.store.db.prepare(`SELECT 1 FROM message_replay_units
    WHERE generation=?`).get(f.captured.generation), undefined,
    'privacy erasure must remove the entire affected raw generation, not only invalidate it');
  assert.equal(f.store.db.prepare(`SELECT 1 FROM operator_actions WHERE counts_json LIKE ?`)
    .get('%Independently proved original%'), undefined, 'immutable receipts never contain raw body');
});


test('missing old entity proof abandons rather than adopting a later code-owned proof', t => {
  const f = fixture(t, 'Legacy proof missing', store => {
    store.db.prepare("UPDATE messages SET entity_hash=NULL WHERE room_id='commons'").run();
  });
  f.edit(0, 'Prospective current content');
  assert.equal(messageProofMatches(f.current()), true);
  assert.equal(f.unit('h-message'), undefined);
  assert.throws(() => readH(f), /replay capture abandoned/);
});

test('malformed two-MiB numeric control is refused before H payload capture', t => {
  const f = fixture(t, 'Control admission', store => {
    store.db.prepare("UPDATE messages SET seq=? WHERE room_id='commons'").run('x'.repeat(2 * 1024 * 1024));
  });
  // Raw SQL is intentional here: ordinary command validation already refuses
  // this corrupt row. The capture trigger must independently guard its control.
  scopedProbe(f.store, () => f.store.db.prepare("UPDATE messages SET body='Changed' WHERE room_id='commons'").run());
  assert.equal(f.unit('h-message'), undefined);
  assert.throws(() => readH(f), /replay capture abandoned/);
  const receipt = f.store.db.prepare(`SELECT counts_json FROM operator_actions
    WHERE action='replay_cutover_abandon'`).get().counts_json;
  assert.ok(Buffer.byteLength(receipt) < 1024);
});

test('an untouched H row uses its existing proof and indexed source admission',t=>{
  const f=fixture(t);const read=readH(f);assert.equal(read.unchanged,true);
  assert.deepEqual(read.row,{...f.original});assert.ok(read.inputBytes<=262144);assert.equal(read.certified,false);
});
test('a missing copied H row never falls back to its valid later current row',t=>{
  const f=fixture(t);f.edit(0,'Valid current T');
  f.store.db.prepare("DELETE FROM message_replay_units WHERE domain='h-message'").run();
  assert.equal(messageProofMatches(f.current()),true);
  assert.throws(()=>readH(f),/missing independently bound H row/);
});
test('untouched H source with missing proof refuses instead of deriving a new proof',t=>{
  const f=fixture(t,'Legacy unproved current row',store=>store.db.prepare("UPDATE messages SET entity_hash=NULL WHERE room_id='commons'").run());
  assert.throws(()=>readH(f),/unchanged H row admission required/);
});

test('bounded H membership merges current and first-H ranges without post-H IDs or duplicate keys',t=>{
  const f=fixture(t);const original=f.original;
  f.edit(0,'Current value differs');
  for(let i=0;i<24;i++)f.store.command(f.key,'commons',{id:'new-'+i,type:'message.posted',data:{messageId:'new-'+String(i).padStart(2,'0'),body:'Post H'}});
  scopedProbe(f.store, () => f.store.db.prepare("UPDATE messages SET message_id='moved' WHERE message_id='existing'").run());
  const all=[];let after='',done=false,pages=0,examined=0;
  while(!done&&pages++<20){
    const page=readReplayHMessagePage(f.store,{roomId:'commons',generation:f.captured.generation,after,limit:7});
    assert.ok(page.inputBytes<=262144);assert.ok(page.logicalUnitRows<=200);assert.ok(page.examined<=7);
    assert.ok(page.after>after||page.done);after=page.after;done=page.done;examined+=page.examined;all.push(...page.rows);
  }
  assert.equal(done,true);assert.equal(examined,26);assert.deepEqual(all,[{key:'existing',row:{...original}}]);
});
test('bounded H membership refuses oversized corrupt keys before returning row payload',t=>{
  const f=fixture(t);scopedProbe(f.store, () => f.store.db.prepare("INSERT INTO messages(room_id,message_id,seq,author_id,created_at) VALUES('commons',?,3,'owner','now')").run(Buffer.alloc(2*1024*1024,97)));
  assert.throws(()=>readReplayHMessagePage(f.store,{roomId:'commons',generation:f.captured.generation,after:'',limit:16}),/key admission required/);
});
