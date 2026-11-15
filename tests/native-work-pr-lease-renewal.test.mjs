// Native work <-> pull request: a pull request tagged claim:<workItemId> from
// the claim's exact repository and branch links to the claim, and each new push
// renews the lease. Polling only; no webhook, no GitHub App.
import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {auditRecovery} from '../server/recovery.mjs';
import {hasClaimTag, pullMatchesClaim, renewNativeLeasesFromPulls, nativeRenewDueAt, MAX_RENEWALS_PER_CLAIM} from '../server/native-work-pr-sync.mjs';
import {readConfig, writeConfig} from '../server/claim-autolink.mjs';
import {readClaimPullBudget} from '../server/claim-pr-sync.mjs';

const T0 = Date.parse('2026-11-15T10:00:00.000Z');
const SHA = n => String(n).padStart(40, 'a').slice(-40);
function fixture(t) {
  let now = T0;
  const s = new RoomStore(':memory:', {now: () => now});
  t.after(() => s.close());
  s.initialize(initialRoom('commons', 'owner'), {representation: 'normalized-current-v1'});
  const ownerKey = s.issueAccessKey('commons', 'owner');
  const issued = s.invites.create(ownerKey, 'commons', {profile: 'agent_member', displayName: 'Agent A'});
  const joined = s.invites.redeem(issued.code, {displayName: 'Agent A'});
  const a = {id: joined.memberId, key: joined.identitySecret};
  const cmd = (key, id, type, data) => s.command(key, 'commons', {id, type, data});
  const item = id => JSON.parse(s.db.prepare('SELECT body FROM work_entities WHERE work_id=?').get(id).body);
  const claimed = (workItemId = 'w1', ref = 'agent-a/work', leaseMinutes = 20) => {
    cmd(ownerKey, `p-${workItemId}`, 'work.proposed', {workItemId, title: `Task ${workItemId}`, definitionOfDone: 'Merged PR', accountableMemberId: a.id, mode: 'write'});
    cmd(a.key, `a-${workItemId}`, 'work.accepted', {workItemId});
    cmd(a.key, `c-${workItemId}`, 'claim.acquired', {workItemId, repository: 'acme/app', ref, paths: [`src/${workItemId}.js`], expiresAt: new Date(now + leaseMinutes * 60000).toISOString()});
  };
  const pull = (over = {}) => ({number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'Fix the thing', body: 'claim:w1\n\nDetails', head: {ref: 'agent-a/work', sha: SHA(1), repo: {full_name: 'acme/app'}}, ...over});
  const fetchOf = pulls => async () => new Response(JSON.stringify(pulls), {status: 200, headers: {'content-type': 'application/json'}});
  const run = (pulls, extra = {}) => renewNativeLeasesFromPulls(s, {fetchImpl: fetchOf(pulls), token: 'test', nowMs: now, ...extra});
  return {s, ownerKey, a, cmd, item, claimed, pull, run, fetchOf, advance: ms => { now += ms; }, now: () => now};
}

test('the tag must name the exact work item id', () => {
  assert.equal(hasClaimTag('claim:w1', 'w1'), true);
  assert.equal(hasClaimTag('Fixes things\n\nclaim: w1 ', 'w1'), true);
  assert.equal(hasClaimTag('(claim=w1)', 'w1'), true);
  assert.equal(hasClaimTag('claim:w10', 'w1'), false);
  assert.equal(hasClaimTag('claim:w1-extra', 'w1'), false);
  assert.equal(hasClaimTag('reclaim:w1', 'w1'), false);
  assert.equal(hasClaimTag('w1', 'w1'), false);
  assert.equal(hasClaimTag('claim:a.b', 'a.b'), true);
  assert.equal(hasClaimTag('claim:aXb', 'a.b'), false);
  assert.equal(hasClaimTag(null, 'w1'), false);
});

