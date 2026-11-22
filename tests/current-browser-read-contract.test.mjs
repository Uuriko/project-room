import test from'node:test';import assert from'node:assert/strict';import{RoomStore}from'../server/store.mjs';import{initialRoom}from'../server/bootstrap.mjs';import{event}from'../src/events.js';import{createRoomServer}from'../server/http.mjs';import{RoomClient}from'../src/client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chargeCurrentReadBudget, withCurrentReadContext } from '../server/current-room-repository.mjs';
async function fixture(t, extraEvents = [], { reopen = false } = {}) {
  const directory = reopen ? mkdtempSync(join(tmpdir(), 'room-browser-reopen-')) : null;
  const database = directory ? join(directory, 'room.sqlite') : ':memory:';
  let s = new RoomStore(database);
  let server;
  t.after(async () => {
    server?.closeStreams();
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    s.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const events = initialRoom();
  events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
    data: { memberId: 'worker', displayName: 'worker', kind: 'agent', permissions: [] } }));
  events.push(event({ roomId: 'commons', actorId: 'owner', type: 'member.added',
    data: { memberId: 'other', displayName: 'other', kind: reopen ? 'human' : 'agent', permissions: [] } }));
  for (let i = 0; i < 32; i++) events.push(event({ id: 'public-event-' + i, roomId: 'commons', actorId: 'owner',
    type: 'message.posted', data: { messageId: 'public-' + i, body: 'Saved ' + i } }));
  events.push(event({ id: 'hidden-event', roomId: 'commons', actorId: 'worker', type: 'message.posted',
    data: { messageId: 'hidden', body: 'SECRET other private request', toMemberId: 'other', requestKind: 'reply', requestPolicyVersion: 1 } }));
  events.push(event({ id: 'visible-event', roomId: 'commons', actorId: 'worker', type: 'message.posted',
    data: { messageId: 'visible', body: 'Useful request', toMemberId: 'owner', requestKind: 'reply', requestPolicyVersion: 1 } }));
  s.initialize([...events, ...extraEvents], { representation: 'normalized-current-v1' });
  const created = s.createSession(s.issueAccessKey('commons', 'owner'));
  const other = reopen ? s.createSession(s.issueAccessKey('commons', 'other')) : null;
  if (reopen) {
    s.close();
    s = new RoomStore(database);
  }
  s.room = () => { throw Error('full hydration'); };
  server = createRoomServer({ store: s });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const sessionFetcher = token => (path, opts = {}) =>
    fetch(origin + path, { ...opts, headers: { ...opts.headers, Cookie: 'room_session=' + token } });
  return { s, created, fetcher: sessionFetcher(created.token), otherFetcher: other && sessionFetcher(other.token) };
}
test('actual activity window carries complete channels and explicitly partial events and selected request metadata',async t=>{const{fetcher}=await fixture(t),r=await fetcher('/api/rooms/commons?messages=recent',{headers:{'X-Project-Room-Audit-View':'activity-v1'}});assert.equal(r.status,200);const v=await r.json();assert.equal(v.auditView,'activity');assert.equal(v.channelsWindow.complete,true);assert.equal(v.state.channels.general.id,'general');assert.ok(Array.isArray(v.state.eventLog));assert.equal(v.eventsWindow.complete,false);assert.equal(v.sections.replyRequests.complete,false);assert.equal(v.sections.replyRequests.coverage,'visible-conversation-records');assert.deepEqual(Object.keys(v.state.replyRequests),['visible']);assert.doesNotMatch(JSON.stringify(v),/SECRET|hidden-event/);});
test('browser event windows and addressed deep reads preserve viewer binding and private event absence',async t=>{const{created,fetcher}=await fixture(t),client=new RoomClient({fetcher});client.session={...created.session,authMode:'room',csrf:null};const seen=[];client.onSnapshot=v=>seen.push(v);await client.refresh();const page=await client.recordPage({after:0});assert.equal(page.viewerId,'owner');assert.ok(page.events.length<=16);assert.ok(page.next>0);const selected=await client.recordPage({eventId:'public-event-0'});assert.equal(selected.events[0].event.id,'public-event-0');const hidden=await fetcher('/api/rooms/commons/events?view=browser&eventId=hidden-event');assert.equal(hidden.status,404);for(const query of ['view=bad','view=browser&eventId=public-event-0&after=0','view=browser&limit=17'])assert.equal((await fetcher('/api/rooms/commons/events?'+query)).status,422);const ordinary=await(await fetcher('/api/rooms/commons/events?after=0&limit=16')).json();assert.equal(Object.hasOwn(ordinary,'viewerId'),false);client.disconnect();});
test('actual browser client consumes normalized request v2 to a qualified answer basis',async t=>{const{created,fetcher}=await fixture(t),client=new RoomClient({fetcher});client.session={...created.session,authMode:'room',csrf:null};const selected=await client.replyContext('visible');assert.equal(selected.contractVersion,2);assert.equal(selected.sourceWindow.complete,true);assert.equal(selected.current.actions.answer,true);assert.equal(selected.current.answerBasis.contextEventId,'visible-event');client.disconnect();});

