import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { PUBLIC_WORK_MCP_TOOLS } from '../src/room-mcp-join.js';

// Only setup and state observation are fixture routes. All MCP, review,
// artifact and credential revocation requests traverse the production entry,
// Node bridge and authenticated production HTTP handlers inside real workerd.
const fixture = `
import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
export class PublicMcpTestRoom extends ProjectRoom {
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/__fixture/setup' && request.method === 'POST') {
   this.store.initialize(initialRoom());
   const offerId = 'worker:mcp-task';
   this.store.projectOffers.create('commons','owner',{requestId:'create',offerId,reviewerMemberIds:['owner'],terms:{kind:'task',title:'JavaScript volunteer work',summary:'Disposable MCP journey',acceptanceCriteria:['Return exact bytes'],repositoryUrl:'https://github.com/example/project',reward:{kind:'unpaid'},approvalPolicy:{mode:'human'}}});
   this.store.projectOffers.transition('commons','owner',offerId,'publish',{requestId:'publish',expectedRevision:1});
   const task = this.store.publicWorkClaims.enable('commons','owner',offerId,{requestId:'enable',expectedRevision:2,expectedTermsVersion:1,repositoryRef:'main',files:['result.js']});
   return Response.json({task,identity:this.store.identities.create('Outside MCP Worker'),ownerKey:this.store.issueAccessKey('commons','owner')});
  }
  if (path === '/__fixture/state' && request.method === 'GET') {
   const tables = ['identity_links','bounty_journal','public_work_requests','public_work_receipts','public_work_reviews','public_work_review_requests','work_claims'];
   return Response.json({members:Object.keys(this.store.room('commons').state.members),
    rows:Object.fromEntries(tables.map(table => [table,this.store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),
    permit:this.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled});
  }
  return super.fetch(request);
 }
}
export default entry;
`;

