// Shadow-compare parity harness — redesign charter B-2, PR4 (matcher).
//
// PublicWorkClaims.match() used to scan its candidate window with its
// own unclaimed filter over facade.list(). The candidate window now
// comes from the AvailableWork projection (availablePublicTasks window
// mode); scoring, the age tiebreak and the path-overlap exclusion are
// unchanged ranking layers over it. This harness carries a reference
// copy of the LEGACY algorithm (below) and requires the live match()
// to agree with it — recommendations (packets, reasons, order),
// inspected, hasMore, nextCursor, reasonCode, and the autoClaim choice —
// across the input matrix, on a production-shaped board.
//
// Remove after one clean release on the B-2 stack (the standing
// regression coverage is tests/public-work-claimable.test.js and the
// public-work match suites).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkClaims, publicWorkClaimsSchema } from '../server/public-work-claims.mjs';
import { publicWorkClaimFenceSchema } from '../server/public-work-claim-fence.mjs';
import { releaseExpired } from '../server/work-claims.mjs';

const overlaps = (left, right) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
const claim = (requestId, extra = {}) => ({ requestId, expectedTermsVersion: 1, ...extra });
const owned = (requestId, generation, extra = {}) => ({ ...claim(requestId), generation, ...extra });

// Board (offer_id order): a-docs (docs), b-code (typescript), c-both
// (docs+typescript), d-taken (claimed, holds src/shared.js), e-blocked
// (unclaimed but its only path is under d-taken's live claim),
// f-plain (no preference words), g-done (submitted). Ages increase with
// enable order via the fixture clock, so score ties break by age.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-parity-match-')), file = join(dir, 'room.sqlite');
  let clock = 1_760_000_000_000;
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const service = new PublicWorkClaims(store);
  const enable = (id, title, criteria, files) => {
    clock += 60_000;
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title, summary: 'Public result', acceptanceCriteria: criteria,
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service.enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files });
  };
  enable('a-docs', 'Write the docs guide', ['documentation for newcomers'], ['docs/guide.md']);
  enable('b-code', 'Fix the parser', ['typescript parser correctness'], ['src/parser.ts']);
  enable('c-both', 'Docs for typescript tooling', ['documentation', 'typescript'], ['docs/ts.md']);
  enable('d-taken', 'Tidy shared module', ['refactor'], ['src/shared.js']);
  enable('e-blocked', 'Extend shared module', ['refactor'], ['src/shared.js']);
  enable('f-plain', 'Sweep the porch', ['tidy up'], ['misc/porch.txt']);
  enable('g-done', 'Archive old notes', ['documentation archive'], ['docs/old.md']);
  const [w1, w2] = [store.identities.create('Match parity one'), store.identities.create('Match parity two')];
  service.act('d-taken', w1.secret, 'claim', claim('claim-d'));
  service.act('g-done', w2.secret, 'claim', claim('claim-g'));
  service.act('g-done', w2.secret, 'finish', owned('finish-g', 1, { artifactText: 'Done g', checksReported: [] }));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, w1, w2 };
}

// The LEGACY candidate scan + ranking, copied from match() before B-2
// PR4: facade window, own unclaimed filter, same scoring/sort. Returns
// the comparable projection of the outcome (taskets as packets).
function legacyRecommend(service, store, input) {
  const limit = input.limit ?? 3;
  const preferences = ['skills', 'interests'].flatMap(key => (input[key] ?? []).map(v => v.trim().toLowerCase()));
  const outcome = { recommendations: [], inspected: 0, hasMore: false, nextCursor: null };
  const page = service.list({ limit: 100, after: input.after ?? '', claimableFirst: false });
  outcome.inspected = page.tasks.length; outcome.hasMore = page.nextCursor !== null; outcome.nextCursor = page.nextCursor;
  const ages = new Map(page.tasks.length ? store.db.prepare(`SELECT offer_id,created_at FROM public_work_tasks WHERE offer_id IN (${page.tasks.map(() => '?').join(',')})`).all(...page.tasks.map(task => task.taskId)).map(row => [row.offer_id, row.created_at]) : []);
  const candidates = page.tasks.filter(task => {
    if (task.claim.state !== 'unclaimed') return false;
    return !releaseExpired(store.workClaims.list(task.namespaceId), store.now()).some(other =>
      other.id !== task.taskId && other.owner && other.files.some(path => task.files.some(file => overlaps(path, file))));
  }).map(task => {
    const text = [task.title, ...task.acceptanceCriteria].join(' ').toLowerCase();
    const matched = [...new Set(preferences.filter(value => text.includes(value)))];
    return { task, score: matched.length, reasons: matched.length ? matched.map(value => 'Matches preference: ' + value) : ['Available volunteer task with declared repository paths'] };
  }).sort((l, r) => r.score - l.score || ages.get(l.task.taskId) - ages.get(r.task.taskId) || (l.task.taskId < r.task.taskId ? -1 : l.task.taskId > r.task.taskId ? 1 : 0));
  outcome.recommendations = candidates.slice(0, limit).map(({ task, reasons }) => ({ task, reasons }));
  if (!candidates.length && outcome.inspected > 0 && page.tasks.every(task => !task.claimable)) outcome.reasonCode = 'no_claimable_tasks';
  return outcome;
}