test('reply metadata pressure leaves the room window and an exact request read available', async t => {
  const post = (id, data) => event({ id, roomId: 'commons', actorId: 'worker', type: 'message.posted', data });
  const { s, created, fetcher, otherFetcher } = await fixture(t, [
    post('budget-event', { messageId: 'budget-request', body: 'Another authorized request', toMemberId: 'owner',
      requestKind: 'reply', requestPolicyVersion: 1 }),
    ...Array.from({ length: 16 }, (_, i) => post('hidden-context-' + i, { messageId: 'hidden-context-' + i,
      body: 'SECRET unrelated context', toMemberId: 'other', replyToId: 'budget-request' })),
    post('final-context', { messageId: 'final-context', body: 'Use the corrected evidence.', toMemberId: 'owner',
      replyToId: 'budget-request' }),
  ], { reopen: true });
  const prepare = s.db.prepare.bind(s.db);
  let exhaustions = 0, unexpectedFailure = false;
  s.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT revision,present,payload_sha256,receipt_id FROM current_room_record_proofs')) return statement;
    return { get(...args) {
      if (args[1] === 'replyRequests' && args[2] === 'budget-request') {
        withCurrentReadContext(s.db, 'commons', budget => {
          if (budget.maxRecords !== 1024) return;
          if (unexpectedFailure) throw new TypeError('unrelated lookup failure');
          exhaustions++;
          chargeCurrentReadBudget(budget, 256 * 1024, 0);
        });
      }
      return statement.get(...args);
    } };
  };
  const response = await fetcher('/api/rooms/commons?messages=recent');
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.sections.replyRequests.coverage, 'partial-visible-conversation-records');
  assert.equal(snapshot.sections.replyRequests.complete, false);
  assert.equal(exhaustions, 1);
  assert.deepEqual(Object.keys(snapshot.state.replyRequests), ['visible']);
  assert.ok(snapshot.state.messages.some(message => message.id === 'visible'));
  assert.ok(snapshot.state.messages.some(message => message.id === 'budget-request'));
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|hidden-event/);
  unexpectedFailure = true;
  const failed = await fetcher('/api/rooms/commons?messages=recent');
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error.code, 'internal_error');
  unexpectedFailure = false;

  const contextPath = '/api/rooms/commons/reply-context?limit=50&requestMessageId=';
  const denied = await otherFetcher(contextPath + 'budget-request');
  const absent = await otherFetcher(contextPath + 'no-such-request');
  assert.equal(denied.status, 404);
  assert.equal(absent.status, 404);
  assert.deepEqual((await denied.json()).error, (await absent.json()).error);

  let dropFirstContinuation = true;
  const pages = [];
  const client = new RoomClient({ fetcher: async (path, options) => {
    const reply = await fetcher(path, options);
    const { page, current } = await reply.clone().json();
    pages.push({ start: page.cursor === null, more: page.hasMore, basis: current.answerBasis,
      ids: page.items.map(item => item.message.id) });
    if (dropFirstContinuation && page.cursor !== null) throw new TypeError('first continuation lost');
    return reply;
  } });
  t.after(() => client.disconnect());
  client.session = { ...created.session, authMode: 'room', csrf: null };
  await assert.rejects(client.replyContext('budget-request'), /first continuation lost/);
  dropFirstContinuation = false;
  const selected = await client.replyContext('budget-request');
  assert.deepEqual(pages.map(({ start, more, ids }) => ({ start, more, ids })), [
    { start: true, more: true, ids: ['budget-request'] },
    { start: false, more: true, ids: [] },
    { start: true, more: true, ids: ['budget-request'] },
    { start: false, more: true, ids: [] },
    { start: false, more: false, ids: ['final-context'] },
  ]);
  assert.ok(pages.slice(0, -1).every(page => page.basis === null));
  assert.equal(selected.current.answerBasis.contextEventId, 'final-context');
  assert.equal(exhaustions, 1);
});
