import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireLease, assertLease, releaseLease, leaseClient } from '../scripts/deploy-room-lease.mjs';
const args = { sha: 'a'.repeat(40), runId: '123', attempt: '1' };
function fixture() {
  let item = { state: 'unclaimed', owner: null, history: [], historyOmitted: 200 };
  const writes = [], saves = [];
  const request = async (action = '', body) => {
    if (action === '/claim') {
      writes.push(body);
      if (item.state !== 'unclaimed') throw new Error('conflict');
      item = { ...item, state: 'claimed', owner: 'shared-agent', claimedAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 7200000).toISOString(), history: [...item.history, { action: 'claimed', note: body.note }] };
    }
    if (action === '/release') {
      writes.push(body);
      assert.equal(body.expectedHistoryLength, item.history.length + item.historyOmitted);
      item = { ...item, state: 'unclaimed', owner: null, history: [...item.history, { action: 'released', note: body.note }] };
    }
    return structuredClone(item);
  };
  return { request, saves, writes, save: x => saves.push(x), set: x => { item = x; }, get: () => item };
}
test('exact run acquires once; duplicate acquire recovers; release retries without duplicate mutation', async () => {
  const f = fixture();
  const state = await acquireLease(f.request, args, f.save);
  assert.equal(f.saves[0].phase, 'acquiring');
  await acquireLease(f.request, args, f.save);
  assert.equal(f.writes.length, 1);
  await releaseLease(f.request, state, f.save);
  await releaseLease(f.request, state, f.save);
  assert.equal(f.writes.length, 2);
});
test('another run using the SAME credential cannot acquire or release holder', async () => {
  const f = fixture(); const state = await acquireLease(f.request, args, f.save);
  await assert.rejects(acquireLease(f.request, { ...args, runId: '124' }, f.save), /already held/);
  f.set({ ...f.get(), claimedAt: '2026-01-01T00:00:00Z' });
  await assert.rejects(releaseLease(f.request, state, f.save), /changed/);
  assert.equal(f.writes.length, 1);
});
test('uncertain claim response recovers its exact stamped input', async () => {
  const f = fixture();
  const request = async (action, body) => { const value = await f.request(action, body); if (action === '/claim') throw new Error('lost response'); return value; };
  const state = await acquireLease(request, args, f.save);
  assert.equal(state.phase, 'held'); assert.equal(f.writes.length, 1);
});
test('expired or changed lease refuses upload and release', async () => {
  const f = fixture(); const state = await acquireLease(f.request, args, f.save);
  assert.throws(() => assertLease({ ...f.get(), leaseExpiresAt: '2000-01-01T00:00:00Z' }, state), /expired/);
  assert.throws(() => assertLease({ ...f.get(), owner: 'peer' }, state), /belongs/);
});
test('Room client fails closed without existing credential and never follows credential redirects', async () => {
  assert.throws(() => leaseClient({ origin: 'https://room.test' }), /TOKEN/);
  assert.throws(() => leaseClient({ origin: 'http://room.test', token: 'fixture' }), /HTTPS/);
  let options;
  const request = leaseClient({ origin: 'https://room.test', token: 'fixture', fetchImpl: async (_url, o) => { options = o; return { ok: false, status: 409 }; } });
  await assert.rejects(request('/claim', { note: 'fixture' }), /409/);
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
});

test('workflow pins smoke and checks the lease before both uploads and recovery', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../.github/workflows/deploy-prod.yml', import.meta.url), 'utf8');
  assert.match(workflow, /ROOM_SMOKE_EXPECTED_SHA: \$\{\{ env\.SHA \}\}/);
  assert.match(workflow, /group: production-deploy\n  cancel-in-progress: false/);
  for (const name of ['Deploy canonical Worker', 'Deploy public entry Worker']) {
    const before = workflow.slice(0, workflow.indexOf(`      - name: ${name}`));
    assert.match(before.slice(before.lastIndexOf('      - name:')), /deploy-room-lease\.mjs assert/);
  }
  assert.match(workflow, /deploy-room-lease\.mjs assert[^\n]+\n          node scripts\/deploy-recovery\.mjs recover/);
  assert.match(workflow, /!cancelled\(\).*steps\.lease\.outcome == 'success'/);
});

test('unknown release retries the identical saved input; a later holder remains untouched', async () => {
  const f = fixture(); const state = await acquireLease(f.request, args, f.save);
  const attempted = [];
  const request = async (action, body) => {
    if (action === '/release') { attempted.push(body); if (attempted.length === 1) throw new Error('no response'); }
    return f.request(action, body);
  };
  await assert.rejects(releaseLease(request, state, f.save), /no response/);
  const uncertain = f.saves.at(-1);
  await releaseLease(request, uncertain, f.save);
  assert.deepEqual(attempted[0], attempted[1]);
  const next = await acquireLease(f.request, { ...args, runId: '124' }, f.save);
  await assert.rejects(releaseLease(request, uncertain, f.save), /changed/);
  assert.equal(f.get().claimedAt, next.claimedAt);
  assert.equal(f.get().state, 'claimed');
});
