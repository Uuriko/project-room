// #5378 claim thread: one ordered record per Board claim, read at
// GET /api/rooms/{roomId}/work-claims/{claimId}/thread.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { claimThreadKind, mergeClaimThread } from '../server/claim-thread.mjs';
import { AgentRooms, agentRoomSchema } from '../server/agent-rooms.mjs';
import { createHostedRoomMcp } from '../server/mcp-room-profile.mjs';
import { createWork } from '../server/work-claims.mjs';

test('claimThreadKind sorts actions into the PR -> CI -> review -> merge -> deploy arc', () => {
  assert.equal(claimThreadKind('claimed'), 'claim');
  assert.equal(claimThreadKind('pr_autolinked'), 'pr');
  assert.equal(claimThreadKind('ci_changed'), 'ci');
  assert.equal(claimThreadKind('state_changed', { reason: 'ci_changed' }), 'ci');
  assert.equal(claimThreadKind('reviewed'), 'review');
  assert.equal(claimThreadKind('pr_merged'), 'merge');
  assert.equal(claimThreadKind('deploy_linked'), 'deploy');
});

test('mergeClaimThread keeps event order and places history steps by time', () => {
  const events = [{ at: '2026-01-01T00:00:01Z', action: 'claimed' }, { at: '2026-01-01T00:00:03Z', action: 'pr_merged' }];
  const merged = mergeClaimThread(events, [{ at: '2026-01-01T00:00:02Z', action: 'pr_autolinked' }, { at: '2026-01-01T00:00:04Z', action: 'deploy_linked' }]);
  assert.deepEqual(merged.map(e => e.action), ['claimed', 'pr_autolinked', 'pr_merged', 'deploy_linked']);
});

test('claim thread route returns the claim and PR steps in order, for members only', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-claim-thread-'));
  const store = new RoomStore(join(directory, 'room.sqlite')); store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldFlag = process.env.ROOM_PR_WEBHOOK, oldSecret = process.env.GITHUB_PR_WEBHOOK_SECRET;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true });
    if (oldFlag === undefined) delete process.env.ROOM_PR_WEBHOOK; else process.env.ROOM_PR_WEBHOOK = oldFlag;
    if (oldSecret === undefined) delete process.env.GITHUB_PR_WEBHOOK_SECRET; else process.env.GITHUB_PR_WEBHOOK_SECRET = oldSecret;
  });
  process.env.ROOM_PR_WEBHOOK = '1'; process.env.GITHUB_PR_WEBHOOK_SECRET = 'isolated-thread-fixture';
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = store.issueAccessKey('commons', 'owner');
  const call = async (path, data, auth = token) => {
    const result = await fetch(`${origin}/api/rooms/commons/work-claims${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), Origin: origin, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: result.status, body: await result.json().catch(() => null) };
  };
  assert.equal((await call('', { id: 'thread-fix', repo: 'example/project', files: ['src/fix.js'] })).status, 201);
  assert.equal((await call('/thread-fix/claim', { leaseHours: 1 })).status, 200);
  const deliver = async payload => {
    const raw = JSON.stringify(payload);
    const signature = 'sha256=' + createHmac('sha256', 'isolated-thread-fixture').update(raw).digest('hex');
    return fetch(`${origin}/api/github/pr-webhook`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': signature }, body: raw });
  };
  const pr = { html_url: 'https://github.com/example/project/pull/9', number: 9, head: { ref: 'thread-fix' },
    title: 'Fix', body: 'claim: thread-fix', state: 'open', merged: false };
  assert.equal((await deliver({ action: 'opened', repository: { full_name: 'example/project' }, pull_request: pr })).status, 200);

  const thread = await call('/thread-fix/thread');
  assert.equal(thread.status, 200);
  assert.equal(thread.body.claimId, 'thread-fix');
  assert.equal(thread.body.truncated, false);
  assert.ok(thread.body.contentTrust, 'member text is marked as data');
  assert.deepEqual(thread.body.pullRequests.map(p => p.url), ['https://github.com/example/project/pull/9']);
  const actions = thread.body.entries.map(e => e.action);
  assert.ok(actions.indexOf('created') < actions.indexOf('claimed'), `created before claimed: ${actions}`);
  assert.ok(actions.indexOf('claimed') < actions.indexOf('pr_autolinked'), `claimed before PR link: ${actions}`);
  const sequences = thread.body.entries.filter(e => e.source === 'event').map(e => e.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.ok(thread.body.entries.some(e => e.kind === 'pr'));

  assert.equal((await call('/missing-claim/thread')).status, 404);
  assert.equal((await call('/thread-fix/thread', undefined, null)).status, 401);
});

test('MCP room_work_claim_thread returns the same thread as the route', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'claim-thread-mcp-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  store.initialize(initialRoom('commons'));
  store.db.exec(agentRoomSchema);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.identities.create('Owen');
  const { roomId } = new AgentRooms(store).create(owner.secret, { title: 'Thread room', purpose: 'thread test', displayName: 'Owen' });
  store.workClaims.set(roomId, createWork({ id: 'root', title: 'Root' }, { now: '2026-10-30T00:00:00.000Z', agentId: 'coord' }));
  const mcp = createHostedRoomMcp(store);
  const call = claimId => mcp({ jsonrpc: '2.0', id: claimId, method: 'tools/call',
    params: { name: 'room_work_claim_thread', arguments: { roomId, claimId } } }, { authorization: `Bearer ${owner.secret}` });
  const response = await call('root');
  assert.ok(!response.error, JSON.stringify(response.error ?? null).slice(0, 200));
  const value = response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
  assert.equal(value.claimId, 'root');
  assert.ok(Array.isArray(value.entries));
  const missing = await call('nope');
  assert.ok(missing.error || missing.result?.isError, 'unknown claim is an error');
});
