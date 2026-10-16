// #3650: every invalid_public_work 422 names the fields it refused — in the
// message text and in error.detail.fields { missing, unexpected, invalid } —
// because its own AX hint tells the caller to fix "the refused fields named
// in this error's message". Before this fix the shape refusal ("Unexpected
// or missing fields") named nothing, so a guessing agent could not
// self-correct. Each validation branch below is pinned individually.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';
import { createRoomServer } from '../server/http.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-fields-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const identities = [store.identities.create('Fields worker')];
  const service = () => new PublicWorkClaims(store);
  const publish = id => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title: id, summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
  };
  const enable = (id, input = {}) => { publish(id); return service().enable('commons', 'owner', id,
    { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/a.js'], ...input }); };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, identities, publish, enable };
}
const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });
const owned = (requestId, generation, extra = {}) => ({ ...claim(requestId), generation, ...extra });

// Assert the refusal is an invalid_public_work whose message names every
// expected field and whose structured fields match exactly.
function refusal(fn, { missing = [], unexpected = [], invalid = [] } = {}) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, 'expected an invalid_public_work refusal');
  assert.equal(error.code, 'invalid_public_work', error.message);
  assert.equal(error.status, 422, error.message);
  assert.deepEqual(error.detail?.fields, { missing, unexpected, invalid }, error.message);
  for (const field of [...missing, ...unexpected, ...invalid])
    assert.ok(error.message.includes(field), `message names ${field}: ${error.message}`);
  return error;
}

test('shape refusals name the missing and unexpected fields (act claim/finish)', t => {
  const f = fixture(t), [a] = f.identities; f.enable('shape-task');
  // The EXP-3 repro: a claim carrying only a requestId.
  refusal(() => f.service().act('shape-task', a.secret, 'claim', { requestId: 'b-1' }), { missing: ['expectedTermsVersion'] });
  // An unknown extra field is named as unexpected.
  refusal(() => f.service().act('shape-task', a.secret, 'claim', claim('b-2', { bogus: 1 })), { unexpected: ['bogus'] });
  // Missing and unexpected together are both named.
  refusal(() => f.service().act('shape-task', a.secret, 'claim', { requestId: 'b-3', bogus: 1 }),
    { missing: ['expectedTermsVersion'], unexpected: ['bogus'] });
  // A non-object body names the whole required set as missing.
  refusal(() => f.service().act('shape-task', a.secret, 'claim', null), { missing: ['requestId', 'expectedTermsVersion'] });
  // The finish repro: a partial finish body names every absent part.
  f.service().act('shape-task', a.secret, 'claim', claim('b-4'));
  refusal(() => f.service().act('shape-task', a.secret, 'finish', { requestId: 'b-5' }),
    { missing: ['expectedTermsVersion', 'generation', 'artifactText', 'checksReported'] });
});

test('act names the action, terms-version and generation fields it refuses', t => {
  const f = fixture(t), [a] = f.identities; f.enable('act-task');
  refusal(() => f.service().act('act-task', a.secret, 'dance', claim('a-1')), { invalid: ['action'] });
  refusal(() => f.service().act('act-task', a.secret, 'claim', claim('a-2', { expectedTermsVersion: 'one' })), { invalid: ['expectedTermsVersion'] });
  refusal(() => f.service().act('act-task', a.secret, 'renew', owned('a-3', 0)), { invalid: ['generation'] });
  refusal(() => f.service().act('act-task', a.secret, 'renew', owned('a-4', -1, { expectedTermsVersion: 0 })), { invalid: ['expectedTermsVersion', 'generation'] });
});

test('lease refusals name leaseHours for both the type and the range fault', t => {
  const f = fixture(t), [a] = f.identities; f.enable('lease-task');
  refusal(() => f.service().act('lease-task', a.secret, 'claim', claim('l-1', { leaseHours: '6h' })), { invalid: ['leaseHours'] });
  refusal(() => f.service().act('lease-task', a.secret, 'claim', claim('l-2', { leaseHours: 25 })), { invalid: ['leaseHours'] });
  refusal(() => f.service().match(a.secret, { leaseHours: 0 }), { invalid: ['leaseHours'] });
});

test('finish refusals name artifactText and checksReported', t => {
  const f = fixture(t), [a] = f.identities; f.enable('finish-task');
  f.service().act('finish-task', a.secret, 'claim', claim('f-1'));
  refusal(() => f.service().act('finish-task', a.secret, 'finish', owned('f-2', 1, { artifactText: '🦉'.repeat(16385), checksReported: [] })), { invalid: ['artifactText'] });
  refusal(() => f.service().act('finish-task', a.secret, 'finish', owned('f-3', 1, { artifactText: 'ok', checksReported: ['x'.repeat(1001)] })), { invalid: ['checksReported'] });
  refusal(() => f.service().act('finish-task', a.secret, 'finish', owned('f-4', 1, { artifactText: 'ok', checksReported: 'none' })), { invalid: ['checksReported'] });
});

