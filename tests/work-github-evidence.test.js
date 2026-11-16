import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { readWorkItem } from '../server/work-repository.mjs';
import { configureGithubObservation, GITHUB_OBSERVATION_FRESH_MS, GITHUB_OBSERVATION_MAX_CALLS, GITHUB_OBSERVATION_PAGE } from '../server/claim-pr-sync.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

// Mocked provider contract tests through Room's real HTTP/MCP entry. They show
// what Room does with what GitHub returns. They are not a real provider read
// and not a live qualification.
const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40), SHA_M = 'c'.repeat(40), SHA_BASE = 'd'.repeat(40), TOKEN = 'ghs_fixture_token_must_never_appear';
const REPO = 'acme/widgets', BRANCH = 'fable/fix-resume';
const run = (name, conclusion, extra = {}) => ({ name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, ...extra });

function github() {
  const world = { pulls: [], status: {}, runs: {}, runTotal: {}, fail: null, calls: [] };
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const pullBody = pull => ({ number: pull.number, html_url: `https://github.com/${pull.repo ?? REPO}/pull/${pull.number}`, url: `https://api.github.com/repos/${pull.repo ?? REPO}/pulls/${pull.number}`,
    title: 'PROVIDER-TITLE-SENTINEL', state: pull.state ?? 'open', merged: Boolean(pull.mergedSha), merged_at: pull.mergedSha ? '2026-11-16T10:00:00Z' : null,
    // GitHub fills merge_commit_sha with a test merge while a pull is open.
    merge_commit_sha: pull.mergedSha ?? 'e'.repeat(40),
    head: { ref: pull.ref ?? BRANCH, sha: pull.head, repo: { full_name: pull.headRepo ?? pull.repo ?? REPO } }, base: { ref: 'main', sha: SHA_BASE, repo: { full_name: pull.repo ?? REPO } } });
  world.fetch = async (url, init = {}) => {
    world.calls.push(String(url));
    assert.equal(init.headers?.Authorization, 'Bearer ' + TOKEN);
    if (world.fail === 'network') throw new Error('socket hang up ' + TOKEN);
    if (world.fail === 'rate') return json({ message: 'API rate limit exceeded PROVIDER-BODY-SENTINEL' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(world.now() / 1000) + 600) });
    if (world.fail === 'private') return json({ message: 'Not Found PROVIDER-BODY-SENTINEL' }, 404);
    const parsed = new URL(url);
    const list = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(parsed.pathname);
    if (list) return json(world.pulls.filter(pull => `${list[1].split('/')[0]}:${pull.ref ?? BRANCH}` === parsed.searchParams.get('head')).map(pullBody));
    const one = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(parsed.pathname);
    if (one) { const pull = world.pulls.find(entry => entry.number === Number(one[2]) && (entry.repo ?? REPO) === one[1]); return pull ? json(pullBody(pull)) : json({ message: 'Not Found' }, 404); }
    const status = /\/commits\/([0-9a-f]{40})\/status$/.exec(parsed.pathname);
    if (status) return json({ sha: status[1], ...(world.status[status[1]] ?? { state: 'pending', total_count: 0, statuses: [] }) });
    const runs = /\/commits\/([0-9a-f]{40})\/check-runs$/.exec(parsed.pathname);
    if (runs) { assert.equal(parsed.searchParams.get('per_page'), String(GITHUB_OBSERVATION_PAGE));
      const listed = (world.runs[runs[1]] ?? []).map((entry, index) => ({ id: index + 1, head_sha: runs[1], app: { slug: 'github-actions' }, started_at: `2026-11-16T10:0${index}:00Z`, ...entry }));
      return json({ total_count: world.runTotal[runs[1]] ?? listed.length, check_runs: listed }); }
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
  const observer = member('Unrelated member', ['accept_work', 'complete_work']);
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
  const command = (type, data, key = owner) => store.command(key, 'commons', { id: crypto.randomUUID(), type, data });
  const propose = (id, extra = {}) => command('work.proposed', { workItemId: id, title: id, definitionOfDone: 'Merged fix with passing checks', accountableMemberId: producer.identityId,
    mode: 'write', verifierMemberId: reviewer.identityId, independentVerificationRequired: true, ...extra });
  const observe = (identity, id, extra = {}) => call(identity, 'room_read_work', { workItemId: id, brief: true, observeGithub: true, ...extra });
  const item = id => readWorkItem(store.db, 'commons', id);
  const producerKey = store.issueAccessKey('commons', producer.identityId);
  const reserve = (id, extra = {}) => { command('work.accepted', { workItemId: id, expectedRevision: item(id).revision }, producerKey);
    command('claim.acquired', { workItemId: id, expectedRevision: item(id).revision, repository: REPO, ref: BRANCH, paths: [id + '.js'],
      expiresAt: new Date(Date.UTC(2026, 10, 17)).toISOString(), ...extra }, producerKey); };
  return { store, owner, world, producer, reviewer, observer, stranger, call, raw, command, propose, observe, reserve, seen, item,
    advance: ms => { clock += ms; }, later: () => { clock += GITHUB_OBSERVATION_FRESH_MS + 1000; } };
}

