import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { readWorkItem } from '../server/work-repository.mjs';
import { configureGithubObservation, GITHUB_OBSERVATION_FRESH_MS, GITHUB_OBSERVATION_MAX_CALLS } from '../server/claim-pr-sync.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

// Mocked GitHub. These tests show what Room does with what GitHub returns;
// they are not a live qualification against github.com.
const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40), SHA_M = 'c'.repeat(40), TOKEN = 'ghs_fixture_token_must_never_appear';
const REPO = 'acme/widgets', BRANCH = 'fable/fix-resume';

function github() {
  const world = { pulls: [], status: {}, runs: {}, fail: null, calls: [] };
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const pullBody = pull => ({ number: pull.number, html_url: `https://github.com/${pull.repo ?? REPO}/pull/${pull.number}`, url: `https://api.github.com/repos/${pull.repo ?? REPO}/pulls/${pull.number}`,
    state: pull.state ?? 'open', merged: Boolean(pull.mergedSha), merged_at: pull.mergedSha ? '2026-11-16T10:00:00Z' : null, merge_commit_sha: pull.mergedSha ?? null,
    head: { ref: pull.ref ?? BRANCH, sha: pull.head, repo: { full_name: pull.headRepo ?? pull.repo ?? REPO } }, base: { repo: { full_name: pull.repo ?? REPO } } });
  world.fetch = async (url, init = {}) => {
    world.calls.push(String(url));
    assert.equal(init.headers?.Authorization, 'Bearer ' + TOKEN);
    if (world.fail === 'network') throw new Error('socket hang up ' + TOKEN);
    if (world.fail === 'rate') return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(world.now() / 1000) + 600) });
    if (world.fail === 'private') return json({ message: 'Not Found' }, 404);
    const parsed = new URL(url);
    const list = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(parsed.pathname);
    if (list) return json(world.pulls.filter(pull => `${list[1].split('/')[0]}:${pull.ref ?? BRANCH}` === parsed.searchParams.get('head')).map(pullBody));
    const one = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(parsed.pathname);
    if (one) { const pull = world.pulls.find(entry => entry.number === Number(one[2]) && (entry.repo ?? REPO) === one[1]); return pull ? json(pullBody(pull)) : json({ message: 'Not Found' }, 404); }
    const status = /\/commits\/([0-9a-f]{40})\/status$/.exec(parsed.pathname);
    if (status) return json(world.status[status[1]] ?? { state: 'pending', total_count: 0, statuses: [] });
    const runs = /\/commits\/([0-9a-f]{40})\/check-runs$/.exec(parsed.pathname);
    if (runs) return json({ check_runs: world.runs[runs[1]] ?? [] });
    return json({ message: 'unexpected' }, 500);
  };
  return world;
}

