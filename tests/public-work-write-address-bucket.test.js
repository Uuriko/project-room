// Soak S-6: the REST public-work write bucket in server/http.mjs was keyed
// on the source ADDRESS at the per-identity rate (60/min) and applied
// before authentication, so every identity behind one host/NAT shared a
// single identity's write budget — the 61st write from an address was
// refused no matter which identity sent it. Agent fleets behind one
// egress are this product's normal deployment shape.
//
// The fix demotes the http.mjs bucket to a coarse per-address BACKSTOP
// (600/min, still pre-auth, so unauthenticated floods keep paying it) and
// leaves the metering of authenticated writes to the one per-identity
// ceiling (#3271, PublicWorkClaims.enforceIdentityRateLimit, 60/min),
// which the REST door already invokes after identity resolution and
// which MCP and match share — one counter, so the doors cannot drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  store.projectOffers.create('commons', 'owner', { requestId: 'addr-create', offerId: 'addr:task', reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'JavaScript volunteer task', summary: 'Synthetic public work', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'addr:task', 'publish', { requestId: 'addr-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'addr:task', { requestId: 'addr-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.js'] });
  const first = store.identities.create('Synthetic addr one'), second = store.identities.create('Synthetic addr two');
  // Tests pick the visitor address per request, standing in for many clients.
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers['x-test-address'] || '127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  let counter = 0;
  const freshAddress = () => `10.7.${Math.floor(counter / 256) % 256}.${counter++ % 256}`;
  const write = async (taskId, secret, requestId, address) => {
    const response = await fetch(`${origin}/api/public-work/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Test-Address': address, Authorization: 'Bearer ' + secret },
      body: JSON.stringify({ requestId, expectedTermsVersion: 1 }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { store, first, second, write, freshAddress };
}

test('two identities behind one address each keep their own 60/min write allowance', async t => {
  const f = await fixture(t);
  const address = '10.9.0.1';
  // First identity: a real claim plus 59 counted failures fill its own
  // per-identity bucket to exactly 60 — none may trip an address limit.
  const claimed = await f.write('addr:task', f.first.secret, 'one-claim', address);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.action, 'claimed');
  for (let i = 0; i < 59; i++) {
    const reply = await f.write('missing-task', f.first.secret, `one-fail-${i}`, address);
    assert.equal(reply.status, 404, `first identity attempt ${i + 2}`);
    assert.equal(reply.body.error.code, 'public_work_not_found');
  }
  // Second identity, same source address: its own full 60 attempts go
  // through the door (each fails as not-found, none as rate_limited).
  // Before the fix the shared address bucket (60/min) refused the second
  // identity's very first write as the address's 61st.
  for (let i = 0; i < 60; i++) {
    const reply = await f.write('missing-task', f.second.secret, `two-fail-${i}`, address);
    assert.equal(reply.status, 404, `second identity attempt ${i + 1}`);
    assert.equal(reply.body.error.code, 'public_work_not_found');
  }
  // The first identity's 61st write is refused by the per-identity
  // ceiling — unchanged at 60/min — not by any address bucket.
  const limited = await f.write('missing-task', f.first.secret, 'one-over', address);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.equal(limited.headers.get('x-ratelimit-bucket'), 'public-work-identity');
  assert.equal(limited.headers.get('x-ratelimit-limit'), '60');
});

test('one identity rotating addresses keeps one bucket (#3271 property)', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 60; i++) {
    const reply = await f.write('missing-task', f.first.secret, `rot-fail-${i}`, f.freshAddress());
    assert.equal(reply.status, 404, `attempt ${i + 1}`);
    assert.equal(reply.body.error.code, 'public_work_not_found');
  }
  const limited = await f.write('missing-task', f.first.secret, 'rot-over', f.freshAddress());
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.equal(limited.headers.get('x-ratelimit-bucket'), 'public-work-identity');
  assert.equal(limited.headers.get('x-ratelimit-limit'), '60');
});

test('unauthenticated writes count against the address backstop, tripped only at the coarse threshold', async t => {
  const f = await fixture(t);
  const address = '10.9.0.2';
  // A well-formed but unknown credential: passes the bearer shape check,
  // resolves to no identity, and is refused 401 — after the pre-auth
  // address bucket has counted it.
  const bogus = 'A'.repeat(43);
  for (let i = 0; i < 600; i++) {
    const reply = await f.write('missing-task', bogus, `anon-${i}`, address);
    assert.equal(reply.status, 401, `unauthenticated attempt ${i + 1}`);
    assert.equal(reply.body.error.code, 'unauthenticated');
  }
  // Attempt 601 from the same address trips the backstop: bucket
  // public-work-write at the coarse 600/min ceiling.
  const limited = await f.write('missing-task', bogus, 'anon-over', address);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.equal(limited.headers.get('x-ratelimit-bucket'), 'public-work-write');
  assert.equal(limited.headers.get('x-ratelimit-limit'), '600');
  // The backstop is per address: a different source address is unaffected.
  const other = await f.write('missing-task', bogus, 'anon-other', '10.9.0.3');
  assert.equal(other.status, 401);
  assert.equal(other.body.error.code, 'unauthenticated');
});