test('actual Worker MCP outside contribution persists across disposal through both MCP paths without Room or credit authority', { timeout: 60000 }, async () => {
  const bundled = await build({ stdin: { contents: fixture, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'public-mcp-local-fixture.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const persistence = await mkdtemp(join(tmpdir(), 'public-work-mcp-worker-'));
  const origin = 'https://room.example.test';
  const config = { modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'PublicMcpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: origin }, durableObjectsPersist: persistence };
  let worker = new Miniflare(config);
  const api = (path, data, secret) => worker.dispatchFetch(new URL(path, origin), { method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...(secret ? { Authorization: 'Bearer ' + secret } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const json = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response.json(); };
  const rpc = (path, message, secret) => api(path, { jsonrpc: '2.0', id: 'worker-rpc', ...message }, secret);
  const call = (path, name, args, secret) => rpc(path, { method: 'tools/call', params: { name, arguments: args } }, secret);
  const value = async response => {
    const reply = await json(response);
    assert.equal(reply.error, undefined, JSON.stringify(reply)); assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
    assert.deepEqual(JSON.parse(reply.result.content[0].text), reply.result.structuredContent);
    return reply.result.structuredContent;
  };
  const state = async () => json(await api('/__fixture/state'));
  const reopen = async () => { await worker.dispose(); worker = new Miniflare(config); };
  try {
    const { task, identity, ownerKey } = await json(await api('/__fixture/setup', {}));
    const before = await state(); assert.deepEqual(before.members, ['owner']); assert.deepEqual(before.rows.identity_links, []);
    for (const path of ['/mcp', '/room/mcp']) {
      const listed = await json(await rpc(path, { method: 'tools/list' }));
      assert.deepEqual(listed.result.tools.map(tool => tool.name), ['room_join_packet','room_join_kits','room_join_prompt','room_mcp_snippet','public_work_recommend','public_work_read_task','room_identity_mint']);
      const recommendation = await value(await call(path, 'public_work_recommend', { skills: ['JavaScript'] }));
      assert.equal(recommendation.claim, null); assert.equal(recommendation.recommendations[0].task.taskId, task.taskId);
      assert.deepEqual(await value(await call(path, 'public_work_read_task', { taskId: task.taskId })), task);
      const outside = await json(await rpc(path, { method: 'tools/list' }, identity.secret));
      assert.ok(PUBLIC_WORK_MCP_TOOLS.every(name => outside.result.tools.some(tool => tool.name === name)));
      assert.equal(outside.result.tools.find(tool => tool.name === 'public_work_claim')._meta.authorization, 'saved-identity-secret');
      const unknown = await json(await call(path, 'public_work_read_task', { taskId: task.taskId }, 'pri_not_a_real_identity'), 401);
      assert.equal(unknown.error.code, -32001);
    }
    assert.deepEqual(await state(), before, 'discovery and failed authentication must not write claims, memberships or credits');
    const claim = { taskId: task.taskId, requestId: 'worker-claim', expectedTermsVersion: task.termsVersion, leaseHours: 1 };
    const claimed = await value(await call('/mcp', 'public_work_claim', claim, identity.secret));
    assert.equal(claimed.task.claim.identityId, identity.identityId);
    const { taskId: ignoredTaskId, ...httpClaim } = claim;
    void ignoredTaskId;
    assert.deepEqual(await json(await api('/api/public-work/tasks/' + encodeURIComponent(task.taskId) + '/claim', httpClaim, identity.secret)), claimed);
    assert.equal((await state()).rows.public_work_requests.filter(row => row.actor_id === identity.identityId).length, 1, 'MCP and HTTP retry must share one journal entry');
    await reopen();
    assert.deepEqual(await value(await call('/mcp', 'public_work_claim', claim, identity.secret)), claimed);
    const artifactText = 'Exact public UTF-8 bytes 🐈\n<plain-text>\\quoted';
    const finish = { taskId: task.taskId, requestId: 'worker-finish', expectedTermsVersion: task.termsVersion,
      generation: claimed.task.claim.generation, artifactText, checksReported: ['Producer-reported synthetic check'] };
    const completed = await value(await call('/room/mcp', 'public_work_finish', finish, identity.secret));
    assert.equal(completed.receipt.state, 'submitted'); assert.equal(completed.receipt.verification, 'hash_only');
    assert.equal(completed.publicReceipt.verification, 'sha256_bytes_only');
    assert.equal(completed.publicReceipt.url, origin + '/api/public-work/receipts/' + completed.receipt.receiptId);
    assert.equal(completed.publicReceipt.artifactUrl, completed.publicReceipt.url + '/artifact');
    await reopen();
    assert.deepEqual(await value(await call('/room/mcp', 'public_work_finish', finish, identity.secret)), completed);
    assert.deepEqual(await json(await api(completed.publicReceipt.url)), completed.receipt);
    const artifactResponse = await api(completed.publicReceipt.artifactUrl);
    assert.equal(artifactResponse.status, 200); assert.match(artifactResponse.headers.get('Content-Type'), /^text\/plain/);
    assert.equal(artifactResponse.headers.get('X-Content-Type-Options'), 'nosniff');
    const bytes = Buffer.from(await artifactResponse.arrayBuffer());
    assert.equal(bytes.toString('utf8'), artifactText); assert.equal(bytes.length, completed.receipt.artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), completed.receipt.artifact.sha256);
    const receiptId = completed.receipt.receiptId;
    await json(await api('/api/rooms/commons/public-work/receipts/' + receiptId + '/decide', {
      requestId: 'owner-review', expectedReviewRevision: 0, taskId: task.taskId, expectedTermsVersion: task.termsVersion,
      generation: completed.receipt.generation, artifactSha256: completed.receipt.artifact.sha256, decision: 'accepted', reason: 'Thanks for the exact result'
    }, ownerKey));
    const feedback = await value(await call('/room/mcp', 'public_work_my_review', { receiptId }, identity.secret));
    assert.equal(feedback.review.state, 'accepted'); assert.equal(feedback.review.reason, 'Thanks for the exact result');
    for (const field of ['roomId', 'actorId', 'reviewerMemberIds', 'fingerprint', 'workItemId']) assert.equal(JSON.stringify(feedback).includes(field), false);
    const acceptedState = await state();
    await reopen(); assert.deepEqual(await state(), acceptedState);
    assert.deepEqual(await value(await call('/mcp', 'public_work_my_review', { receiptId }, identity.secret)), feedback);
    assert.deepEqual(acceptedState.members, before.members); assert.deepEqual(acceptedState.rows.identity_links, before.rows.identity_links);
    assert.deepEqual(acceptedState.rows.bounty_journal, before.rows.bounty_journal); assert.equal(acceptedState.permit, 0);
    assert.equal(acceptedState.rows.public_work_receipts.length, 1);
    await json(await api('/api/agent-identities/' + identity.identityId + '/revoke', { confirm: true }, identity.secret));
    for (const path of ['/mcp', '/room/mcp']) {
      const rejected = await json(await call(path, 'public_work_finish', finish, identity.secret), 401);
      assert.equal(rejected.error.code, -32001);
    }
    assert.deepEqual(await state(), acceptedState, 'revoked retries must not add request journals or alter accepted submission');
  } finally { await worker.dispose(); await rm(persistence, { recursive: true, force: true }); }
});
