import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRoomQueueService } from '../client/room-queue-service.mjs';
import { RoomClientError } from '../client/room-agent.mjs';
const binding = { origin: 'https://room.example', roomId: 'room', memberId: 'receiver', threadId: '01a16245-8936-7c03-b5bf-bbad83949bb6' };
const entry = { kind: 'dm', signalId: 'signal', roomId: 'room', messageId: 'question', createdAt: 100 };
const page = pendingWakes => ({ status: 'signals_received', pendingWakes, more: false });
function fixture(t) {
  const journal = mkdtempSync(join(tmpdir(), 'room-service-'));
  t.after(() => rmSync(journal, { force: true, recursive: true }));
  const controller = new AbortController(), events = [];
  return { binding, hostId: 'host', journal, allowedSenders: ['peer'], signal: controller.signal,
    controller, events, emit: e => events.push(e),
    client: { checkConnection: async () => {}, messageThread: async id => ({ roomId: 'room', thread: { id, authorId: 'peer', toMemberId: 'receiver' } }) },
    wake: { wait: async () => page([entry]) },
    wait: async () => controller.abort(), run: async () => 'accepted' };
}
test('queues once, survives restart, never acknowledges or calls acceptance execution', async t => {
  const f = fixture(t); let calls = 0;
  f.run = async () => { calls++; return 'accepted'; };
  await runRoomQueueService(f);
  const second = new AbortController();
  await runRoomQueueService({ ...f, signal: second.signal, wait: async () => second.abort() });
  assert.equal(calls, 1);
  assert.equal(f.events.find(e => e.status === 'queued').execution, 'not_observed');
});
test('uncertain delivery survives restart without a second queue write', async t => {
  const f = fixture(t); let calls = 0;
  f.run = async () => { calls++; throw new Error('unknown'); };
  await runRoomQueueService(f);
  const second = new AbortController();
  await runRoomQueueService({ ...f, signal: second.signal, wait: async () => second.abort() });
  assert.equal(calls, 1); assert.ok(f.events.some(e => e.status === 'attention_required'));
});
test('503 backs off and later dispatches without exiting service', async t => {
  const f = fixture(t); let reads = 0, waits = 0, calls = 0;
  f.wake.wait = async () => { if (!reads++) throw new RoomClientError(503, 'service_unavailable', 'down'); return page([entry]); };
  f.wait = async ms => { if (!waits++) assert.equal(ms, 1000); else f.controller.abort(); };
  f.run = async () => { calls++; return 'accepted'; };
  await runRoomQueueService(f); assert.equal(calls, 1);
});
test('contended listener never reads source or queues', async t => {
  const f = fixture(t);
  f.wake.wait = async () => ({ status: 'listener_contended' });
  f.client.messageThread = async () => assert.fail('read'); f.run = async () => assert.fail('queued');
  await runRoomQueueService(f);
});
test('revoked access exits instead of retry storm', async t => {
  const f = fixture(t);
  f.wake.wait = async () => { throw new RoomClientError(403, 'forbidden', 'private'); };
  f.wait = async () => assert.fail('retry');
  await assert.rejects(runRoomQueueService(f), /private/);
});
test('wrong sender, recipient, deleted source and historical events cannot dispatch', async t => {
  for (const patch of [{ authorId: 'stranger' }, { toMemberId: 'other' }, { deletedAt: 'now' }]) {
    const f = fixture(t); f.run = async () => assert.fail('queued');
    f.client.messageThread = async id => ({ roomId: 'room', thread: { id, authorId: 'peer', toMemberId: 'receiver', ...patch } });
    await runRoomQueueService(f);
  }
  const f = fixture(t); f.minCreatedAt = 101; f.run = async () => assert.fail('queued'); await runRoomQueueService(f);
});
test('lost fence immediately before queue prevents execution', async t => {
  const f = fixture(t); let calls = 0;
  f.wake.wait = async () => ++calls === 1 ? page([entry]) : ({ status: 'listener_contended' });
  f.run = async () => assert.fail('queued'); await runRoomQueueService(f);
  assert.ok(f.events.some(e => e.status === 'attention_required'));
});
test('pagination reaches a later eligible message', async t => {
  const f = fixture(t); let calls = 0;
  f.wake.wait = async ({ cursor }) => cursor === null ? { ...page([]), more: true, nextCursor: 'next' } : page([entry]);
  f.run = async () => { calls++; return 'accepted'; };
  await runRoomQueueService(f); assert.equal(calls, 1);
});
test('answered formal request is not queued again', async t => {
  const f = fixture(t);
  f.client.messageThread = async id => ({ roomId: 'room', thread: { id, authorId: 'peer', toMemberId: 'receiver', requestKind: 'reply' } });
  f.client.replyContext = async () => ({ request: { status: 'answered', recipientId: 'receiver' } });
  f.run = async () => assert.fail('queued'); await runRoomQueueService(f);
});
test('bounded batches continue past page limit without starving later work', async t => {
  const f=fixture(t); let rounds=0,calls=0;
  f.maxPages=1;
  f.wake.wait=async ({cursor}) => cursor===null ? {...page([]),more:true,nextCursor:'later'} : page([entry]);
  f.wait=async()=>{if(++rounds>=3)f.controller.abort();};
  f.run=async()=>{calls++;return 'accepted';};
  await runRoomQueueService(f);assert.equal(calls,1);
});
test('dispatch budget does not skip the remainder of a page', async t => {
  const f=fixture(t);let rounds=0,calls=0;
  f.maxDispatches=1;
  f.wake.wait=async()=>page([entry,{...entry,signalId:'second',messageId:'second-question'}]);
  f.wait=async()=>{if(++rounds>=3)f.controller.abort();};
  f.run=async()=>{calls++;return 'accepted';};
  await runRoomQueueService(f);assert.equal(calls,2);
});
test('abort during transient backoff is a clean shutdown', async t => {
  const f=fixture(t);
  f.wake.wait=async()=>{throw new RoomClientError(503,'unavailable','down');};
  f.wait=async()=>{f.controller.abort();throw new Error('aborted');};
  await runRoomQueueService(f);assert.equal(f.events.at(-1).status,'stopped');
});
test('expired deadline never creates an orphan rejected fetch', async () => {
  const { serviceFetch }=await import('../scripts/run-room-queue-service.mjs');
  const host=new AbortController(), request=new AbortController();
  request.abort(new DOMException('expired','TimeoutError'));
  let calls=0;
  const fetch=serviceFetch(host.signal,()=>{calls++;return Promise.reject(new Error('orphan'));});
  assert.throws(()=>fetch('https://room.example',{signal:request.signal}),/expired/);
  assert.equal(calls,0);
});

