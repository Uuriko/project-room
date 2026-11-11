import {withCurrentRoomWriter,isCurrentRoom} from '../server/current-room-repository.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {seedHistoricalNeedsMeRoom} from './helpers/historical-needs-me-room.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { observeSelectedRuns } from '../server/request-runs.mjs';
import { readAgentWork } from '../server/routes/agent-work.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';

export function fixture({legacy=false}={}) {
  const store = new RoomStore(':memory:'), rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen'), worker = store.identities.create('Worker');
  if(legacy)seedHistoricalNeedsMeRoom(store,owner,{roomId:'commons',title:'Pickup',purpose:'Test',kind:'personal'});else rooms.create(owner.secret,{roomId:'commons',title:'Pickup',purpose:'Test',kind:'personal'});
  linkWithProof(store, owner.secret, 'commons', worker, { displayName: 'Worker', permissions: [] });
  store.dmConsents.request('commons', owner.identityId, worker.identityId, 'Fixture');
  store.dmConsents.decide('commons', worker.identityId, owner.identityId, 'approve');
  const post = id => store.command(owner.secret, 'commons', { id, type: 'message.posted', data: {
    messageId: id, toMemberId: worker.identityId, requestKind: 'reply', body: 'private text' } });
  post('open');
  const request = store.replyRequests.list(worker.secret, 'commons').requests[0];
  store.requestRuns.apply(worker.secret, 'commons', { requestMessageId: 'open', attemptId: 'attempt', action: 'claim', expectedRequestRevision: request.revision, contextEventId: request.contextEventId });
  const read = (reader = readAgentWork) => reader({ store, params: { roomId: 'commons' }, req: {}, res: {}, url: new URL('https://example.invalid/api/rooms/commons/agent-work'),
    roomCredentials: () => ({ mode: 'identity', token: worker.secret, bearer: true }), expectedBinding: () => null,
    roomAuth: (selected, roomId, binding) => store.authenticate(selected.token, roomId, binding), rate() {},
    reject: (status, code, message) => { throw Object.assign(new Error(message), { status, code }); }, json: (_res, _status, value) => value });
  return { store, owner, worker, read, post };
}

for(const legacy of [false,true])test(`pickup observes selected canonical openings and validates its representation legacy=${legacy}`, t => {
  const f = fixture({legacy}); t.after(() => f.store.close());
  f.store.db.prepare("INSERT INTO request_runs VALUES(?,?,?,?,?,'delivered',?)")
    .run('commons', 'stale-opening', 'open', f.worker.identityId, 'stale-attempt', f.store.now());
  const expected = f.read();
  const prepare = f.store.db.prepare.bind(f.store.db), statements = [];
  f.store.db.prepare = sql => { statements.push(sql); return prepare(sql); };
  const room = f.store.room.bind(f.store); let roomReads = 0;
  f.store.room = (...args) => { roomReads++; return room(...args); };
  const actual = f.read();
  actual.observedAt = expected.observedAt;
  assert.deepEqual(actual, expected);
  assert.equal(roomReads,legacy?1:0,legacy?"one retained historical canonical hydration, no duplicate run-list hydration":"normalized selection never hydrates a whole room");
  assert.equal(isCurrentRoom(f.store.db,'commons'),!legacy);
  assert.equal(statements.some(sql => /SELECT \* FROM request_runs WHERE room_id=\?/.test(sql)), false);
});

test('pickup keeps fresh request closure, viewer revocation and run ownership', t => {
  const f = fixture(); t.after(() => f.store.close());
  assert.equal(f.read().runs.open.state, 'working');
  f.store.db.prepare('UPDATE request_runs SET updated_at=? WHERE room_id=?').run(f.store.now() - 120001, 'commons');
  assert.equal(f.read().runs.open.state, 'unknown');
  f.store.command(f.owner.secret, 'commons', { id: 'cancel', type: 'reply_request.cancelled', data: { requestMessageId: 'open', expectedRequestRevision: 0, reason: 'Done' } });
  assert.deepEqual(f.read().requests, []);
  assert.deepEqual(f.read().runs, {});
  f.post('second');
  f.store.identities.unlink(f.owner.secret, 'commons', f.worker.identityId);
  assert.throws(() => f.read(), error => [401, 403].includes(error.status));
});


test('historical pickup refuses a corrupt canonical message entity even when no body is returned', t => {
  const f = fixture({legacy:true}); t.after(() => f.store.close());
  f.store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.messages[0]',json(?)) WHERE id='commons'").run(JSON.stringify({id:'open',_entity:1}));
  f.store.db.prepare("UPDATE messages SET body='drift' WHERE message_id='open'").run();
  f.store._projectionCache?.clear();
  assert.throws(() => f.read(), /projection_corrupt/);
});


test('selected run query searches both primary-key columns rather than enumerating room history', t => {
  const f = fixture(); t.after(() => f.store.close());
  const requests = f.store.replyRequests.list(f.worker.secret, 'commons').requests;
  const prepare = f.store.db.prepare.bind(f.store.db); let plan;
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes('json_each(?) selected')) return statement;
    return { all: (...args) => {
      plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(...args);
      return statement.all(...args);
    } };
  };
  assert.equal(observeSelectedRuns(f.store, 'commons', requests).open.state, 'working');
  const detail = plan.map(row => row.detail).join('\n');
  assert.match(detail, /SEARCH r USING INDEX .*\(room_id=\? AND opening_id=\?\)/,
    'selected openings must drive full primary-key searches: ' + detail);
});

test('normalized pickup refuses guarded message drift, rolls back an interrupted injection and recovers exact original proof',t=>{
 const f=fixture();t.after(()=>f.store.close());const db=f.store.db,original=db.prepare("SELECT * FROM messages WHERE room_id='commons' AND message_id='open'").get(),guards=()=>db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),beforeGuards=guards(),saved=()=>Object.fromEntries(['messages','current_room_head','current_room_record_proofs','operator_actions'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 assert.throws(()=>db.prepare("UPDATE messages SET body='drift' WHERE room_id='commons' AND message_id='open'").run(),/unsupported current room writer/);assert.equal(db.prepare("SELECT body FROM messages WHERE room_id='commons' AND message_id='open'").get().body,original.body);
 const before=saved();assert.throws(()=>f.store.transaction(()=>withCurrentRoomWriter(db,'commons',()=>{db.prepare("UPDATE messages SET body='drift' WHERE room_id='commons' AND message_id='open'").run();throw Error('Interrupted synthetic corruption');})),/Interrupted synthetic corruption/);assert.deepEqual(saved(),before);assert.equal(f.read().runs.open.state,'working');
 const damage=body=>f.store.transaction(()=>withCurrentRoomWriter(db,'commons',()=>db.prepare("UPDATE messages SET body=? WHERE room_id='commons' AND message_id='open'").run(body)));
 damage('drift');assert.throws(()=>f.read(),/current_room_corrupt|message.*proof|message.*fields|projection_corrupt/);damage(original.body);assert.deepEqual(db.prepare("SELECT * FROM messages WHERE room_id='commons' AND message_id='open'").get(),original);assert.deepEqual(guards(),beforeGuards);assert.equal(f.read().runs.open.state,'working');assert.doesNotThrow(()=>auditRecovery(f.store));
});