for (const representation of ['normalized-current-v1', 'legacy']) {
test(`${representation}: a successor reads what GitHub reports for the exact head, and no Room gate moves`, async t => {
  const f = await fixture(t, representation), { world, later } = f;
  f.propose('fix');
  const scope = { repository: REPO, ref: BRANCH, paths: ['src/resume.js'], expiresAt: new Date(Date.UTC(2026, 10, 17)).toISOString() };
  // Without the argument nothing is fetched and nothing is added.
  const plain = await f.call(f.producer, 'room_read_work', { workItemId: 'fix', brief: true });
  assert.equal(plain.github, undefined); assert.equal(plain.continuation.observed, undefined); assert.equal(world.calls.length, 0);

  // G. No scope yet, then no pull request yet: explicit unknowns.
  let read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.status, 'unavailable'); assert.equal(read.github.reason, 'no_repository_recorded'); assert.equal(world.calls.length, 0);
  const begun = await f.call(f.producer, 'room_begin_work', { workItemId: 'fix', ...scope });
  assert.equal(begun.working, true, JSON.stringify(begun));
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.reason, 'no_pull_request_found_for_branch');
  assert.equal(read.continuation.observed.status, 'unavailable'); assert.match(read.continuation.observed.note, /unknown/);
  assert.equal(world.calls.length, 1);
  // N. An unavailable answer is remembered for the same window: no call per repeated read.
  for (let i = 0; i < 4; i += 1) assert.equal((await f.observe(f.producer, 'fix')).github.reason, 'no_pull_request_found_for_branch');
  assert.equal(world.calls.length, 1);

  // C. A same-named branch in a fork, and a pull in another repository, are not this contribution.
  world.pulls = [{ number: 3, head: SHA_B, headRepo: 'mallory/widgets' }, { number: 4, head: SHA_B, repo: 'other/widgets' }];
  later();
  assert.equal((await f.observe(f.producer, 'fix')).github.reason, 'no_pull_request_found_for_branch');

  // A + K. The pull request for the claimed branch: repository, number, full head, base, checks for that head.
  later(); world.pulls.push({ number: 7, head: SHA_A }); world.runs[SHA_A] = [run('unit', null)];
  let before = world.calls.length;
  const sequence = f.store.headSequence('commons');
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.status, 'observed'); assert.equal(read.github.evidenceKind, 'independently_observed');
  assert.deepEqual(read.github.pullRequest, { repository: REPO, number: 7, url: `https://github.com/${REPO}/pull/7`, state: 'open',
    headSha: SHA_A, baseRef: 'main', baseSha: SHA_BASE, mergeCommitSha: null });
  assert.equal(read.github.checks.headSha, SHA_A); assert.equal(read.github.checks.state, 'pending'); assert.equal(read.github.checks.requiredChecksKnown, false);
  assert.deepEqual(read.github.checks.items, [{ kind: 'check_run', name: 'unit', status: 'in_progress', conclusion: null, result: 'pending' }]);
  assert.equal(read.github.assessment, 'checks_pending'); assert.equal(read.github.fresh, true);
  assert.equal(read.github.association.from, 'newest_pull_request_for_claimed_branch');
  assert.equal(world.calls.length - before, GITHUB_OBSERVATION_MAX_CALLS);
  assert.deepEqual(read.github.cost, { cacheHit: false, githubCalls: 3, maxCallsPerRefresh: 3 });
  assert.doesNotMatch(JSON.stringify(read), /PROVIDER-TITLE-SENTINEL/, 'only identity, state and check results are carried, not provider prose');

  // N. Repeated reads inside the freshness window make no GitHub call, for any authorized member.
  before = world.calls.length;
  for (let i = 0; i < 5; i += 1) assert.equal((await f.observe(i % 2 ? f.reviewer : f.producer, 'fix')).github.cost.cacheHit, true);
  assert.equal(world.calls.length, before);

  // D. A skipped job is not a pass, and a lone success with skips says so. Only-skipped is not success at all.
  later(); world.runs[SHA_A] = [run('unit', 'skipped'), run('integration', 'skipped')];
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.checks.state, 'none_substantive'); assert.equal(read.github.assessment, 'only_skipped_or_neutral_checks');
  later(); world.runs[SHA_A] = [run('unit', 'skipped'), run('CI gate (NOTHING RAN)', 'success'), run('lint', 'neutral')];
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.assessment, 'reported_checks_succeeded');
  assert.deepEqual(read.github.checks.counts, { success: 1, failure: 0, pending: 0, cancelled: 0, skipped: 1, neutral: 1, unknown: 0 });
  assert.match(read.github.meaning, /1 check\(s\) succeeded.*2 skipped or neutral.*required.*not known/);
  assert.ok(read.github.checks.items.some(entry => entry.name === 'CI gate (NOTHING RAN)' && entry.result === 'success'), 'names are shown so a hollow gate is visible');
  later(); world.runs[SHA_A] = [run('unit', 'cancelled'), run('lint', 'success')];
  assert.equal((await f.observe(f.producer, 'fix')).github.assessment, 'checks_cancelled');

  // E. Reruns: the entry that started last wins, whichever way it went and whatever the array order.
  later(); world.runs[SHA_A] = [run('unit', 'failure', { started_at: '2026-11-16T11:30:00Z' }), run('unit', 'success', { started_at: '2026-11-16T11:00:00Z' })];
  assert.equal((await f.observe(f.producer, 'fix')).github.assessment, 'checks_failing', 'a newer failure replaces an earlier success');
  later(); world.runs[SHA_A] = [run('unit', 'failure', { started_at: '2026-11-16T11:30:00Z' }), run('unit', 'success', { started_at: '2026-11-16T11:45:00Z' })];
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.assessment, 'reported_checks_succeeded'); assert.equal(read.github.checks.counts.failure, 0);

  // F. More results than one page, or a run for another revision: incomplete, never a pass.
  later(); world.runs[SHA_A] = [run('unit', 'success')]; world.runTotal[SHA_A] = 140;
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.checks.state, 'incomplete'); assert.equal(read.github.checks.complete, false);
  assert.deepEqual(read.github.checks.incomplete, ['more_check_runs_than_one_page']); assert.equal(read.github.assessment, 'checks_incomplete');
  later(); delete world.runTotal[SHA_A]; world.runs[SHA_A] = [run('unit', 'success'), run('unit-old', 'success', { head_sha: SHA_B })];
  read = await f.observe(f.producer, 'fix');
  assert.equal(read.github.checks.counts.success, 1); assert.deepEqual(read.github.checks.incomplete, ['check_runs_for_another_revision_ignored']);

  // The producer submits with all reported checks green on head A.
  later(); world.runs[SHA_A] = [run('unit', 'success'), run('lint', 'success')];
  assert.equal((await f.observe(f.producer, 'fix')).github.assessment, 'reported_checks_succeeded');
  await f.call(f.producer, 'room_post_message', { id: 'fix-result', workItemId: 'fix', body: `Fix pushed to ${BRANCH}; CI PASSED; MERGED. Head ${SHA_M}.` });
  const preview = await f.call(f.producer, 'room_read_result', { workItemId: 'fix', draftMessageId: 'fix-result' }), text = preview.result.text;
  await f.call(f.producer, 'room_submit_text_result', { workItemId: 'fix', requestId: 'fix-completion', summary: 'Fix pushed, merged', nextAction: 'Review PR 7',
    producerId: f.producer.identityId, evidenceMessageId: text.messageId, evidenceMessageEventId: text.messageEventId, evidenceVersion: text.evidenceVersion, previousCompletionEventId: preview.current.completionEventId });

  // I + O. The reviewer arrives cold. One read gives the Room step and what GitHub reports. The member's
  // "MERGED" and the SHA in their text change nothing in the observation, and the gate is still the reviewer's.
  let review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.continuation.action, 'verify'); assert.equal(review.continuation.tool, 'room_read_work');
  assert.equal(review.github.pullRequest.state, 'open'); assert.equal(review.github.pullRequest.headSha, SHA_A);
  assert.equal(review.continuation.observed.assessment, 'reported_checks_succeeded'); assert.equal(review.continuation.observed.requiredChecksKnown, false);
  assert.equal(f.item('fix').verification ?? null, null);

  // B. Force-push to head B: the old head's result is historical and B starts with nothing.
  later(); world.pulls.find(pull => pull.number === 7).head = SHA_B;
  review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.pullRequest.headSha, SHA_B); assert.equal(review.github.checks.headSha, SHA_B);
  assert.equal(review.github.checks.state, 'none'); assert.equal(review.github.assessment, 'no_checks_reported');
  assert.equal(review.github.superseded.headSha, SHA_A); assert.equal(review.github.superseded.checksState, 'success');
  assert.equal(review.continuation.observed.supersededHeadSha, SHA_A); assert.equal(review.continuation.action, 'verify');

  // The retained brief is untouched by observations; the observation still arrives current.
  const retained = await f.observe(f.reviewer, 'fix', { knownBriefVersion: review.briefVersion });
  assert.equal(retained.briefUnchanged, true); assert.equal(retained.github.pullRequest.headSha, SHA_B);

  // H + G. A failed refresh keeps the last observation with its original time: last known, not current.
  const observedAt = review.github.observedAt;
  later(); world.fail = 'network';
  review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.status, 'observed'); assert.equal(review.github.fresh, false); assert.equal(review.github.current, 'unknown');
  assert.equal(review.github.observedAt, observedAt); assert.ok(review.github.ageSeconds >= GITHUB_OBSERVATION_FRESH_MS / 1000);
  assert.match(review.continuation.observed.note, /Last known observation.*current state unknown/);
  later(); world.fail = 'rate'; review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.refresh.reason, 'rate_limited');
  before = world.calls.length; world.fail = null; later();
  assert.equal((await f.observe(f.reviewer, 'fix')).github.refresh.reason, 'rate_limited', 'the shared hold stops further calls until the reset'); assert.equal(world.calls.length, before);

  // Closed without merge is not merged; reopened reflects the current state.
  f.advance(11 * 60 * 1000); world.runs[SHA_B] = [run('unit', 'success')];
  const pull = world.pulls.find(entry => entry.number === 7); pull.state = 'closed';
  review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.pullRequest.state, 'closed'); assert.equal(review.github.assessment, 'closed_unmerged'); assert.equal(review.github.pullRequest.mergeCommitSha, null);
  later(); pull.state = 'open';
  assert.equal((await f.observe(f.reviewer, 'fix')).github.pullRequest.state, 'open');

  // L + M. Merged is reported as merged and nothing more. Nothing in Room moved, and nothing was written.
  later(); Object.assign(pull, { state: 'closed', mergedSha: SHA_M });
  review = await f.observe(f.reviewer, 'fix');
  assert.equal(review.github.pullRequest.state, 'merged'); assert.equal(review.github.pullRequest.mergeCommitSha, SHA_M);
  assert.notEqual(review.github.pullRequest.mergeCommitSha, review.github.pullRequest.headSha);
  assert.equal(review.github.assessment, 'merged'); assert.match(review.github.meaning, /not a deployment/);
  assert.equal(review.continuation.action, 'verify'); assert.equal(f.item('fix').state, 'completed'); assert.equal(f.item('fix').verification ?? null, null);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM work_claim_config WHERE room_id LIKE '%observation%'").get().n, 0, 'observations are not persisted');

  // A non-member learns nothing; a batch cannot fan out GitHub reads; no credential or provider body appears anywhere.
  const denied = await f.raw(f.stranger, 'room_read_work', { workItemId: 'fix', brief: true, observeGithub: true });
  assert.ok(denied.error || denied.result?.isError === true); assert.doesNotMatch(JSON.stringify(denied), /acme|widgets|[0-9a-f]{40}/);
  const batch = await f.raw(f.producer, 'room_read_work', { workItemIds: ['fix'], observeGithub: true });
  assert.ok(batch.error || batch.result?.isError === true);
  for (const text of f.seen) { assert.equal(text.includes(TOKEN), false); assert.equal(text.includes('PROVIDER-BODY-SENTINEL'), false); }
  void sequence;
});
}