test('a tagged pull request from the claim branch links and renews; the same head does not renew twice', async t => {
  const f = fixture(t);
  f.claimed();
  const before = f.item('w1').claim;
  assert.equal(before.expiresAt, new Date(T0 + 20 * 60000).toISOString());
  f.advance(10 * 60000);
  const first = await f.run([f.pull()]);
  assert.equal(first.renewed.length, 1);
  assert.deepEqual(first.renewed[0], {roomId: 'commons', workItemId: 'w1', url: 'https://github.com/acme/app/pull/7', headSha: SHA(1)});
  const claim = f.item('w1').claim;
  assert.equal(claim.expiresAt, new Date(f.now() + 60 * 60000).toISOString());
  assert.equal(claim.renewals, 1);
  assert.equal(claim.renewedAt, new Date(f.now()).toISOString());
  assert.equal(claim.pullRequest.url, 'https://github.com/acme/app/pull/7');
  assert.equal(claim.pullRequest.headSha, SHA(1));
  assert.equal(claim.holderId, f.a.id, 'the holder is unchanged');
  // Same head, polled again: no new event.
  f.advance(3 * 60000);
  const seq = f.s.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons').sequence;
  assert.equal((await f.run([f.pull()])).renewed.length, 0);
  assert.equal(f.s.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('commons').sequence, seq);
  // A new push renews again and moves the recorded head.
  f.advance(3 * 60000);
  const second = await f.run([f.pull({head: {ref: 'agent-a/work', sha: SHA(2), repo: {full_name: 'acme/app'}}})]);
  assert.equal(second.renewed.length, 1);
  assert.equal(f.item('w1').claim.renewals, 2);
  assert.equal(f.item('w1').claim.pullRequest.headSha, SHA(2));
  assert.doesNotThrow(() => auditRecovery(f.s));
});

test('the event is attributed to the holder and says where the renewal came from', async t => {
  const f = fixture(t);
  f.claimed();
  await f.run([f.pull()]);
  const row = f.s.db.prepare("SELECT body FROM events WHERE room_id='commons' ORDER BY sequence DESC LIMIT 1").get();
  const recorded = JSON.parse(row.body);
  assert.equal(recorded.type, 'claim.renewed');
  assert.equal(recorded.actorId, f.a.id);
  assert.equal(recorded.data.source, 'pr-poll');
  assert.equal(recorded.data.prHeadSha, SHA(1));
  assert.equal(recorded.data.prUrl, 'https://github.com/acme/app/pull/7');
  assert.equal(recorded.data.workItemId, 'w1');
});

test('a pull request that does not match the claim renews nothing', async t => {
  const f = fixture(t);
  f.claimed('w1', 'agent-a/work', 180);
  const cases = {
    'no tag': f.pull({body: 'just a fix', title: 'Fix'}),
    'tag for another item': f.pull({body: 'claim:w2'}),
    'tag only partly matches': f.pull({body: 'claim:w10'}),
    'wrong branch': f.pull({head: {ref: 'someone-else/work', sha: SHA(1), repo: {full_name: 'acme/app'}}}),
    'fork with the same branch name': f.pull({head: {ref: 'agent-a/work', sha: SHA(1), repo: {full_name: 'mallory/app'}}}),
    'missing head repo (deleted fork)': f.pull({head: {ref: 'agent-a/work', sha: SHA(1), repo: null}}),
    'bad sha': f.pull({head: {ref: 'agent-a/work', sha: 'main', repo: {full_name: 'acme/app'}}}),
    'url on another repo': f.pull({html_url: 'https://github.com/other/app/pull/7'}),
    'non-github url': f.pull({html_url: 'https://evil.example/acme/app/pull/7'}),
  };
  for (const [name, pr] of Object.entries(cases)) {
    const result = await f.run([pr]);
    assert.equal(result.renewed.length, 0, name);
    f.advance(2.5 * 60000);
  }
  assert.equal(f.item('w1').claim.renewals, undefined);
  // A tag in the title also links.
  const result = await f.run([f.pull({body: '', title: 'claim:w1 Fix the thing'})]);
  assert.equal(result.renewed.length, 1);
});