async function fixture(t, representation) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom(), representation === 'legacy' ? {} : { representation });
  const owner = store.issueAccessKey('commons', 'owner');
  const member = (name, permissions) => { const identity = store.identities.create(name);
    linkWithProof(store, owner, 'commons', identity, { displayName: name, permissions });
    setTier(store.db, 'commons', identity.identityId, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() }); return identity; };
  const producer = member('Producer', ['accept_work', 'complete_work']), reviewer = member('Reviewer', ['verify']);
  const stranger = store.identities.create('Not a member');
  const world = github(); let clock = Date.UTC(2026, 10, 16, 12);
  world.now = () => clock;
  const server = createRoomServer({ store, fetchPullRequest: world.fetch, githubToken: TOKEN });
  configureGithubObservation(store, { fetchImpl: world.fetch, token: TOKEN, now: () => clock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`, seen = [];
  const raw = async (identity, name, args = {}) => {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + identity.secret },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { roomId: 'commons', ...args } } }) });
    const text = await response.text(); seen.push(text); return JSON.parse(text);
  };
  const call = async (identity, name, args) => { const body = await raw(identity, name, args); assert.equal(body.error, undefined, JSON.stringify(body)); assert.notEqual(body.result?.isError, true, JSON.stringify(body)); return body.result.structuredContent; };
  const command = (type, data) => store.command(owner, 'commons', { id: crypto.randomUUID(), type, data });
  const propose = (id, extra = {}) => command('work.proposed', { workItemId: id, title: id, definitionOfDone: 'Merged fix with passing checks', accountableMemberId: producer.identityId,
    mode: 'write', verifierMemberId: reviewer.identityId, independentVerificationRequired: true, ...extra });
  const observe = (identity, id, extra = {}) => call(identity, 'room_read_work', { workItemId: id, brief: true, observeGithub: true, ...extra });
  return { store, world, producer, reviewer, stranger, call, raw, command, propose, observe, seen, advance: ms => { clock += ms; }, item: id => readWorkItem(store.db, 'commons', id) };
}

for (const representation of ['normalized-current-v1', 'legacy']) {
test(`${representation}: observed GitHub evidence follows the claimed branch, binds to the exact head, and never moves a Room gate`, async t => {
  const f = await fixture(t, representation), { world } = f, later = () => f.advance(GITHUB_OBSERVATION_FRESH_MS + 1000);
  f.propose('fix');
  const scope = { repository: REPO, ref: BRANCH, paths: ['src/resume.js'], expiresAt: new Date(Date.UTC(2026, 10, 17)).toISOString() };
  // Without the argument nothing is fetched and nothing is added.
  const plain = await f.call(f.producer, 'room_read_work', { workItemId: 'fix', brief: true });
  assert.equal(plain.github, undefined); assert.equal(plain.continuation.observed, undefined); assert.equal(world.calls.length, 0);

  // D. No scope recorded yet, then no pull request yet: explicit unknowns, no call storm.
  let read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.status, 'unavailable'); assert.equal(read.github.reason, 'no_repository_recorded'); assert.equal(world.calls.length, 0);
  const begun = await f.call(f.producer, 'room_begin_work', { workItemId: 'fix', ...scope });
  assert.equal(begun.working, true, JSON.stringify(begun));
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.reason, 'no_pull_request_found_for_branch');
  assert.equal(read.continuation.observed.status, 'unavailable');
  assert.match(read.continuation.observed.note, /unknown/);
  assert.equal(world.calls.length, 1);

  // C. A same-named branch in a fork, and a pull in another repository, are not this contribution.
  world.pulls = [{ number: 3, head: SHA_B, headRepo: 'mallory/widgets' }, { number: 4, head: SHA_B, repo: 'other/widgets' }];
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.reason, 'no_pull_request_found_for_branch');

  // A. The pull request for the claimed branch: correct repository, full head, checks for that head.
  world.pulls.push({ number: 7, head: SHA_A }); world.runs[SHA_A] = [{ conclusion: null, status: 'in_progress' }];
  let before = world.calls.length;
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.status, 'observed'); assert.equal(read.github.evidenceKind, 'independently_observed');
  assert.deepEqual(read.github.pullRequest, { repository: REPO, number: 7, url: `https://github.com/${REPO}/pull/7`, state: 'open', headSha: SHA_A, mergeCommitSha: null });
  assert.deepEqual(read.github.checks, { headSha: SHA_A, state: 'pending', requiredChecksKnown: false });
  assert.equal(read.github.assessment, 'checks_pending'); assert.equal(read.github.fresh, true);
  assert.equal(read.github.association.from, 'newest_pull_request_for_claimed_branch');
  assert.equal(world.calls.length - before, GITHUB_OBSERVATION_MAX_CALLS);
  assert.deepEqual(read.github.cost, { cacheHit: false, githubCalls: 3, maxCallsPerRefresh: 3 });

  // I. Repeated reads inside the freshness window make no GitHub call, for any member.
  before = world.calls.length;
  for (let i = 0; i < 5; i += 1) assert.equal((await f.observe(i % 2 ? f.reviewer : f.producer, 'fix')).github.cost.cacheHit, true);
  assert.equal(world.calls.length, before);

  // Checks pass on head A. The producer submits. Passing checks do not review the result.
  later(); world.runs[SHA_A] = [{ conclusion: 'success' }, { conclusion: 'skipped' }];
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.assessment, 'checks_passing_observed'); assert.equal(read.github.checks.requiredChecksKnown, false);
  await f.call(f.producer, 'room_post_message', { id: 'fix-result', workItemId: 'fix', body: `Fix pushed to ${BRANCH}; PR 7 at ${SHA_A}.` });
  const preview = await f.call(f.producer, 'room_read_result', { workItemId: 'fix', draftMessageId: 'fix-result' }), text = preview.result.text;
  await f.call(f.producer, 'room_submit_text_result', { workItemId: 'fix', requestId: 'fix-completion', summary: 'Fix pushed', nextAction: 'Review PR 7',
    producerId: f.producer.identityId, evidenceMessageId: text.messageId, evidenceMessageEventId: text.messageEventId, evidenceVersion: text.evidenceVersion, previousCompletionEventId: preview.current.completionEventId });

  // E + J. The reviewer arrives cold. One read gives the Room step and what GitHub reports; the gate is still theirs.
  let review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.continuation.action, 'verify'); assert.equal(review.continuation.tool, 'room_read_work');
  assert.equal(review.continuation.observed.assessment, 'checks_passing_observed'); assert.equal(review.continuation.observed.headSha, SHA_A);
  assert.equal(f.item('fix').verification ?? null, null);

  // B. A new head does not inherit the old head's passing checks.
  later(); world.pulls.find(pull => pull.number === 7).head = SHA_B;
  review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.pullRequest.headSha, SHA_B);
  assert.deepEqual(review.github.checks, { headSha: SHA_B, state: 'none', requiredChecksKnown: false });
  assert.equal(review.github.assessment, 'no_checks_reported');
  assert.equal(review.github.headChanged.from, SHA_A); assert.equal(review.github.headChanged.to, SHA_B);
  assert.equal(review.continuation.observed.headChangedFrom, SHA_A);
  assert.equal(review.continuation.action, 'verify');

  // The retained brief is untouched by observations; the observation still arrives fresh.
  const retained = await f.observe(f.reviewer, 'fix', { knownBriefVersion: review.briefVersion });
  assert.equal(retained.briefUnchanged, true); assert.equal(retained.github.pullRequest.headSha, SHA_B);

  // G. A refresh that fails keeps the last good observation, marked not fresh, with the reason.
  later(); world.fail = 'network';
  review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.status, 'observed'); assert.equal(review.github.fresh, false);
  assert.ok(review.github.ageSeconds >= GITHUB_OBSERVATION_FRESH_MS / 1000);
  assert.equal(review.github.refresh.status, 'unavailable'); assert.match(review.continuation.observed.note, /not refreshed/);
  // A rate limit holds further calls until GitHub's reset.
  world.fail = 'rate'; review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.refresh.reason, 'rate_limited');
  before = world.calls.length; world.fail = null; later();
  assert.equal((await f.observe(f.reviewer, 'fix')).github.refresh.reason, 'rate_limited'); assert.equal(world.calls.length, before);

  // F. Merged is reported as merged and nothing more; the Room review is still outstanding.
  f.advance(11 * 60 * 1000); world.runs[SHA_B] = [{ conclusion: 'success' }];
  Object.assign(world.pulls.find(pull => pull.number === 7), { state: 'closed', mergedSha: SHA_M });
  review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.pullRequest.state, 'merged'); assert.equal(review.github.pullRequest.mergeCommitSha, SHA_M);
  assert.equal(review.github.assessment, 'merged'); assert.match(review.github.meaning, /not a deployment/);
  assert.equal(review.continuation.action, 'verify'); assert.equal(f.item('fix').state, 'completed'); assert.equal(f.item('fix').verification ?? null, null);

  // H. A non-member learns nothing; a batch cannot fan out GitHub reads; no credential appears anywhere.
  const denied = await f.raw(f.stranger, 'room_read_work', { workItemId: 'fix', brief: true, observeGithub: true });
  assert.ok(denied.error || denied.result?.isError === true); assert.doesNotMatch(JSON.stringify(denied), /acme|widgets|[0-9a-f]{40}/);
  const batch = await f.raw(f.producer, 'room_read_work', { workItemIds: ['fix'], observeGithub: true });
  assert.ok(batch.error || batch.result?.isError === true);
  for (const text of f.seen) assert.equal(text.includes(TOKEN), false);
});
}