test('delivery evidence survives polling, retry, restart, and a later accepted delivery', async t => {
  const { createStatusPublisher } = await import('../scripts/run-room-queue-service.mjs');
  const f = fixture(t), file = join(f.journal, 'status.json');
  let clock = 100;
  let publish = createStatusPublisher(f.journal, binding, () => clock);
  publish({ status: 'attention_required', transportStatus: 'unknown', signalId: 'uncertain' });
  clock++;
  publish({ status: 'queued', transportStatus: 'accepted', signalId: 'accepted' });
  publish({ status: 'listening' });
  publish = createStatusPublisher(f.journal, binding, () => clock);
  publish({ status: 'retrying' });
  const state = JSON.parse(readFileSync(file));
  assert.equal(state.status, 'retrying');
  assert.equal(state.lastUncertainDelivery.signalId, 'uncertain');
  assert.equal(state.lastUncertainDelivery.observedAt, 100);
  assert.equal(state.lastAcceptedDelivery.signalId, 'accepted');
  assert.equal(state.execution, 'not_observed');
  publish = createStatusPublisher(f.journal, { ...binding, memberId: 'different' }, () => clock);
  publish({ status: 'connecting' });
  assert.equal(JSON.parse(readFileSync(file)).lastAcceptedDelivery, null);
});
test('damaged diagnostic status cannot block startup or invent execution', async t => {
  const { createStatusPublisher } = await import('../scripts/run-room-queue-service.mjs');
  const f = fixture(t), file = join(f.journal, 'status.json');
  writeFileSync(file, '{broken', { mode: 0o600 });
  createStatusPublisher(f.journal, binding)({ status: 'listening', execution: 'finished' });
  assert.equal(JSON.parse(readFileSync(file)).execution, 'not_observed');
});