const comparable = outcome => ({
  recommendations: outcome.recommendations.map(({ task, reasons }) => ({ task, reasons })),
  inspected: outcome.inspected, hasMore: outcome.hasMore, nextCursor: outcome.nextCursor,
  reasonCode: outcome.reasonCode ?? null,
});

test('match() ≡ legacy scan across the preference/limit/cursor matrix', t => {
  const { store, service } = fixture(t);
  const inputs = [
    {}, { skills: ['docs'] }, { interests: ['typescript'] },
    { skills: ['documentation', 'typescript'] }, { interests: ['refactor'] },
    { skills: ['nonexistent-word'] }, { skills: ['docs'], limit: 1 },
    { skills: ['docs'], limit: 5 }, { interests: ['typescript'], limit: 2 },
    { after: 'b-code' }, { after: 'd-taken', skills: ['refactor'] }, { after: 'g-done' },
  ];
  for (const input of inputs) {
    const live = comparable(service.match(null, { ...input }));
    const legacy = comparable(legacyRecommend(service, store, input));
    assert.deepEqual(live, legacy, JSON.stringify(input));
  }
});

test('match() autoClaim picks the same task the legacy scan ranks first', t => {
  const a = fixture(t), b = fixture(t);
  const input = { requestId: 'parity-auto-1', autoClaim: true, interests: ['typescript'], limit: 3 };
  const live = a.service.match(a.w1.secret, { ...input });
  // Legacy expectation on the identical board: b-code and c-both both
  // score 1 for "typescript"; b-code is older, so it wins the tiebreak.
  const legacy = legacyRecommend(b.service, b.store, { interests: ['typescript'], limit: 3 });
  assert.equal(legacy.recommendations[0].task.taskId, 'b-code');
  assert.equal(live.claim.task.taskId, 'b-code');
  assert.deepEqual(live.recommendations.map(r => r.task.taskId), legacy.recommendations.map(r => r.task.taskId));
  assert.deepEqual(live.recommendations.map(r => r.reasons), legacy.recommendations.map(r => r.reasons));
});

test('match() on an exhausted board keeps the no_claimable_tasks reasonCode', t => {
  // A two-task board where nothing is claimable: one claimed, one
  // submitted. (The shared-path pair in the main fixture can never both
  // be claimed at once, so the exhausted case needs its own board.)
  const dir = mkdtempSync(join(tmpdir(), 'aw-parity-match-empty-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file, { now: () => Date.now() });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  const service = new PublicWorkClaims(store);
  const enable = (id, title, files) => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
      terms: { kind: 'task', title, summary: 'Public result', acceptanceCriteria: ['documentation'],
        repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
    store.projectOffers.transition('commons', 'owner', id, 'publish', { requestId: `publish-${id}`, expectedRevision: 1 });
    return service.enable('commons', 'owner', id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files });
  };
  enable('h-claimed', 'Docs held', ['docs/h.md']);
  enable('i-done', 'Docs finished', ['docs/i.md']);
  const w = store.identities.create('Match parity three');
  service.act('h-claimed', w.secret, 'claim', claim('claim-h'));
  service.act('i-done', w.secret, 'claim', claim('claim-i'));
  service.act('i-done', w.secret, 'finish', owned('finish-i', 1, { artifactText: 'Done i', checksReported: [] }));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const live = comparable(service.match(null, { skills: ['docs'] }));
  const legacy = comparable(legacyRecommend(service, store, { skills: ['docs'] }));
  assert.equal(live.reasonCode, 'no_claimable_tasks');
  assert.equal(live.inspected, 2);
  assert.deepEqual(live, legacy);
});
