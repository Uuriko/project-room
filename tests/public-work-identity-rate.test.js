// #3271: the per-identity public-work claim ceiling (60/min) used to exist
// only on the direct REST claim door. The MCP door and the match door with
// autoClaim:true performed the same claims with only per-IP buckets, so one
// identity rotating source IPs had an unbounded claim rate. All doors now
// converge on the one ceiling inside PublicWorkClaims (act / match), so
// these tests drive each door over real HTTP with a fresh source address
// per attempt — the per-IP buckets can never be what trips. The bucket
// lives on PublicWorkClaims and is invoked by the doors (REST act route,
// MCP act tools, match's claim site); direct in-process act() calls are
// not a door and are not counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  store.projectOffers.create('commons', 'owner', { requestId: 'rate-create', offerId: 'rate:task', reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'JavaScript volunteer task', summary: 'Synthetic public work', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'rate:task', 'publish', { requestId: 'rate-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'rate:task', { requestId: 'rate-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.js'] });
  const first = store.identities.create('Synthetic rate one'), second = store.identities.create('Synthetic rate two');
  // Tests pick the visitor address per request, standing in for many clients.
  const server = createRoomServer({ store, resolveClientAddress: req => req.headers['x-test-address'] || '127.0.0.1' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  let counter = 0;
  const freshAddress = () => `10.7.${Math.floor(counter / 256) % 256}.${counter++ % 256}`;
  const restClaim = async (taskId, secret, requestId) => {
    const response = await fetch(`${origin}/api/public-work/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Test-Address': freshAddress(), Authorization: 'Bearer ' + secret },
      body: JSON.stringify({ requestId, expectedTermsVersion: 1 }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const mcpClaim = async (taskId, secret, requestId) => {
    const response = await fetch(origin + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Address': freshAddress(), Authorization: 'Bearer ' + secret },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'rate-id', method: 'tools/call', params: { name: 'public_work_claim', arguments: { taskId, requestId, expectedTermsVersion: 1 } } }),
    });
    return { status: response.status, body: await response.json() };
  };
  const matchAutoClaim = async (secret, requestId) => {
    const response = await fetch(origin + '/api/public-work/match', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Test-Address': freshAddress(), Authorization: 'Bearer ' + secret },
      body: JSON.stringify({ autoClaim: true, requestId, skills: ['JavaScript'] }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { store, first, second, restClaim, mcpClaim, matchAutoClaim };
}
const mcpValue = reply => reply.body.result.structuredContent;

test('MCP door: claims within the per-identity ceiling succeed, beyond it are rate_limited even from a fresh IP', async t => {
  const f = await fixture(t);
  // Within the ceiling a real claim still succeeds through MCP.
  const claimed = await f.mcpClaim('rate:task', f.first.secret, 'mcp-claim-ok');
  assert.equal(mcpValue(claimed).action, 'claimed');
  // 59 more authenticated attempts (failing claims for a missing task count,
  // as they did on the direct REST door) fill the identity bucket to 60.
  for (let i = 0; i < 59; i++) {
    const reply = await f.mcpClaim('missing-task', f.first.secret, `mcp-fail-${i}`);
    assert.equal(mcpValue(reply).code, 'public_work_not_found', `attempt ${i + 2}`);
  }
  // Attempt 61, from yet another fresh address, hits the identity ceiling
  // with the same shape the direct REST door produces.
  const limited = await f.mcpClaim('missing-task', f.first.secret, 'mcp-over');
  assert.equal(mcpValue(limited).status, 429);
  assert.equal(mcpValue(limited).code, 'rate_limited');
  // A different identity from a fresh address keeps its own allowance.
  const other = await f.mcpClaim('missing-task', f.second.secret, 'mcp-other');
  assert.equal(mcpValue(other).code, 'public_work_not_found');
});

test('match autoClaim door: claims within the per-identity ceiling succeed, beyond it are rate_limited even from a fresh IP', async t => {
  const f = await fixture(t);
  // The ceiling counts claims, not searches: a match that finds nothing
  // claimable performs no claim and burns nothing, so this test stocks 61
  // distinct claimable tasks (disjoint files, so no claimed task's files
  // overlap-filter the rest) and every autoClaim below really claims one.
  for (let i = 1; i <= 60; i++) {
    const offerId = `rate:task-${i}`;
    f.store.projectOffers.create('commons', 'owner', { requestId: `rate-create-${i}`, offerId, reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'JavaScript volunteer task', summary: 'Synthetic public work', acceptanceCriteria: ['Return exact bytes'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    f.store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: `rate-publish-${i}`, expectedRevision: 1 });
    f.store.publicWorkClaims.enable('commons', 'owner', offerId, { requestId: `rate-enable-${i}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`result-${i}.js`] });
  }
  // 60 real auto-claims fill the identity bucket, each from a fresh address
  // so the per-IP public-work-match bucket cannot trip.
  for (let i = 0; i < 60; i++) {
    const reply = await f.matchAutoClaim(f.first.secret, `match-claim-${i}`);
    assert.equal(reply.status, 200, `claim ${i + 1}: ${JSON.stringify(reply.body)}`);
    assert.equal(reply.body.claim.action, 'claimed', `claim ${i + 1}`);
  }
  // The 61st claim (one task remains) is refused with the direct REST
  // door's rate-limit shape.
  const limited = await f.matchAutoClaim(f.first.secret, 'match-over');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.equal(limited.headers.get('x-ratelimit-bucket'), 'public-work-identity');
  assert.equal(limited.headers.get('x-ratelimit-limit'), '60');
  // A different identity keeps its own allowance and claims the last task.
  const other = await f.matchAutoClaim(f.second.secret, 'match-other');
  assert.equal(other.status, 200);
  assert.equal(other.body.claim.action, 'claimed');
});

test('one shared bucket: REST and MCP attempts accumulate against the same per-identity ceiling', async t => {
  const f = await fixture(t);
  // A real claim within the ceiling still succeeds on the direct REST door.
  const claimed = await f.restClaim('rate:task', f.first.secret, 'rest-claim-ok');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.action, 'claimed');
  // 29 more REST attempts plus 30 MCP attempts, all from fresh addresses,
  // bring the identity total to 60 — neither door alone reaches 60.
  for (let i = 0; i < 29; i++) {
    const reply = await f.restClaim('missing-task', f.first.secret, `rest-fail-${i}`);
    assert.equal(reply.status, 404, `REST attempt ${i + 2}`);
    assert.equal(reply.body.error.code, 'public_work_not_found');
  }
  for (let i = 0; i < 30; i++) {
    const reply = await f.mcpClaim('missing-task', f.first.secret, `mcp-share-${i}`);
    assert.equal(mcpValue(reply).code, 'public_work_not_found', `MCP attempt ${i + 31}`);
  }
  // The next attempt is over the shared ceiling on either door.
  const restLimited = await f.restClaim('missing-task', f.first.secret, 'rest-over');
  assert.equal(restLimited.status, 429);
  assert.equal(restLimited.body.error.code, 'rate_limited');
  assert.equal(restLimited.headers.get('x-ratelimit-bucket'), 'public-work-identity');
  const mcpLimited = await f.mcpClaim('missing-task', f.first.secret, 'mcp-over-shared');
  assert.equal(mcpValue(mcpLimited).status, 429);
  assert.equal(mcpValue(mcpLimited).code, 'rate_limited');
});
