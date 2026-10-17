import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resumeAgent } from '../client/agent-resume.mjs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

const connection = { origin: 'http://127.0.0.1:1234', roomId: 'commons', memberId: 'worker', token: 'A'.repeat(43) };
const version = 'b'.repeat(64);
const context = { contractVersion: 1, roomId: 'commons', viewerId: 'worker', viewerAccountId: null, viewerAuthEpoch: null,
  viewerSessionBinding: null, viewerSessionRevision: null, context_version: version, evaluatedThrough: 10,
  cursors: { roomSequence: 10, caughtUp: 0 }, roster: [{ id: 'worker', kind: 'agent', active: true, permissions: [] }], focusWork: [], locks: [] };
const run = { id: 'ask', status: 'working', revision: 3, attemptId: 'attempt', sourceMessageId: 'opening', coordinatorMemberId: 'worker',
  inputs: [{ sourceMessageId: 'opening', status: 'applied', body: 'SECRET' }, { sourceMessageId: 'steer', status: 'pending', body: 'SECRET' }],
  answerDraft: { body: 'SECRET' }, activity: [{ summary: 'SECRET' }] };
const listing = { contractVersion: 1, roomId: 'commons', assistant: { coordinatorMemberId: 'worker', revision: 1, availability: 'connected' }, runs: [run] };
function transport(overrides = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    const value = String(url).endsWith('/assistant') ? (overrides.listing ?? listing)
      : calls.length === 1 ? (overrides.initial ?? context) : (overrides.final ?? { ...context, not_modified: true });
    return value instanceof Response ? value : Response.json(value);
  } };
}

test('assistant focus returns only assigned live references with three read-only requests', async () => {
  const f = transport({ listing: { ...listing, runs: [run, { ...run, id: 'foreign', coordinatorMemberId: 'peer' }, { ...run, id: 'finished', status: 'done' }] } });
  const out = await resumeAgent({ connection, focus: 'assistant', fetchImpl: f.fetchImpl });
  assert.equal(out.connection.status, 'credential_accepted');
  assert.deepEqual(out.assignedRuns, [{ id: 'ask', status: 'working', revision: 3, attemptId: 'attempt', sourceMessageId: 'opening', sourceDeleted: false, inputCount: 2, pendingInputMessageIds: ['steer'] }]);
  assert.equal(out.sharedAssistant.selectedForThisAgent, true);
  assert.equal(out.sharedAssistant.execution, 'not_observed');
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
  assert.deepEqual(out.incompleteSources, []);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(c => c.options.method === 'GET' && !c.options.body && !c.url.includes('needs-me')));
  assert.ok(out.nextReads.some(r => r.tool === 'room_assistant_context'));
});
test('same room version never suppresses current Stop state or deleted-source recovery references', async () => {
  const f = transport({ listing: { ...listing, runs: [{ ...run, status: 'cancel_requested', sourceDeleted: true, inputs: [] }] } });
  const out = await resumeAgent({ connection, focus: 'assistant', sinceVersion: version, fetchImpl: f.fetchImpl });
  assert.equal(out.assignedRuns[0].status, 'cancel_requested');
  assert.equal(out.assignedRuns[0].sourceDeleted, true);
  assert.equal(out.authoritySummary, null);
  assert.equal(out.observedThroughBySource.assistant.currentRead, true);
});
test('fresh authorization denial erases collected assistant state', async () => {
  const f = transport({ final: Response.json({}, { status: 403 }) });
  const out = await resumeAgent({ connection, focus: 'assistant', fetchImpl: f.fetchImpl });
  assert.deepEqual(out.assignedRuns, []); assert.equal(out.sharedAssistant, null);
  assert.deepEqual(out.nextReads, []); assert.deepEqual(out.observedThroughBySource, {});
});
test('wrong identity stops before assistant read', async () => {
  const f = transport({ initial: { ...context, viewerId: 'other' } });
  const out = await resumeAgent({ connection, focus: 'assistant', fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 1); assert.equal(out.sharedAssistant, null);
});
test('cross-room, malformed, and oversized assistant responses fail closed with explicit partial status', async () => {
  for (const bad of [{ ...listing, roomId: 'other' }, { ...listing, runs: [{ ...run, revision: -1 }] }, { ...listing, runs: Array(101).fill(run) }]) {
    const f = transport({ listing: bad });
    const out = await resumeAgent({ connection, focus: 'assistant', fetchImpl: f.fetchImpl });
    assert.deepEqual(out.assignedRuns, []); assert.equal(out.sharedAssistant, null);
    assert.equal(out.incompleteSources[0].source, 'assistant');
  }
});
test('full server window is explicitly incomplete rather than claiming all assignments were read', async () => {
  const f = transport({ listing: { ...listing, runs: Array.from({ length: 100 }, (_, n) => ({ ...run, id: `run-${n}` })) } });
  const out = await resumeAgent({ connection, focus: 'assistant', fetchImpl: f.fetchImpl });
  assert.equal(out.assignedRuns.length, 100);
  assert.ok(out.incompleteSources.some(x => x.code === 'run_window_limit'));
});
test('real HTTP queued, working, draft, and Stop remain visible without resume mutations', async t => {
  const f = createAcceptanceFixture({ dmConsent: true });
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (actor, input) => {
    const response = await fetch(`${origin}/api/rooms/commons/assistant`, { method: 'POST', headers: { authorization: `Bearer ${f.keys[actor]}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), ...input }) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  await api('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: 'opening', body: 'SECRET human request' } });
  await api('owner', { action: 'invoke', runId: 'ask', sourceMessageId: 'opening' });
  const read = async sinceVersion => {
    const before = f.store.db.prepare('SELECT count(*) n FROM room_assistant_ops').get().n;
    const out = await resumeAgent({ connection: { origin, roomId: 'commons', memberId: 'producer', token: f.keys.producer }, focus: 'assistant', sinceVersion });
    assert.deepEqual(out.incompleteSources, []); assert.equal(JSON.stringify(out).includes('SECRET'), false);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM room_assistant_ops').get().n, before);
    return out;
  };
  const queued = await read(); assert.equal(queued.assignedRuns[0].status, 'queued');
  await api('producer', { action: 'claim', runId: 'ask', attemptId: 'host', expectedRevision: 0 });
  await api('producer', { action: 'draft', runId: 'ask', attemptId: 'host', expectedRevision: 1, sequence: 1, body: 'SECRET draft' });
  const working = await read(queued.contextVersion); assert.equal(working.assignedRuns[0].status, 'working');
  assert.equal(working.contextVersion, queued.contextVersion);
  await api('owner', { action: 'pause', runId: 'ask', expectedAttemptId: 'host' });
  const stopped = await read(queued.contextVersion); assert.equal(stopped.assignedRuns[0].status, 'pause_requested');
  assert.equal(stopped.assignedRuns[0].attemptId, 'host');
});