test('a lapsed or released claim is not renewed, and the lease is never revived by a push', async t => {
  const f = fixture(t);
  f.claimed();
  f.advance(25 * 60000); // past the 20 minute lease
  assert.equal(nativeRenewDueAt(f.s, f.now()), null);
  assert.equal((await f.run([f.pull()])).renewed.length, 0);
  assert.equal(f.item('w1').claim.status, 'active', 'stored status is untouched; the lease simply lapsed');
  assert.equal(f.item('w1').claim.renewals, undefined);
  // Released claims are skipped too.
  const g = fixture(t);
  g.claimed();
  g.cmd(g.a.key, 'release', 'claim.released', {workItemId: 'w1'});
  assert.equal(nativeRenewDueAt(g.s, g.now()), null);
  assert.equal((await g.run([g.pull()])).renewed.length, 0);
});

test('automatic renewals per claim are capped', async t => {
  const f = fixture(t);
  f.claimed();
  writeConfig(f.s, '_native-pr-renew:commons:w1', {url: 'https://github.com/acme/app/pull/7', headSha: SHA(9), renewals: MAX_RENEWALS_PER_CLAIM, renewedAt: f.now()}, f.now());
  assert.equal((await f.run([f.pull()])).renewed.length, 0);
  assert.equal(f.item('w1').claim.renewals, undefined);
});

test('a rate limit holds the poll for everyone and is not retried', async t => {
  const f = fixture(t);
  f.claimed();
  let fetched = 0;
  const limited = async () => { fetched++; return new Response('{}', {status: 429, headers: {'retry-after': '120'}}); };
  const first = await renewNativeLeasesFromPulls(f.s, {fetchImpl: limited, token: 'test', nowMs: f.now()});
  assert.equal(first.rateLimited, true);
  assert.ok(readClaimPullBudget(f.s) > f.now());
  const second = await renewNativeLeasesFromPulls(f.s, {fetchImpl: limited, token: 'test', nowMs: f.now()});
  assert.equal(second.rateLimited, true);
  assert.equal(fetched, 1);
});

test('an unreadable pull list renews nothing and backs the repository off', async t => {
  const f = fixture(t);
  f.claimed();
  let fetched = 0;
  const broken = async () => { fetched++; return new Response('nope', {status: 500}); };
  assert.equal((await renewNativeLeasesFromPulls(f.s, {fetchImpl: broken, token: 'test', nowMs: f.now()})).renewed.length, 0);
  assert.equal((await renewNativeLeasesFromPulls(f.s, {fetchImpl: broken, token: 'test', nowMs: f.now()})).repos, 0, 'backed off');
  assert.equal(fetched, 1);
  assert.ok(readConfig(f.s, '_native-pr-poll:acme/app').nextAt > f.now());
});

test('pullMatchesClaim requires a full 40-character head and a GitHub pull URL', () => {
  const claim = {workItemId: 'w1', repository: 'acme/app', ref: 'b'};
  const ok = {html_url: 'https://github.com/acme/app/pull/3', body: 'claim:w1', head: {ref: 'b', sha: SHA(3), repo: {full_name: 'ACME/app'}}};
  assert.deepEqual(pullMatchesClaim(ok, claim), {url: 'https://github.com/acme/app/pull/3', headSha: SHA(3)});
  assert.equal(pullMatchesClaim({...ok, head: {...ok.head, sha: SHA(3).slice(1)}}, claim), null);
  assert.equal(pullMatchesClaim(null, claim), null);
  assert.equal(pullMatchesClaim({}, claim), null);
});

test('events recorded without a pull request replay unchanged: a plain renewal has no link', t => {
  const f = fixture(t);
  f.claimed();
  f.cmd(f.a.key, 'plain-renew', 'claim.renewed', {workItemId: 'w1', expiresAt: new Date(f.now() + 30 * 60000).toISOString()});
  assert.equal(f.item('w1').claim.pullRequest, undefined);
  assert.equal(f.item('w1').claim.renewals, 1);
});