test('alternating replay receipts do not refresh or replace delivery evidence', async t => {
  const { createStatusPublisher } = await import('../scripts/run-room-queue-service.mjs');
  const f = fixture(t), file = join(f.journal, 'status.json');
  let clock = 100;
  let publish = createStatusPublisher(f.journal, binding, () => clock);
  publish({ status: 'queued', transportStatus: 'accepted', signalId: 'a' });
  clock = 200;
  publish({ status: 'queued', transportStatus: 'accepted', signalId: 'b' });
  const original = JSON.parse(readFileSync(file)).lastAcceptedDelivery;
  publish = createStatusPublisher(f.journal, binding, () => clock);
  for (const signalId of ['a', 'b', 'a', 'b']) {
    clock++;
    publish({ status: 'queued', transportStatus: 'accepted', signalId, duplicate: true });
  }
  assert.deepEqual(JSON.parse(readFileSync(file)).lastAcceptedDelivery, original);
  clock++;
  publish({ status: 'queued', transportStatus: 'accepted', signalId: 'c', duplicate: false });
  assert.equal(JSON.parse(readFileSync(file)).lastAcceptedDelivery.signalId, 'c');
});

test('duplicate backlog needs no repeated source reads while new work keeps all checks', async t => {
  const f = fixture(t); let round = 0, reads = 0, checks = 0, dispatches = 0;
  const old = Array.from({ length: 20 }, (_, i) => ({ ...entry, signalId: `s${i}`, messageId: `m${i}` }));
  f.maxDispatches = 20;
  f.wake.wait = async () => page(round ? [...old, { ...entry, signalId: 'new', messageId: 'new' }] : old);
  f.client.messageThread = async id => { reads++; return { roomId: 'room', thread: { id, authorId: 'peer', toMemberId: 'receiver' } }; };
  f.client.checkConnection = async () => { checks++; };
  f.run = async () => { dispatches++; return 'accepted'; };
  f.wait = async () => { if (!round++) { reads = 0; checks = 0; } else f.controller.abort(); };
  await runRoomQueueService(f);
  assert.equal(dispatches, 21);
  assert.equal(reads, 2); assert.equal(checks, 1);
  assert.equal(f.events.filter(e => e.metrics).at(-1).metrics.replaySkipped, 20);
});
test('bounded backlog batches yield immediately without an idle sleep', async t => {
  const f = fixture(t); f.maxPages = 1;
  f.wake.wait = async () => ({ ...page([]), more: true, nextCursor: 'more' });
  f.wait = async ms => { assert.equal(ms, 0); f.controller.abort(); };
  await runRoomQueueService(f);
});

test('cached uncertain outcome suppresses repeated network work and never retries dispatch', async t => {
  const f = fixture(t); let rounds = 0, executions = 0, reads = 0;
  f.run = async () => { executions++; return 'unknown'; };
  f.client.messageThread = async id => { reads++; return {roomId:'room',thread:{id,authorId:'peer',toMemberId:'receiver'}}; };
  f.wait = async () => { if (++rounds === 3) f.controller.abort(); };
  await runRoomQueueService(f);
  assert.equal(executions, 1); assert.equal(reads, 2);
});
test('changed pointer cannot hide behind suppression cache', async t => {
  const f = fixture(t); let round = 0;
  f.wake.wait = async () => page([{...entry, messageId: round ? 'changed' : entry.messageId}]);
  f.wait = async () => { round++; };
  await assert.rejects(runRoomQueueService(f), /pointer_conflict/);
});