test('enable refusals name expectedRevision, repositoryRef and files', t => {
  const f = fixture(t);
  f.publish('enable-rev');
  refusal(() => f.service().enable('commons', 'owner', 'enable-rev',
    { requestId: 'e-1', expectedRevision: 0, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/a.js'] }), { invalid: ['expectedRevision'] });
  f.publish('enable-ref');
  refusal(() => f.service().enable('commons', 'owner', 'enable-ref',
    { requestId: 'e-2', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: '../escape', files: ['src/a.js'] }), { invalid: ['repositoryRef'] });
  // files: empty list, non-string entry, and escaping path each name files.
  refusal(() => f.enable('enable-empty', { files: [] }), { invalid: ['files'] });
  refusal(() => f.enable('enable-type', { files: [42] }), { invalid: ['files'] });
  refusal(() => f.enable('enable-escape', { files: ['../escape'] }), { invalid: ['files'] });
  // The enable shape itself names what is absent.
  f.publish('enable-shape');
  refusal(() => f.service().enable('commons', 'owner', 'enable-shape', { requestId: 'e-3' }),
    { missing: ['expectedRevision', 'expectedTermsVersion', 'repositoryRef', 'files'] });
});

test('match refusals name limit, reward, autoClaim, skills, interests, after and requestId', t => {
  const f = fixture(t);
  refusal(() => f.service().match(null, { limit: 9 }), { invalid: ['limit'] });
  refusal(() => f.service().match(null, { reward: 'gold' }), { invalid: ['reward'] });
  refusal(() => f.service().match(null, { limit: 0, reward: 'gold' }), { invalid: ['limit', 'reward'] });
  refusal(() => f.service().match(null, { autoClaim: 'yes' }), { invalid: ['autoClaim'] });
  refusal(() => f.service().match(null, { skills: ['bad\nvalue'] }), { invalid: ['skills'] });
  refusal(() => f.service().match(null, { interests: 'gardening' }), { invalid: ['interests'] });
  refusal(() => f.service().match(null, { after: '../bad' }), { invalid: ['after'] });
  refusal(() => f.service().match(null, { requestId: 'bad id!' }), { invalid: ['requestId'] });
  refusal(() => f.service().match(null, { bogus: 1 }), { unexpected: ['bogus'] });
});

test('list refusals name limit, after and the boolean page flags', t => {
  const f = fixture(t);
  refusal(() => f.service().list({ limit: 0 }), { invalid: ['limit'] });
  refusal(() => f.service().list({ limit: 2.5, after: '../bad' }), { invalid: ['limit', 'after'] });
  refusal(() => f.service().list({ claimable: 'yes' }), { invalid: ['claimable'] });
});

test('identifier refusals name taskId, receiptId and requestId', t => {
  const f = fixture(t), [a] = f.identities; f.enable('id-task');
  refusal(() => f.service().read('../bad'), { invalid: ['taskId'] });
  refusal(() => f.service().receipt('../bad'), { invalid: ['receiptId'] });
  // A malformed requestId passes the shape (the key exists) and is refused
  // by the request journal, which now names requestId too.
  refusal(() => f.service().act('id-task', a.secret, 'claim', claim('bad id!')), { invalid: ['requestId'] });
});

async function httpFixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'http-task', reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'http-task', summary: 'Public result', acceptanceCriteria: ['Deliver the declared change'],
      repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'http-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'http-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/a.js'] });
  const worker = store.identities.create('HTTP fields worker');
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', secret, body } = {}) => {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { store, worker, call };
}

test('HTTP envelope: the hint promise is kept — message and fields name the refused fields', async t => {
  const f = await httpFixture(t);
  // The EXP-3 repro over the wire: claim with only a requestId.
  const claimRefused = await f.call('/api/public-work/tasks/http-task/claim', { method: 'POST', secret: f.worker.secret, body: { requestId: 'b-1' } });
  assert.equal(claimRefused.status, 422);
  assert.equal(claimRefused.body.error.code, 'invalid_public_work');
  assert.deepEqual(claimRefused.body.fields, { missing: ['expectedTermsVersion'], unexpected: [], invalid: [] });
  assert.ok(claimRefused.body.error.message.includes('expectedTermsVersion'), claimRefused.body.error.message);
  assert.match(claimRefused.body.hint, /named in this error's message/);
  // The finish repro: a partial finish body names every absent part.
  await f.call('/api/public-work/tasks/http-task/claim', { method: 'POST', secret: f.worker.secret, body: claim('b-2') });
  const finishRefused = await f.call('/api/public-work/tasks/http-task/finish', { method: 'POST', secret: f.worker.secret, body: { requestId: 'b-3' } });
  assert.equal(finishRefused.status, 422);
  assert.deepEqual(finishRefused.body.fields.missing, ['expectedTermsVersion', 'generation', 'artifactText', 'checksReported']);
  // Query-parameter refusals name the refused parameters.
  const unknownParam = await f.call('/api/public-work/tasks?state=unclaimed');
  assert.equal(unknownParam.status, 422);
  assert.deepEqual(unknownParam.body.fields.unexpected, ['state']);
  assert.ok(unknownParam.body.error.message.includes('state'), unknownParam.body.error.message);
  const badClaimable = await f.call('/api/public-work/tasks?claimable=yes');
  assert.equal(badClaimable.status, 422);
  assert.deepEqual(badClaimable.body.fields.invalid, ['claimable']);
  assert.ok(badClaimable.body.error.message.includes('claimable'), badClaimable.body.error.message);
  const matchParam = await f.call('/api/public-work/match?foo=bar', { method: 'POST', body: {} });
  assert.equal(matchParam.status, 422);
  assert.deepEqual(matchParam.body.fields.unexpected, ['foo']);
  assert.ok(matchParam.body.error.message.includes('foo'), matchParam.body.error.message);
});

test('MCP door: a domain refusal carries the fields list next to the message', async t => {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'fields-1', method: 'tools/call', params: { name: 'public_work_recommend', arguments: { skills: ['bad\nvalue'] } } }) });
  const body = await response.json();
  const content = body.result.structuredContent;
  assert.equal(body.result.isError, true, JSON.stringify(body));
  assert.equal(content.code, 'invalid_public_work');
  assert.deepEqual(content.fields, { missing: [], unexpected: [], invalid: ['skills'] });
  assert.ok(content.message.includes('skills'), content.message);
});
