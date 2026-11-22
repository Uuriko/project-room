import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { collectPullRequestLookups, commitPullRequestLookup } from '../server/claim-pr-sync.mjs';
import { appendWorkPullRequest, claimHistoryLength } from '../server/work-claims.mjs';
import { createRoomServer } from '../server/http.mjs';
test('real PR receiver rejects unauthorized requests and links a signed PR exactly once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-pr-receiver-'));
  const store = new RoomStore(join(directory, 'room.sqlite')); store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldFlag = process.env.ROOM_PR_WEBHOOK, oldSecret = process.env.GITHUB_PR_WEBHOOK_SECRET;
  t.after(() => { server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, {recursive:true,force:true});
    if(oldFlag===undefined) delete process.env.ROOM_PR_WEBHOOK; else process.env.ROOM_PR_WEBHOOK=oldFlag;
    if(oldSecret===undefined) delete process.env.GITHUB_PR_WEBHOOK_SECRET; else process.env.GITHUB_PR_WEBHOOK_SECRET=oldSecret;
  });
  const url = `http://127.0.0.1:${server.address().port}/api/github/pr-webhook`;
  const body = JSON.stringify({zen:'receipt test'});
  const send = signature => fetch(url,{method:'POST',headers:{'content-type':'application/json','x-github-event':'ping',...(signature?{'x-hub-signature-256':signature}:{})},body});
  delete process.env.ROOM_PR_WEBHOOK; delete process.env.GITHUB_PR_WEBHOOK_SECRET;
  assert.equal((await send()).status,404);
  process.env.ROOM_PR_WEBHOOK='1'; assert.equal((await send()).status,503);
  process.env.GITHUB_PR_WEBHOOK_SECRET='isolated-http-fixture'; assert.equal((await send('sha256='+'0'.repeat(64))).status,401);
  const signature = 'sha256='+createHmac('sha256','isolated-http-fixture').update(body).digest('hex');
  const response=await send(signature); assert.equal(response.status,200); assert.deepEqual(await response.json(),{ok:true,ignored:true});
  // Exercise actual body reading, route dispatch and durable claim mutation.
  // Direct-handler tests cannot detect a mounted route dropping this payload.
  const origin = new URL(url).origin;
  const token = store.issueAccessKey('commons', 'owner');
  const call = async (path, data) => {
    const result = await fetch(`${origin}/api/rooms/commons/work-claims${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: result.status, body: await result.json() };
  };
  assert.equal((await call('', { id: 'contributor-fix', repo: 'example/project', files: ['src/fix.js'] })).status, 201);
  assert.equal((await call('/contributor-fix/claim', { leaseHours: 1 })).status, 200);
  const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'example/project' },
    pull_request: { html_url: 'https://github.com/example/project/pull/7', number: 7,
      head: { ref: 'contributor-fix' }, title: 'Fix the reported issue', body: 'claim: contributor-fix', state: 'open', merged: false } });
  const prSignature = 'sha256=' + createHmac('sha256', 'isolated-http-fixture').update(payload).digest('hex');
  const deliver = raw => fetch(url, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': prSignature,
  }, body: raw });
  assert.equal((await deliver(payload + ' ')).status, 401, 'signature covers exact request bytes');
  assert.equal((await call('/contributor-fix')).body.pullRequests.length, 0);
  const accepted = await deliver(payload);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).linked, 'contributor-fix');
  const linked = await call('/contributor-fix');
  assert.equal(linked.status, 200);
  assert.equal(linked.body.pullRequests.length, 1);
  assert.equal(linked.body.pullRequests[0].url, 'https://github.com/example/project/pull/7');
  const repeated = await deliver(payload);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).linked, null);
  const replayed = await call('/contributor-fix');
  assert.equal(replayed.body.pullRequests.length, 1, 'redelivery does not add another PR');
  assert.equal(replayed.body.history.length, linked.body.history.length, 'redelivery does not add another claim update');

  // Recorded Buzz App #3620: GitHub reused the PR ETag after the check
  // run changed result on the same revision. The signed delivery is simulated.
  const head = '2fdcb5158ecafbb19ab6d0b567754d5d4401847c';
  const pr = 'https://github.com/block/buzz-app/pull/3620';
  const etag = '"8f9cebdcf2bf0665d5ce6e33710af20d02270d87d4553fb1c8db00934e0c3f53"';
  const id = 'rerun-observation';
  const now = Date.now();
  assert.equal((await call('', { id, repo: 'block/buzz-app', files: ['src/rerun-fixture.js'] })).status, 201);
  assert.equal((await call('/' + id + '/claim', { leaseHours: 1 })).status, 200);
  const row = () => store.workClaims.get('commons', id);
  const current = row();
  const withPull = appendWorkPullRequest(current, 'owner', { pullRequest: pr, now,
    expectedClaimedAt: current.claimedAt, expectedHistoryLength: claimHistoryLength(current) });
  const pullRequest = { ...withPull.pullRequest, etag, ciCursor: 'done', nextPollAt: now };
  store.workClaims.set('commons', { ...withPull, pullRequest, pullRequests: [pullRequest],
    ci: { state: 'failure', headSha: head, checkedAt: '2026-11-21T22:54:28Z', url: pr } });
  const requests = [];
  const observe = async (address, { headers }) => {
    const resource = new URL(address);
    requests.push(resource.pathname);
    if (resource.pathname.endsWith('/pulls/3620')) {
      if (headers['If-None-Match'] === etag) return new Response(null, { status: 304 });
      return Response.json({ number: 3620, html_url: pr, state: 'open', merged: false, head: { sha: head } }, { headers: { etag } });
    }
    if (resource.pathname.endsWith('/status')) return Response.json({ state: 'pending', total_count: 0, statuses: [] });
    assert.ok(resource.pathname.endsWith('/check-runs'));
    return Response.json({ total_count: 1, check_runs: [{ id: 137015706322, name: 'CI required',
      head_sha: head, status: 'completed', conclusion: 'success' }] });
  };
  const poll = async () => {
    const item = row();
    const { results: [result] } = await collectPullRequestLookups([{ ...item, roomId: 'commons' }], {
      fetchImpl: observe, token: 'fixture', nowMs: Date.now()
    });
    commitPullRequestLookup(store, store.workClaims, 'commons', item, result, Math.max(Date.now(), Date.parse('2026-11-21T23:02:09Z')));
  };
  await poll();
  assert.equal(row().ci.state, 'failure');
  assert.equal(requests.length, 1, 'unchanged PR metadata does not contain the rerun result');

  const sendCheck = async (sha, timestamp, authenticated = true) => {
    const raw = JSON.stringify({ action: 'completed', repository: { full_name: 'block/buzz-app' }, check_suite: {
      id: 121675876441, head_sha: sha, updated_at: timestamp, pull_requests: [{ number: 3620 }]
    } });
    const hmac = createHmac('sha256', 'isolated-http-fixture').update(raw).digest('hex');
    return fetch(url, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-GitHub-Event': 'check_suite',
      'X-Hub-Signature-256': 'sha256=' + (authenticated ? hmac : '0'.repeat(64))
    }, body: raw });
  };
  const completedAt = '2026-11-21T23:02:08Z';
  assert.equal((await sendCheck(head, completedAt, false)).status, 401);
  assert.deepEqual(await (await sendCheck('a'.repeat(40), completedAt)).json(), { ok: true, ignored: true });
  assert.equal(row().pullRequest.etag, etag);
  const sequence = () => store.room('commons').sequence;
  const prior = sequence();
  const stale = await collectPullRequestLookups([{ ...row(), roomId: 'commons' }], {
    fetchImpl: observe, token: 'fixture', nowMs: row().pullRequest.nextPollAt
  });
  assert.equal(stale.results[0].kind, 'notModified');
  assert.deepEqual(await (await sendCheck(head, completedAt)).json(), { ok: true, refreshed: 1 });
  const due = row().pullRequest.nextPollAt;
  assert.equal(row().pullRequest.etag, null);
  assert.equal(row().ci.state, 'failure', 'delivery alone is not observed CI');
  assert.equal(sequence(), prior, 'delivery alone creates no wake event');
  commitPullRequestLookup(store, store.workClaims, 'commons', row(), stale.results[0], Date.now());
  assert.equal(row().pullRequest.etag, null, 'in-flight conditional poll cannot restore the invalidated ETag');
  assert.equal(row().pullRequest.nextPollAt, due);
  assert.deepEqual(await (await sendCheck(head, completedAt)).json(), { ok: true, ignored: true });
  assert.equal(row().pullRequest.nextPollAt, due);
  await poll();
  assert.equal(row().ci.state, 'success');
  assert.equal(row().ci.headSha, head);
  assert.equal(requests.length, 5, 'two conditional reads, then one normal three-call refresh');
  assert.deepEqual(await (await sendCheck(head, completedAt)).json(), { ok: true, ignored: true });
  assert.equal(row().pullRequest.etag, etag);


});
