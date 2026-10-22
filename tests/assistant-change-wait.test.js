// Real RoomStore transactions and HTTP auth own cursor/reconnect boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { RoomAssistant, waitForAssistantChange } from '../server/room-assistant.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

function fixture(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  t.after(() => f.store.close());
  const assistant = new RoomAssistant(f.store);
  const auth = () => f.store.authenticate(f.keys.owner, 'commons');
  const apply = input => assistant.apply('commons', { requestId: randomUUID(), ...input }, auth);
  apply({ action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  const read = () => assistant.list('commons', auth);
  const wait = (after = read().changeCursor, options) => waitForAssistantChange(assistant, 'commons', auth, after, options);
  return { ...f, assistant, auth, apply, read, wait };
}

test('assistant-only invoke and resume wake subscribed readers without appending room events', async t => {
  const f = fixture(t), head = f.store.headSequence('commons');
  let waiting = f.wait();
  f.apply({ action: 'invoke', runId: 'wake', sourceMessageId: 'test-welcome' });
  assert.equal((await waiting).runs[0].status, 'queued');
  f.apply({ action: 'pause', runId: 'wake', expectedRevision: 0 });
  waiting = f.wait();
  f.apply({ action: 'resume', runId: 'wake', expectedRevision: 1 });
  assert.equal((await waiting).runs[0].status, 'queued');
  assert.equal(f.store.headSequence('commons'), head);
});

test('reconnect catches changes before subscribing and a new assistant instance has the same cursor', async t => {
  const f = fixture(t), before = f.read().changeCursor;
  f.apply({ action: 'invoke', runId: 'wake', sourceMessageId: 'test-welcome' });
  const current = await f.wait(before);
  assert.notEqual(current.changeCursor, before);
  assert.equal(new RoomAssistant(f.store).list('commons', f.auth).changeCursor, current.changeCursor);
});

test('receipt replay and rolled-back operations cannot advance the reconciliation cursor', async t => {
  const f = fixture(t);
  const input = { action: 'invoke', requestId: randomUUID(), runId: 'wake', sourceMessageId: 'test-welcome' };
  f.apply(input);
  const before = f.read().changeCursor;
  f.apply(input);
  assert.equal(f.read().changeCursor, before);
  assert.throws(() => f.store.transaction(() => { f.apply({ action: 'pause', runId: 'wake', expectedRevision: 0 }); throw Error('rollback'); }), /rollback/);
  assert.equal((await f.wait(before, { timeoutMs: 10 })).changeCursor, before);
  assert.equal(f.read().runs[0].status, 'queued');
});

test('waiting authorization is rechecked on wake and on timeout', async t => {
  const f = fixture(t);
  let revoked = false;
  const authorize = () => { if (revoked) throw Object.assign(Error('revoked'), { status: 401 }); return f.auth(); };
  let pending = waitForAssistantChange(f.assistant, 'commons', authorize, f.read().changeCursor, { timeoutMs: 20 });
  revoked = true;
  await assert.rejects(pending, { status: 401 });
  revoked = false;
  pending = waitForAssistantChange(f.assistant, 'commons', authorize, f.read().changeCursor);
  revoked = true;
  f.apply({ action: 'invoke', runId: 'wake', sourceMessageId: 'test-welcome' });
  await assert.rejects(pending, { status: 401 });
});

test('aborting releases subscriptions and per-credential capacity', async t => {
  const f = fixture(t), controllers = Array.from({ length: 3 }, () => new AbortController());
  const waits = controllers.map(controller => f.wait(undefined, { signal: controller.signal, credentialHash: 'same' }).catch(e => e));
  assert.throws(() => f.wait(undefined, { credentialHash: 'same' }), { code: 'stream_limit' });
  controllers.forEach(controller => controller.abort());
  await Promise.all(waits);
  assert.equal(f.store._appendListeners.size, 0);
  await f.wait(undefined, { credentialHash: 'same', timeoutMs: 1 });
  assert.equal(f.store._appendListeners.size, 0);
});

test('real HTTP wait validates cursor and delivers assistant-only state through the agent client', async t => {
  const f = fixture(t), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new RoomAgentClient({ version: 1, origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer });
  const before = await client.assistant();
  const waiting = client.waitForAssistantChange(before.changeCursor);
  f.apply({ action: 'invoke', runId: 'http-wake', sourceMessageId: 'test-welcome' });
  assert.equal((await waiting).runs[0].id, 'http-wake');
  const response = await fetch(`${origin}/api/rooms/commons/assistant?after=invalid`, { headers: { authorization: `Bearer ${f.keys.producer}` } });
  assert.equal(response.status, 422);
});

// Independent regressions supplied by the other Mac after reviewing this patch.
test('persisted change without local hint is reconciled at bounded wait expiry',async t=>{
 const f=fixture(t);
 f.apply({action:'invoke',runId:'wake',sourceMessageId:'test-welcome'});
 // Drain the original write hint before starting the wait.
 await new Promise(resolve=>setImmediate(resolve));
 const before=f.read().changeCursor;
 const pending=waitForAssistantChange(f.assistant,'commons',f.auth,before,{timeoutMs:25});
 const row=JSON.parse(f.store.db.prepare('SELECT value FROM room_assistant_runs WHERE room_id=? AND run_id=?').get('commons','wake').value);
 row.status='paused';row.revision++;
 // Simulate a persisted writer whose in-process notification did not reach this reader.
 f.store.db.prepare('UPDATE room_assistant_runs SET value=? WHERE room_id=? AND run_id=?').run(JSON.stringify(row),'commons','wake');
 const result=await pending;assert.equal(result.runs[0].status,'paused');assert.notEqual(result.changeCursor,before);
 assert.equal(f.store._appendListeners.size,0);
});
test('two notified readers still cannot reserve the same execution twice',async t=>{
 const f=fixture(t),before=f.read().changeCursor;
 const waits=[1,2].map(n=>waitForAssistantChange(f.assistant,'commons',f.auth,before,{credentialHash:String(n)}));
 f.apply({action:'invoke',runId:'wake',sourceMessageId:'test-welcome'});
 const snapshots=await Promise.all(waits);
 const auth=()=>f.store.authenticate(f.keys.producer,'commons');
 const claims=snapshots.map((s,i)=>()=>f.assistant.apply('commons',{action:'claim',requestId:randomUUID(),runId:'wake',expectedRevision:s.runs[0].revision,attemptId:`attempt-${i}`},auth));
 claims[0]();assert.throws(claims[1],e=>e.code==='assistant_revision_conflict');
 assert.equal(f.read().runs[0].attemptId,'attempt-0');
 assert.equal(f.store._appendListeners.size,0);
});