test('a pull request linked in the claim scope is used only when it is in the claimed repository; private or missing is unknown', async t => {
  const f = await fixture(t, 'normalized-current-v1'), { world } = f;
  const key = f.store.issueAccessKey('commons', f.producer.identityId);
  for (const [id, pullRequests] of [['linked', [`https://github.com/${REPO}/pull/9`]], ['foreign', ['https://github.com/other/widgets/pull/9']]]) {
    f.propose(id);
    f.store.command(key, 'commons', { id: crypto.randomUUID(), type: 'work.accepted', data: { workItemId: id, expectedRevision: f.item(id).revision } });
    f.store.command(key, 'commons', { id: crypto.randomUUID(), type: 'claim.acquired', data: { workItemId: id, expectedRevision: f.item(id).revision,
      repository: REPO, ref: BRANCH, paths: [id + '.js'], expiresAt: new Date(Date.UTC(2026, 10, 17)).toISOString(), pullRequests } });
  }
  world.pulls = [{ number: 9, head: SHA_A }, { number: 9, head: SHA_B, repo: 'other/widgets' }];
  world.status[SHA_A] = { state: 'failure', total_count: 1, statuses: [{ target_url: 'https://ci.example/1' }] };
  const linked = await f.observe(f.producer, 'linked');
  assert.equal(linked.github.association.from, 'pull_request_linked_in_claim_scope');
  assert.equal(linked.github.pullRequest.headSha, SHA_A); assert.equal(linked.github.assessment, 'checks_failing');
  const foreign = await f.observe(f.producer, 'foreign');
  assert.equal(foreign.github.status, 'unavailable'); assert.equal(foreign.github.reason, 'linked_pull_request_is_in_another_repository');
  assert.doesNotMatch(JSON.stringify(foreign.github), new RegExp(SHA_B));
  // No access, or no such pull request: GitHub answers 404 for both. Unknown, not closed and not passing.
  f.advance(GITHUB_OBSERVATION_FRESH_MS + 1000); f.propose('private');
  f.store.command(key, 'commons', { id: crypto.randomUUID(), type: 'work.accepted', data: { workItemId: 'private', expectedRevision: f.item('private').revision } });
  f.store.command(key, 'commons', { id: crypto.randomUUID(), type: 'claim.acquired', data: { workItemId: 'private', expectedRevision: f.item('private').revision,
    repository: 'acme/secret', ref: 'x', paths: ['p.js'], expiresAt: new Date(Date.UTC(2026, 10, 17)).toISOString(), pullRequests: ['https://github.com/acme/secret/pull/1'] } });
  world.fail = 'private';
  const hidden = await f.observe(f.producer, 'private');
  assert.equal(hidden.github.status, 'unavailable'); assert.equal(hidden.github.reason, 'not_found_or_no_access');
  assert.equal(hidden.continuation.observed.status, 'unavailable');
});