test('a linked pull request must be in the claimed repository; no access and missing are the same unknown', async t => {
  const f = await fixture(t, 'normalized-current-v1'), { world } = f;
  for (const [id, pullRequests] of [['linked', [`https://github.com/${REPO}/pull/9`]], ['foreign', ['https://github.com/other/widgets/pull/9']]]) { f.propose(id); f.reserve(id, { pullRequests }); }
  world.pulls = [{ number: 9, head: SHA_A }, { number: 9, head: SHA_B, repo: 'other/widgets' }];
  world.status[SHA_A] = { state: 'failure', total_count: 1, statuses: [{ context: 'ci/build', state: 'failure', updated_at: '2026-11-16T11:00:00Z' }] };
  const linked = await f.observe(f.producer, 'linked');
  assert.equal(linked.github.association.from, 'pull_request_linked_in_claim_scope');
  assert.equal(linked.github.pullRequest.headSha, SHA_A); assert.equal(linked.github.assessment, 'checks_failing');
  assert.deepEqual(linked.github.checks.items, [{ kind: 'commit_status', name: 'ci/build', status: 'failure', conclusion: null, result: 'failure' }]);
  const foreign = await f.observe(f.producer, 'foreign');
  assert.equal(foreign.github.status, 'unavailable'); assert.equal(foreign.github.reason, 'linked_pull_request_is_in_another_repository');
  assert.doesNotMatch(JSON.stringify(foreign.github), new RegExp(SHA_B));
  f.later(); f.propose('gone'); f.reserve('gone', { repository: 'acme/secret', ref: 'x', pullRequests: ['https://github.com/acme/secret/pull/1'] });
  world.fail = 'private';
  const hidden = await f.observe(f.producer, 'gone');
  assert.equal(hidden.github.status, 'unavailable'); assert.equal(hidden.github.reason, 'not_found_or_no_access');
  assert.equal(hidden.continuation.observed.status, 'unavailable');
});

