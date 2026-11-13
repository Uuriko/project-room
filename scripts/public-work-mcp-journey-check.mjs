// Synthetic outside-agent usability: advertised hosted endpoint replayed to real
// loopback HTTP. No live identities, Room admission, host launch or payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

test('hosted discovery supports a zero-Room outside contributor through lost submission and own feedback', { timeout: 45000 }, async t => {
  const f = createAcceptanceFixture(), store = f.store;
  const identity = store.identities.create('Disposable saved contributor'), other = store.identities.create('Disposable other contributor');
  store.projectOffers.create('commons', 'owner', { requestId: 'mcp-create', offerId: 'mcp-task', reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'Volunteer accessibility contribution', summary: 'Inspect a bounded JavaScript component', acceptanceCriteria: ['JavaScript keyboard accessibility'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'mcp-task', 'publish', { requestId: 'mcp-publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'mcp-task', { requestId: 'mcp-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/welcome.js'] });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, journey = [];
  const counts = () => ['agent_identities', 'identity_links', 'rooms'].map(table => store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const before = counts();
  const discovery = await fetch(`${origin}/mcp/server-card`); assert.equal(discovery.status, 200); const card = await discovery.json();
  const advertised = new URL(card.remotes[0].url); assert.equal(advertised.protocol, 'https:');
  // The deployed discovery document intentionally has a fixed canonical URL.
  // Only its advertised path is replayed to this disposable real HTTP fixture.
  const endpoint = `${origin}${advertised.pathname}`;
  const headers = secret => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) });
  let id = 0;
  async function rpc(method, params, secret, { drop = false, rpcId = ++id } = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params ? { params } : {}) });
    const response = await fetch(endpoint, { method: 'POST', headers: headers(secret), body });
    const text = await response.text(); journey.push({ method, tool: params?.name, status: response.status, authenticated: Boolean(secret) });
    assert.equal(response.status, 200, text);
    if (drop) throw new Error('Synthetic lost response after real HTTP completion');
    return JSON.parse(text);
  }
  const initialized = await rpc('initialize', { protocolVersion: card.remotes[0].supportedProtocolVersions[0], capabilities: {}, clientInfo: { name: 'outside-usability-fixture', version: '1' } });
  assert.match(initialized.result.instructions, /public.*work|volunteer/i); assert.match(initialized.result.instructions, /no room|without.*room/i);
  const anonymous = (await rpc('tools/list')).result.tools;
  for (const name of ['public_work_recommend', 'public_work_read_task']) assert.ok(anonymous.some(tool => tool.name === name));
  assert.ok(!anonymous.some(tool => tool.name === 'public_work_claim'));
  async function call(name, args, secret, options) { return rpc('tools/call', { name, arguments: args }, secret, options); }
  const value = reply => { assert.ok(!reply.error, JSON.stringify(reply.error)); assert.ok(!reply.result.isError, JSON.stringify(reply.result.structuredContent)); return reply.result.structuredContent; };
  const recommended = value(await call('public_work_recommend', { skills: ['JavaScript'], interests: ['accessibility'] }));
  assert.equal(recommended.claim, null); assert.deepEqual(recommended.supportedRewards, ['volunteer']); assert.equal(recommended.recommendations.length, 1);
  const task = value(await call('public_work_read_task', { taskId: recommended.recommendations[0].task.taskId }));
  assert.deepEqual(task.acceptanceCriteria, ['JavaScript keyboard accessibility']); assert.deepEqual(task.files, ['src/welcome.js']); assert.equal(task.claim.state, 'unclaimed');
  const paid = await call('public_work_recommend', { reward: 'cash' }); assert.ok(paid.error || paid.result.isError, 'unsupported paid preferences must not create a paid match');
  assert.deepEqual(counts(), before, 'discovery and recommendations do not provision credentials or memberships');
  const authenticated = (await rpc('tools/list', undefined, identity.secret)).result.tools;
  for (const name of ['public_work_claim', 'public_work_renew', 'public_work_release', 'public_work_finish', 'public_work_my_review']) {
    const tool = authenticated.find(entry => entry.name === name); assert.ok(tool, name); assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'roomId')); assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'secret'));
  }
  const claimArgs = { taskId: task.taskId, requestId: 'outside-explicit-claim', expectedTermsVersion: task.termsVersion, leaseHours: 1 };
  const claimed = value(await call('public_work_claim', claimArgs, identity.secret)); assert.equal(claimed.action, 'claimed'); assert.equal(claimed.task.claim.identityId, identity.identityId); assert.ok(claimed.task.claim.leaseExpiresAt);
  const artifactText = 'Readable UTF-8 contribution 🐈\n<script>not executed</script>';
  const finishArgs = { taskId: task.taskId, requestId: 'outside-exact-finish', expectedTermsVersion: task.termsVersion, generation: claimed.task.claim.generation, artifactText, checksReported: ['Producer reports keyboard check'] };
  await assert.rejects(call('public_work_finish', finishArgs, identity.secret, { drop: true, rpcId: 'finish-retry' }), /lost response/);
  const submitted = value(await call('public_work_finish', finishArgs, identity.secret, { rpcId: 'finish-retry' }));
  assert.equal(submitted.action, 'submitted'); assert.equal(submitted.receipt.verification, 'hash_only'); assert.equal(submitted.receipt.state, 'submitted'); assert.deepEqual(submitted.receipt.checksReported, finishArgs.checksReported);
  const receiptId = submitted.receipt.receiptId;
  function publicUrl(url) {
    const parsed = new URL(url); assert.ok([origin, advertised.origin, new URL(card.auth.mint).origin].includes(parsed.origin), 'only advertised public service URLs may be replayed locally');
    assert.ok(!parsed.username && !parsed.password && !parsed.search && !parsed.hash);
    if (parsed.origin === origin) return parsed.href;
    return `${origin}${parsed.pathname.replace(/^\/room\/api\//, '/api/')}`;
  }
  assert.equal(submitted.publicReceipt.verification, 'sha256_bytes_only');
  const receiptResponse = await fetch(publicUrl(submitted.publicReceipt.url)); assert.equal(receiptResponse.status, 200); assert.deepEqual(await receiptResponse.json(), submitted.receipt);
  const bytesResponse = await fetch(publicUrl(submitted.publicReceipt.artifactUrl)); assert.equal(bytesResponse.status, 200); const bytes = Buffer.from(await bytesResponse.arrayBuffer());
  assert.equal(bytes.toString('utf8'), artifactText); assert.equal(bytes.length, submitted.receipt.artifact.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), submitted.receipt.artifact.sha256);
  const replay = value(await call('public_work_finish', finishArgs, identity.secret)); assert.deepEqual(replay, submitted);
  const decision = await fetch(`${origin}/api/rooms/commons/public-work/receipts/${receiptId}/decide`, { method: 'POST', headers: { ...headers(f.keys.owner), Origin: origin }, body: JSON.stringify({ requestId: 'actual-owner-review', expectedReviewRevision: 0, taskId: task.taskId, expectedTermsVersion: task.termsVersion, generation: submitted.receipt.generation, artifactSha256: submitted.receipt.artifact.sha256, decision: 'revision_requested', reason: 'Please improve the keyboard instructions.' }) });
  assert.equal(decision.status, 200, await decision.text());
  const feedback = value(await call('public_work_my_review', { receiptId }, identity.secret)); assert.match(JSON.stringify(feedback), /Please improve the keyboard instructions/); assert.doesNotMatch(JSON.stringify(feedback), /roomId|actorId|reviewerMemberIds|fingerprint/);
  const denied = await call('public_work_my_review', { receiptId }, other.secret); assert.ok(denied.error || denied.result.isError); assert.doesNotMatch(JSON.stringify(denied), /Please improve the keyboard instructions/);
  assert.deepEqual(counts(), before, 'complete hosted journey preserves zero Room membership and no credential provisioning');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE identity_id=?').get(identity.identityId).n, 0);
  t.diagnostic(JSON.stringify({ advertisedEndpoint: advertised.href, fixtureEndpoint: endpoint, journey }));
});