for (const representation of ['normalized-current-v1', 'legacy']) {
test(`${representation}: a private task's GitHub evidence reaches its parties and nobody else, cached or not`, async t => {
  const f = await fixture(t, representation), { world } = f;
  f.propose('secret-fix', { title: 'PRIVATE-TITLE-SENTINEL', definitionOfDone: 'PRIVATE-DONE-SENTINEL' });
  f.store.dmConsents.request('commons', 'owner', f.producer.identityId, 'Private brief');
  f.store.dmConsents.decide('commons', f.producer.identityId, 'owner', 'approve');
  f.command('message.posted', { messageId: 'private-question', toMemberId: f.producer.identityId, workItemId: 'secret-fix', requestKind: 'reply', body: 'PRIVATE-BODY-SENTINEL' });
  f.reserve('secret-fix', { repository: 'acme/private-repo', ref: 'secret-branch' });
  world.pulls = [{ number: 11, head: SHA_A, repo: 'acme/private-repo', ref: 'secret-branch' }]; world.runs[SHA_A] = [run('secret-check-name', 'failure')];
  const leak = /private-repo|secret-branch|secret-check-name|pull\/11|a{40}|SENTINEL/;
  // The new fields only. What the selected read itself already shows an unrelated member is a separate, existing boundary.
  const added = async args => { const answer = (await f.raw(f.observer, 'room_read_work', args)).result?.structuredContent ?? {};
    return JSON.stringify({ github: answer.github ?? null, observed: answer.continuation?.observed ?? null }); };

  // Before any party has read it: the unrelated member triggers no GitHub call and learns nothing from the new fields.
  const cold = await added({ workItemId: 'secret-fix', brief: true, observeGithub: true });
  assert.doesNotMatch(cold, leak); assert.match(cold, /not_visible_to_this_member/); assert.equal(world.calls.length, 0);

  // K. The party gets the useful observation; so does the named reviewer, a role holder.
  const party = await f.observe(f.producer, 'secret-fix');
  assert.equal(party.github.status, 'observed'); assert.equal(party.github.pullRequest.repository, 'acme/private-repo');
  assert.equal(party.github.assessment, 'checks_failing'); assert.equal(party.github.checks.items[0].name, 'secret-check-name');
  assert.equal((await f.observe(f.reviewer, 'secret-fix')).github.status, 'observed');

  // J. With the observation now cached, the unrelated member still gets nothing through brief or full read, and spends no call.
  const calls = world.calls.length;
  for (const args of [{ workItemId: 'secret-fix', brief: true, observeGithub: true }, { workItemId: 'secret-fix', observeGithub: true }]) {
    const answer = await added(args);
    assert.doesNotMatch(answer, leak, JSON.stringify(args)); assert.match(answer, /not_visible_to_this_member/);
  }
  assert.equal(world.calls.length, calls);
  // Lists and project state carry no observation at all.
  for (const [name, args] of [['room_project_state', {}], ['room_list_work', {}]]) assert.doesNotMatch(JSON.stringify(await f.call(f.observer, name, args)), /private-repo|secret-branch|secret-check-name|a{40}/);
});
}
