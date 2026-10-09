// WAVE-400 fuzz worker: claim scope enforcement (test-only, no production edits).
// Targets: src/workflow.js mayWriteBoardClaims, server/work-claim-routes.mjs
// mayWriteWorkClaims, server/claim-scopes.mjs claimScope/conflictingClaim, and
// the live store admission gate for claim commands.
// Invariants: every out-of-scope attempt is denied; denial leaves state
// unchanged; verdicts are deterministic and consistent; no hostile scope
// string normalizes into a broader scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T, PERMISSIONS } from '../src/events.js';
import { claimScope, conflictingClaim } from '../server/claim-scopes.mjs';
import { mayWriteBoardClaims, activeClaim } from '../src/workflow.js';
import { mayWriteWorkClaims } from '../server/work-claim-routes.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

const SEED = Number(process.env.FUZZ_SEED ?? 20261008);
console.log(`[fuzz-16] seed=${SEED}`);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = arr => arr[Math.floor(rand() * arr.length)];
let cases = 0;
const bump = (n = 1) => { cases += n; };

// ---------------------------------------------------------------------------
// Oracle for the board-writer profile rule, written independently from the
// two implementations under test (src/workflow.js and
// server/work-claim-routes.mjs). Documented rule: the room owner; a human
// with accept_work or complete_work; an agent on the contribute
// (accept_work+complete_work), review (verify), or collaborate
// (steer+accept_work+complete_work+verify) profile. Inactive members never.
const BOARD_PROFILES = Object.freeze([
  ['accept_work', 'complete_work'],
  ['verify'],
  ['steer', 'accept_work', 'complete_work', 'verify'],
]);
function oracleBoard(perms, kind, active, memberId, ownerId) {
  if (active === false) return false;
  if (typeof ownerId === 'string' && ownerId.length > 0 && memberId === ownerId) return true;
  const p = new Set(Array.isArray(perms) ? perms : []);
  if (kind === 'human') return p.has('accept_work') || p.has('complete_work');
  return BOARD_PROFILES.some(profile => profile.every(x => p.has(x)));
}

function allSubsets() {
  const out = [];
  for (let mask = 0; mask < 512; mask++) {
    const s = [];
    for (let i = 0; i < PERMISSIONS.length; i++) if (mask & (1 << i)) s.push(PERMISSIONS[i]);
    out.push(s);
  }
  return out;
}

test('board-profile gate: exhaustive permission subsets match the oracle; both implementations agree', t => {
  const ownerCases = [null, 'owner', 'someone-else', '', 'm']; // 'm' = member is the owner
  for (const perms of allSubsets())
    for (const kind of ['agent', 'human'])
      for (const active of [true, false, undefined])
        for (const ownerId of ownerCases) {
          const member = { id: 'm', kind, active, permissions: perms };
          const expected = oracleBoard(perms, kind, active, 'm', ownerId);
          const viaWorkflow = mayWriteBoardClaims(member, ownerId);
          const viaRoutes = mayWriteWorkClaims({ member, ownerId });
          assert.equal(viaWorkflow, expected,
            `mayWriteBoardClaims perms=${JSON.stringify(perms)} kind=${kind} active=${active} ownerId=${JSON.stringify(ownerId)}`);
          assert.equal(viaRoutes, expected,
            `mayWriteWorkClaims perms=${JSON.stringify(perms)} kind=${kind} active=${active} ownerId=${JSON.stringify(ownerId)}`);
          assert.equal(viaWorkflow, viaRoutes, 'the two gate implementations agree');
          bump(3);
        }
});

// ---------------------------------------------------------------------------
// Hostile permission strings: typos, case variants, unicode lookalikes,
// padding, zero-widths, non-strings, duplicates, missing fields. None may
// widen a grant beyond the exact-string oracle.
function hostileVariants(p) {
  const out = new Set();
  out.add(p.toUpperCase());
  out.add(p[0].toUpperCase() + p.slice(1));
  out.add(p.replace(/_(.)/g, (_, c) => c.toUpperCase())); // camelCase
  out.add(' ' + p); out.add(p + ' '); out.add('\t' + p + '\n');
  out.add(p + '\u00a0'); out.add('\u00a0' + p);
  out.add(p.slice(0, Math.max(1, p.length - 1))); // truncation typo
  out.add(p + 's'); out.add('_' + p); out.add(p + '_');
  out.add(p.replace(/_/g, '-')); out.add(p.replace(/_/g, ' ')); out.add(p.replace(/_/g, ''));
  const cyr = { a: '\u0430', c: '\u0441', e: '\u0435', i: '\u0456', o: '\u043e', p: '\u0440', x: '\u0445', y: '\u0443' };
  let u = p; for (const [l, r] of Object.entries(cyr)) u = u.split(l).join(r);
  if (u !== p) out.add(u); // full cyrillic-lookalike swap
  out.add(p.replace(/o/g, '\u043e')); // single-char homoglyph
  out.add([...p].map(ch => (ch >= 'a' && ch <= 'z') ? String.fromCharCode(ch.charCodeAt(0) + 0xFEE0) : ch).join('')); // fullwidth
  out.add(p.split('').join('\u200b')); // zero-width space between chars
  out.add(p + '\u0301'); // combining accent
  out.add(p.normalize('NFKC'));
  out.delete(p); // NFKC of an ASCII permission is the permission itself
  return [...out];
}

test('board-profile gate: hostile permission strings never widen a grant', t => {
  // Every hostile variant of a required bit, substituted into each profile,
  // must fail; the bare hostile string alone must fail too.
  const profileBits = { contribute: ['accept_work', 'complete_work'], review: ['verify'], collaborate: ['steer', 'accept_work', 'complete_work', 'verify'] };
  for (const [name, bits] of Object.entries(profileBits)) {
    for (let i = 0; i < bits.length; i++) {
      for (const h of hostileVariants(bits[i])) {
        const attempt = [...bits]; attempt[i] = h;
        for (const kind of ['agent', 'human']) {
          const member = { id: 'm', kind, active: true, permissions: attempt };
          const expected = oracleBoard(attempt, kind, true, 'm', 'owner');
          assert.equal(mayWriteBoardClaims(member, 'owner'), expected, `${name} hostile ${JSON.stringify(h)}`);
          assert.equal(mayWriteWorkClaims({ member, ownerId: 'owner' }), expected, `routes ${name} hostile ${JSON.stringify(h)}`);
          bump(2);
        }
        // A hostile string standing alone grants nothing anywhere.
        for (const kind of ['agent', 'human']) {
          const member = { id: 'm', kind, active: true, permissions: [h] };
          assert.equal(mayWriteBoardClaims(member, 'owner'), false, `lone hostile ${JSON.stringify(h)} kind=${kind}`);
          assert.equal(mayWriteWorkClaims({ member, ownerId: 'owner' }), false, `routes lone hostile ${JSON.stringify(h)}`);
          bump(2);
        }
      }
    }
  }
  // Non-string entries, duplicates, empties, and malformed member shapes.
  const shapes = [
    { id: 'm', kind: 'agent', active: true, permissions: [7, null, undefined, {}, true, ['accept_work']] },
    { id: 'm', kind: 'agent', active: true, permissions: ['accept_work', 'accept_work'] },
    { id: 'm', kind: 'agent', active: true, permissions: [] },
    { id: 'm', kind: 'agent', active: true, permissions: null },
    { id: 'm', kind: 'agent', active: true, permissions: undefined },
    { id: 'm', kind: 'agent', active: true, permissions: 'accept_work' },
    { id: 'm', kind: 'agent', active: true, permissions: ['__proto__', 'constructor', 'hasOwnProperty'] },
    { id: 'm', kind: 'agent', active: true, permissions: ['accept_work', 'complete_work', 'verify', 'steer', 'decide', 'manage_members', 'manage_claims', 'write_external', 'invite_member'] },
    null,
    undefined,
    { id: 'm' },
  ];
  for (const member of shapes) {
    for (const ownerId of [null, 'owner', 'm']) {
      const perms = member?.permissions;
      const expected = member == null ? false : oracleBoard(perms, member.kind, member.active, member.id, ownerId);
      assert.equal(mayWriteBoardClaims(member, ownerId), expected, `shape ${JSON.stringify(member)}`);
      assert.equal(mayWriteWorkClaims({ member, ownerId }), expected, `routes shape ${JSON.stringify(member)}`);
      bump(2);
    }
  }
  // Kind is exact: only the literal 'human' takes the human branch.
  for (const kind of ['Human', 'HUMAN', 'human ', ' human', 'agent', '', null, undefined, 5]) {
    const member = { id: 'm', kind, active: true, permissions: ['verify'] };
    const expected = oracleBoard(['verify'], kind, true, 'm', 'owner'); // true only for kind === 'agent'
    assert.equal(mayWriteBoardClaims(member, 'owner'), expected, `kind=${JSON.stringify(kind)}`);
    bump();
  }
  // Determinism: repeated calls and shuffled permission order agree.
  for (let i = 0; i < 200; i++) {
    const perms = allSubsets()[Math.floor(rand() * 512)];
    const kind = pick(['agent', 'human']);
    const shuffled = [...perms].sort(() => rand() - 0.5);
    const a = mayWriteBoardClaims({ id: 'm', kind, active: true, permissions: perms }, 'owner');
    const b = mayWriteBoardClaims({ id: 'm', kind, active: true, permissions: shuffled }, 'owner');
    assert.equal(a, b, 'permission order must not change the verdict');
    assert.equal(a, mayWriteBoardClaims({ id: 'm', kind, active: true, permissions: perms }, 'owner'), 'deterministic');
    bump(2);
  }
});

test('documents: owner-id type drift between the two gate implementations (unreachable via real call paths)', t => {
  // mayWriteBoardClaims requires a non-empty STRING ownerId; mayWriteWorkClaims
  // uses truthiness. They diverge only for non-string ownerIds, which no real
  // caller passes (needs-me.mjs and work-claim-routes.mjs coerce to string|null,
  // store.mjs passes room.state.room?.ownerId which is a string). Recorded as
  // evidence of drift, not asserted as a bug.
  const viaWorkflow = mayWriteBoardClaims({ id: 5, kind: 'agent', active: true, permissions: [] }, 5);
  const viaRoutes = mayWriteWorkClaims({ member: { id: 5, kind: 'agent', active: true, permissions: [] }, ownerId: 5 });
  assert.equal(viaWorkflow, false);
  assert.equal(viaRoutes, true);
  bump(2);
});

// ---------------------------------------------------------------------------
// claimScope path validation fuzz: hostile paths must be rejected, valid
// paths accepted, and the verdict must match an independent oracle exactly.
function oracleValidPath(v) {
  if (typeof v !== 'string' || !v || v !== v.trim() || /[\x00-\x1f\x7f\\]/.test(v)) return false;
  if (v === '**') return true;
  const subtree = v.endsWith('/**');
  const path = (subtree ? v.slice(0, -3) : v).replace(/^\.\//, '');
  if (!path || /[*?\[\]{}]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return true;
}
const scopeOf = paths => ({ repository: 'test/repo', ref: 'draft', paths });

test('claimScope: targeted hostile and valid paths match the oracle', t => {
  const valid = ['**', 'src/**', 'a', 'a/b.js', './a.js', './a/**', 'docs/x.md', 'a-b_c/d.e',
    '0', 'x/**', 'SRC/**', 'src\u200b/**', 'a/ b', 'caf\u00e9/**', '\u4e2d\u6587/**', 'a/..b/c'];
  const invalid = ['', ' ', '\t', '\n', 'a ', ' a', 'src/*.js', 'src/**.js', 'a?b', 'a[b]', '{a}',
    'a\\b', 'a\x00b', 'a\x7fb', 'a\x1fb', '../a', 'a/../b', 'a/./b', '/a', 'a//b', './', './**',
    '/**', 'src/**/b', 'a/**/**/b', '~', '%2e', '..', '.', 'a/.', 'a/..', 'a/b/..', '**/x', 'a/**x',
    7, null, undefined, {}, ['src/**'], true];
  for (const p of [...valid, ...invalid]) {
    const expected = oracleValidPath(p);
    let got, code = null;
    try { claimScope(scopeOf([p])); got = true; }
    catch (e) { got = false; code = e.code; }
    assert.equal(got, expected, `path=${JSON.stringify(p)} expected valid=${expected}`);
    if (!expected) assert.equal(code, 'invalid_claim_scope', `path=${JSON.stringify(p)} rejection code`);
    bump(2);
    // Determinism: same verdict on repeat.
    let got2;
    try { claimScope(scopeOf([p])); got2 = true; } catch { got2 = false; }
    assert.equal(got2, got, `deterministic path=${JSON.stringify(p)}`);
    bump();
  }
  // Case and unicode: 'SRC/**' and 'src/**' are distinct, accepted scopes
  // (exact-match coordination); lookalikes of real paths are accepted as
  // distinct literals, never normalized into the broader scope.
  const r1 = claimScope(scopeOf(['src/**']));
  const r2 = claimScope(scopeOf(['SRC/**']));
  assert.notDeepEqual(r1, r2, 'case is significant in path scopes');
  bump();
});

test('claimScope: randomized path corpus matches the oracle', t => {
  const alphabet = 'abz019/._- \t~%*@?[]{}!\\\'"e\u00e9\u00a0\u4e2d\U0001F600\u200b\u0301\u0430\0\x01\x1f\x7f';
  for (let i = 0; i < 1500; i++) {
    const len = Math.floor(rand() * 26);
    let p = '';
    for (let j = 0; j < len; j++) p += alphabet[Math.floor(rand() * alphabet.length)];
    if (rand() < 0.25) p = pick(['src/**', '**', './', '../', 'a/**', '*/x', 'a b', 'a']) + p;
    if (rand() < 0.25) p = p + pick(['/**', '/**', '/..', ' ', '*', '\\']);
    const expected = oracleValidPath(p);
    let got;
    try { claimScope(scopeOf([p])); got = true; } catch { got = false; }
    assert.equal(got, expected, `random path ${JSON.stringify(p)}`);
    bump();
  }
});

test('claimScope: multi-path arrays, repository and ref validation', t => {
  // An array is rejected iff any entry is invalid.
  const pool = ['src/**', 'a.js', 'docs/**', 'src/*.js', '', 'a/../b'];
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rand() * 4);
    const paths = Array.from({ length: n }, () => pick(pool));
    const expected = paths.every(oracleValidPath);
    let got;
    try { claimScope(scopeOf(paths)); got = true; } catch { got = false; }
    assert.equal(got, expected, `paths=${JSON.stringify(paths)}`);
    bump();
  }
  // Duplicates are accepted (harmless); empties are rejected.
  assert.doesNotThrow(() => claimScope(scopeOf(['src/**', 'src/**'])), 'duplicate paths accepted');
  bump();
  for (const bad of [[], null, undefined, 'src/**', {}]) {
    assert.throws(() => claimScope(scopeOf(bad)), { code: 'invalid_claim_scope' }, `paths=${JSON.stringify(bad)}`);
    bump();
  }
  // Repository and ref: explicit, trimmed, no control chars.
  for (const [repo, ref, ok] of [
    ['test/repo', 'draft', true], ['r', 'b', true], ['UPPER/repo', 'Main', true],
    ['', 'draft', false], [' ', 'draft', false], ['test/repo ', 'draft', false], [' test/repo', 'draft', false],
    ['test/repo', '', false], ['test/repo', ' draft ', false], ['a\x00b', 'draft', false], ['test/repo', 'd\x7ff', false],
    [7, 'draft', false], ['test/repo', null, false], [null, null, false],
  ]) {
    let got;
    try { claimScope({ repository: repo, ref, paths: ['src/**'] }); got = true; } catch { got = false; }
    assert.equal(got, ok, `repository=${JSON.stringify(repo)} ref=${JSON.stringify(ref)}`);
    bump();
  }
});

// ---------------------------------------------------------------------------
// PART 2 (WAVE-400 fuzz): conflictingClaim semantic soundness.
// Independent oracle: two claims REALLY collide iff a witness file exists
// that both scopes cover under file semantics. The implementation may be
// *conservative* (report a conflict with no witness — deny-by-default), but
// it must NEVER miss a real collision (that would be an improper grant:
// two overlapping reservations both admitted).
//
// Independent path parser, written from the documented grammar only:
//   '**' -> whole repo | '<p>/**' -> subtree | '<p>' -> exact file; one
//   leading './' is stripped. Validity itself comes from oracleValidPath
//   (defined above), never from the implementation under test.
function oracleParseScope(v) {
  let s = v;
  if (s === '**') return { path: '', subtree: true };
  if (s.startsWith('./')) s = s.slice(2);
  if (s.endsWith('/**')) return { path: s.slice(0, -3), subtree: true };
  return { path: s, subtree: false };
}
function oracleCoversFile(scope, f) {
  if (scope.subtree) return scope.path === '' || f.startsWith(scope.path + '/');
  return f === scope.path;
}
// Witness set is complete: any file f covered by both scopes is either one
// of the scopes' own paths (exact-scope side), or lies under the deeper of
// two prefix-comparable subtree paths (covered by '<deeper>/w.js'), or the
// repo root file 'w.js' (whole-repo side).
function oracleWitnessCollision(a, b) {
  const files = new Set(['w.js', a.path, b.path, `${a.path}/w.js`, `${b.path}/w.js`]);
  for (const f of files) if (oracleCoversFile(a, f) && oracleCoversFile(b, f)) return f;
  return null;
}
const oracleClaimProblem = claim => {
  if (!claim || typeof claim !== 'object') return 'claim-shape';
  for (const k of ['repository', 'ref']) {
    const v = claim[k];
    if (typeof v !== 'string' || !v || v !== v.trim() || /[\x00-\x1f\x7f]/.test(v)) return k;
  }
  if (!Array.isArray(claim.paths) || !claim.paths.length) return 'paths';
  for (const p of claim.paths) if (!oracleValidPath(p)) return `path:${JSON.stringify(p)}`;
  return null;
};
const oracleIsActive = (item, now) =>
  item?.claim?.status === 'active' && Number.isFinite(Date.parse(item.claim.expiresAt)) && Date.parse(item.claim.expiresAt) > now;
// Expected verdict, mirroring the documented admission rule: skip self,
// skip inactive, skip different repo/ref (declared identities, exact match).
// Per item the implementation conflicts iff the existing scope is ambiguous
// legacy (deny-by-default), a witness file collides (real overlap), or the
// same parsed path appears with different subtree flags (benign
// conservative deny via the equality branch). Returns hits in iteration
// order with their kind.
function oracleConflictingSets(workItems, candidate, now) {
  if (oracleClaimProblem(candidate.claim)) throw Object.assign(new Error('invalid candidate scope'), { code: 'invalid_claim_scope' });
  const candScopes = candidate.claim.paths.map(oracleParseScope);
  const hits = [];
  for (const item of Object.values(workItems)) {
    if (item.id === candidate.id) continue;
    if (!oracleIsActive(item, now)) continue;
    if (item.claim.repository !== candidate.claim.repository || item.claim.ref !== candidate.claim.ref) continue;
    if (oracleClaimProblem(item.claim)) { hits.push({ id: item.id, kind: 'legacy', item }); continue; }
    const existing = item.claim.paths.map(oracleParseScope);
    let kind = null;
    for (const a of candScopes) for (const b of existing) {
      if (oracleWitnessCollision(a, b)) { kind = 'witness'; break; }
      if (!kind && a.path === b.path && a.subtree !== b.subtree) kind = 'benign';
    }
    if (kind) hits.push({ id: item.id, kind, item });
  }
  return hits;
}

const randPath = () => {
  const r = rand();
  const seg = () => pick(['src', 'docs', 'a', 'b', 'SRC', 'x.js', 'deep', 'lib', 'a b', 'caf\u00e9', '\u4e2d', '0']);
  const join = n => Array.from({ length: n }, seg).join('/');
  if (r < 0.38) return join(1 + Math.floor(rand() * 3));
  if (r < 0.66) return join(1 + Math.floor(rand() * 2)) + '/**';
  if (r < 0.76) return '**';
  return pick(['../evil', '', 'src/*.js', 'a\\b', '**/x', './', 'a//b', ' ', 'src/../x', 'a b/**', './' + join(1)]);
};
const randClaim = () => ({
  status: rand() < 0.9 ? 'active' : pick(['released', 'superseded']),
  holderId: pick(['a', 'b', 'c']),
  repository: pick(['test/repo', 'other/repo', 'TEST/REPO', 'r', 'x/y']),
  ref: pick(['main', 'dev', 'MAIN', 'draft']),
  paths: Array.from({ length: 1 + Math.floor(rand() * 3) }, randPath),
  acquiredAt: new Date(FUZZ_NOW - 3600000).toISOString(),
  expiresAt: new Date(FUZZ_NOW + (rand() < 0.8 ? 3600000 : -3600000)).toISOString(),
});
const FUZZ_NOW = 1780880000000; // fixed virtual now for determinism

test('conflictingClaim: randomized claim sets match the witness oracle (no missed collisions)', t => {
  let conservative = 0;
  const conservativeShapes = new Set();
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rand() * 3);
    const workItems = {};
    for (let k = 0; k < n; k++) {
      const id = `w${k}`;
      workItems[id] = { id, claim: randClaim() };
    }
    const candidate = { id: 'cand', claim: randClaim() };
    if (rand() < 0.1) candidate.id = pick(Object.keys(workItems)); // self must be skipped
    let expected, expectedThrew = false, expectedCode = null;
    try { expected = oracleConflictingSets(workItems, candidate, FUZZ_NOW); }
    catch (e) { expectedThrew = true; expectedCode = e.code; }
    if (expectedThrew) {
      assert.throws(() => conflictingClaim(workItems, candidate, FUZZ_NOW),
        err => err?.code === expectedCode,
        `case ${i}: invalid candidate scope must throw ${expectedCode}, not silently pass`);
      bump(2);
      continue;
    }
    const actual = conflictingClaim(workItems, candidate, FUZZ_NOW);
    // Determinism: same inputs, same verdict.
    const again = conflictingClaim(workItems, candidate, FUZZ_NOW);
    assert.equal(again?.id ?? null, actual?.id ?? null, `case ${i}: verdict must be deterministic`);
    bump();
    const realHits = expected.filter(h => h.kind !== 'benign');
    if (realHits.length && !actual) {
      const first = realHits[0];
      assert.fail(`case ${i}: MISSED COLLISION (improper grant) — oracle found ${first.kind} hit on ${first.id} `
        + `candidate=${JSON.stringify(candidate.claim)} existing=${JSON.stringify(first.item.claim)}`);
    }
    if (!expected.length && actual) {
      assert.fail(`case ${i}: UNEXPECTED CONFLICT — oracle found no hit at all `
        + `candidate=${JSON.stringify(candidate.claim)} reported=${JSON.stringify(actual.claim)}`);
    }
    if (expected.length) {
      // The implementation's per-item predicate covers witness, legacy, and
      // benign shapes over the same iteration order, so it must name the
      // first oracle hit.
      assert.equal(actual?.id ?? null, expected[0].id,
        `case ${i}: first-hit mismatch candidate=${JSON.stringify(candidate.claim)}`);
      bump();
      if (expected.every(h => h.kind === 'benign')) {
        conservative++;
        const aPaths = candidate.claim.paths.map(oracleParseScope);
        const bPaths = actual.claim.paths.map(oracleParseScope);
        for (const a of aPaths) for (const b of bPaths)
          conservativeShapes.add(`${a.path}|${a.subtree}~${b.path}|${b.subtree}`);
      }
    } else bump();
  }
  console.log(`[fuzz-16] conflictingClaim: 3000 randomized sets, conservative-denies=${conservative}`);
});

test('conflictingClaim: targeted edges — expiry, identity, legacy, determinism', t => {
  const mk = (id, claim) => ({ id, claim });
  const live = { status: 'active', holderId: 'a', repository: 'test/repo', ref: 'main', paths: ['src/**'], acquiredAt: new Date(FUZZ_NOW - 1000).toISOString(), expiresAt: new Date(FUZZ_NOW + 3600000).toISOString() };
  const cand = paths => ({ id: 'cand', claim: { ...live, holderId: 'b', paths } });
  // Expiry boundary: expired or released claims never conflict.
  for (const dead of [
    { ...live, expiresAt: new Date(FUZZ_NOW - 1).toISOString() },
    { ...live, expiresAt: new Date(FUZZ_NOW).toISOString() }, // not strictly greater -> inactive
    { ...live, status: 'released' },
    { ...live, status: 'superseded' },
  ]) {
    assert.equal(conflictingClaim({ w: mk('w', dead) }, cand(['src/deep/x.js']), FUZZ_NOW), null, `dead claim ${dead.status}/${dead.expiresAt}`);
    bump();
  }
  // Declared identities: repo and ref compare exact — case differs, no conflict.
  for (const [repo, ref] of [['TEST/REPO', 'main'], ['test/repo', 'MAIN'], ['test/repo ', 'main'], ['other/repo', 'main'], ['test/repo', 'dev']]) {
    assert.equal(conflictingClaim({ w: mk('w', { ...live, repository: repo, ref }) }, cand(['src/deep/x.js']), FUZZ_NOW), null,
      `repo=${JSON.stringify(repo)} ref=${JSON.stringify(ref)} must not conflict`);
    bump();
  }
  // Same repo+ref, overlapping -> conflict; disjoint -> null.
  assert.equal(conflictingClaim({ w: mk('w', live) }, cand(['src/deep/x.js']), FUZZ_NOW)?.id, 'w');
  assert.equal(conflictingClaim({ w: mk('w', live) }, cand(['docs/**']), FUZZ_NOW), null);
  assert.equal(conflictingClaim({ w: mk('w', live) }, cand(['**']), FUZZ_NOW)?.id, 'w');
  assert.equal(conflictingClaim({ w: mk('w', { ...live, paths: ['**'] }) }, cand(['anything/at/all.js']), FUZZ_NOW)?.id, 'w');
  bump(4);
  // Legacy ambiguous existing claim -> deny (conflict) rather than permit.
  for (const bad of [
    { ...live, paths: ['../evil'] }, { ...live, paths: [] }, { ...live, paths: 'src/**' },
    { ...live, paths: [null] }, { ...live, paths: ['src/**', 7] }, { ...live, paths: ['ok/**', 'a/../b'] },
  ]) {
    assert.equal(conflictingClaim({ w: mk('w', bad) }, cand(['zzz-unrelated/**']), FUZZ_NOW)?.id, 'w',
      `legacy bad claim must deny-by-default: ${JSON.stringify(bad.paths)}`);
    bump();
  }
  // Invalid candidate scope throws ClaimScopeError, never returns null (permit).
  for (const badPaths of [['../evil'], [''], ['src/*.js'], [], [7], ['ok/**', '']]) {
    assert.throws(() => conflictingClaim({ w: mk('w', live) }, cand(badPaths), FUZZ_NOW),
      { code: 'invalid_claim_scope' }, `candidate paths=${JSON.stringify(badPaths)} must throw`);
    bump();
  }
  // First conflicting item wins; insertion order is the tiebreak.
  const two = { w1: mk('w1', live), w2: mk('w2', { ...live, holderId: 'c' }) };
  assert.equal(conflictingClaim(two, cand(['src/x.js']), FUZZ_NOW)?.id, 'w1');
  bump();
});

// ---------------------------------------------------------------------------
// PART 3 (WAVE-400 fuzz): live store admission cross-product —
// agents x scopes x claim-ops, with per-attempt expectations, state-unchanged
// on every denial, and global no-improper-grant invariants.
test('store admission: agents x scopes x claim-ops cross-product (>=2000 cases)', t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-fuzz16-'));
  let nowMs = FUZZ_NOW;
  const store = new RoomStore(join(directory, 'room.sqlite'), { now: () => nowMs });
  store.initialize(initialRoom());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ownerId = store.room('commons').state.room.ownerId;
  const keys = { owner: store.issueAccessKey('commons', 'owner') };
  const cmd = (type, data) => ({ id: crypto.randomUUID(), type, data });
  const send = (key, type, data) => store.command(key, 'commons', cmd(type, data));
  const advance = ms => { nowMs += ms; };
  const state = () => store.room('commons').state;
  const rev = id => state().workItems[id].revision;
  const dbCount = tbl => store.db.prepare(`SELECT count(*) AS n FROM ${tbl}`).get().n;
  const noCmdRow = id => store.db.prepare('SELECT count(*) AS n FROM commands WHERE id=?').get(id).n;

  const AGENTS = [
    { id: 'contrib', permissions: ['accept_work', 'complete_work'] },
    { id: 'reviewer', permissions: ['accept_work', 'verify'] },
    { id: 'collab', permissions: ['steer', 'accept_work', 'complete_work', 'verify'] },
    { id: 'external', permissions: ['accept_work', 'write_external'] },
    { id: 'plain', permissions: ['accept_work'] },
    { id: 'manager', permissions: ['accept_work', 'manage_claims'] },
  ];
  for (const a of AGENTS) {
    send(keys.owner, T.MEMBER_ADDED, { memberId: a.id, displayName: a.id, kind: 'agent', accountableHumanId: 'owner', permissions: a.permissions });
    setTier(store.db, 'commons', a.id, 't2_standard', { updatedBy: 'owner', nowMs });
    keys[a.id] = store.issueAccessKey('commons', a.id);
    advance(2000);
  }
  const memberOf = id => state().members[id];
  const permsOf = id => memberOf(id)?.permissions ?? [];
  const boardGate = id => mayWriteBoardClaims(memberOf(id), ownerId);

  // Items: 3 per agent (acquire matrices) + 2 per agent (supersede).
  const items = {};
  const mkItem = (id, accountable) => {
    send(keys.owner, T.WORK_PROPOSED, { workItemId: id, title: id, definitionOfDone: 'done', accountableMemberId: accountable, mode: 'write', independentVerificationRequired: false, ownerDecisionRequired: false });
    send(keys[accountable], T.WORK_ACCEPTED, { workItemId: id, expectedRevision: rev(id) });
    items[id] = accountable;
    advance(2000);
  };
  for (const a of AGENTS) for (let i = 0; i < 3; i++) mkItem(`item-${a.id}-${i}`, a.id);
  for (const a of AGENTS) { mkItem(`supA-${a.id}`, a.id); mkItem(`supB-${a.id}`, a.id); }

  // Model of live active claims: { itemId, holder, repo, ref, scopes }.
  const liveClaims = [];
  const pruneExpired = () => {
    for (let i = liveClaims.length - 1; i >= 0; i--)
      if (!activeClaim(state().workItems[liveClaims[i].itemId], nowMs)) liveClaims.splice(i, 1);
  };
  const EXP = () => new Date(nowMs + 86400000).toISOString();

  // Scope corpus: 20 path-sets x 8 repo/ref variants = 160.
  const PATH_SETS = [
    ['src/**'], ['docs/**'], ['src/deep/**'], ['src'], ['SRC/**'], ['**'], ['a.js'],
    ['src/**', 'docs/**'], ['src/**', 'src/**'], ['other/**'], ['src/deep/file.js'], ['x'],
    ['../evil'], [''], ['src/*.js'], ['a\\b'], ['../x'], ['**/x'], ['./'], ['src/**', '../evil'],
  ];
  const REPOREFS = [
    ['test/repo', 'main'], ['test/repo', 'dev'], ['other/repo', 'main'], ['TEST/REPO', 'main'],
    ['test/repo', 'MAIN'], ['r', 'b'], [' test/repo', 'main'], ['test/repo', ''],
  ];
  const SCOPES = [];
  for (const paths of PATH_SETS) for (const [repository, ref] of REPOREFS) SCOPES.push({ repository, ref, paths });
  const HOSTILE = [
    { repository: 'test/repo', ref: 'main', paths: ['..'] }, { repository: 'test/repo', ref: 'main', paths: ['.'] },
    { repository: 'test/repo', ref: 'main', paths: ['a/./b'] }, { repository: 'test/repo', ref: 'main', paths: ['a/b/..'] },
    { repository: 'test/repo', ref: 'main', paths: ['/abs'] }, { repository: 'test/repo', ref: 'main', paths: ['~/x'] },
    { repository: 'test/repo', ref: 'main', paths: ['a?b'] }, { repository: 'test/repo', ref: 'main', paths: ['a[b]'] },
    { repository: 'test/repo', ref: 'main', paths: ['{a}'] }, { repository: 'test/repo', ref: 'main', paths: ['src/**/x'] },
    { repository: 'test/repo', ref: 'main', paths: ['a\x00b'] }, { repository: 'test/repo', ref: 'main', paths: ['a\x7fb'] },
    { repository: 'test/repo', ref: 'main', paths: ['a b /**'] }, { repository: 'test/repo', ref: 'main', paths: ['a\tb'] },
    { repository: 'test/repo', ref: 'main', paths: [7] }, { repository: 'test/repo', ref: 'main', paths: [null] },
    { repository: 'test/repo', ref: 'main', paths: ['src/**', 7] }, { repository: 'test/repo', ref: 'main', paths: [] },
    { repository: 'test/repo', ref: 'main', paths: 'src/**' }, { repository: '', ref: 'main', paths: ['src/**'] },
    { repository: 'test/repo', ref: '', paths: ['src/**'] }, { repository: 'test/repo', ref: 'main', paths: ['x'.repeat(5000)] },
    { repository: 'test/repo', ref: 'main', paths: ['…/**'] }, { repository: 'test/repo', ref: 'main', paths: ['src/\u202e/**'] },
    { repository: 'UPPER/repo', ref: 'MAIN', paths: ['SRC/**'] }, { repository: 'test/repo', ref: 'main', paths: ['./x'] },
    { repository: 'test/repo', ref: 'main', paths: ['x/**', 'x/**', 'x/**'] }, { repository: 7, ref: 'main', paths: ['src/**'] },
    { repository: 'test/repo', ref: null, paths: ['src/**'] }, { repository: 'test/repo', ref: 'main', paths: ['src/** '] },
  ];

  let cases = 0, permits = 0, denies = 0;
  const successes = { acquire: 0, release: 0, renew: 0, handoff: 0, supersede: 0 };
  const snap = () => ({ seq: store.room('commons').sequence, work: JSON.stringify(state().workItems), events: dbCount('events'), commands: dbCount('commands') });
  const runAttempt = (agentId, type, data) => {
    const before = snap();
    const c = cmd(type, data);
    let result = null, error = null;
    try { result = store.command(keys[agentId], 'commons', c); } catch (e) { error = e; }
    advance(2000);
    return { result, error, before, cmdId: c.id };
  };
  const checkDeny = (att, expectStatus, label) => {
    assert.ok(att.error, `${label}: expected denial, got success`);
    assert.ok(Number.isInteger(att.error.status) && att.error.status >= 400 && att.error.status < 500,
      `${label}: denial must be 4xx, got status=${att.error.status} code=${att.error.code}`);
    assert.equal(att.error.status, expectStatus, `${label}: expected status ${expectStatus}, got ${att.error.status} (${att.error.code})`);
    const after = snap();
    assert.deepEqual(after, att.before, `${label}: denial must leave state unchanged`);
    assert.equal(noCmdRow(att.cmdId), 0, `${label}: denied command must not persist`);
    denies++; cases++;
  };
  const checkPermit = (att, label) => {
    assert.equal(att.error, null, `${label}: expected permit, got ${att.error?.status} ${att.error?.code} ${att.error?.message}`);
    permits++; cases++;
  };

  // Baseline: every agent holds src/** on item-<id>-0, each in their own
  // repository namespace so baselines never collide with each other.
  for (const a of AGENTS) {
    const id = `item-${a.id}-0`;
    const repo = `test/repo-${a.id}`;
    const att = runAttempt(a.id, T.CLAIM_ACQUIRED, { workItemId: id, expectedRevision: rev(id), repository: repo, ref: 'main', paths: ['src/**'], expiresAt: EXP() });
    if (!boardGate(a.id)) {
      checkDeny(att, 403, `baseline acquire denied ${a.id}`);
      continue;
    }
    checkPermit(att, `baseline acquire ${a.id}`);
    const it = state().workItems[id];
    assert.equal(it.claim.holderId, a.id);
    assert.deepEqual(it.claim.paths, ['src/**']);
    liveClaims.push({ itemId: id, holder: a.id, repo, ref: 'main', scopes: [{ path: 'src', subtree: true }] });
    successes.acquire++;
  }

  const blank = v => v === undefined || v === null || (typeof v === 'string' && !v.trim());
  // Envelope validation (src/events.js validateEnvelope) runs before the
  // reducer: blank/oversize strings -> 422, and `paths` must be an array of
  // <=64 non-blank strings of <=512 chars.
  const envelopePathsProblem = paths =>
    !Array.isArray(paths) || paths.length > 64 ||
    paths.some(v => typeof v !== 'string' || !v.trim() || v.length > 512);
  const expectAcquire = (agentId, itemId, scope) => {
    // Command gate (validateCommand) is the very first check in
    // store.command, ahead of the board-profile gate; null values skip its
    // type checks and fall through to later stages.
    if ((scope.repository !== null && typeof scope.repository !== 'string') ||
        (scope.ref !== null && typeof scope.ref !== 'string') ||
        (scope.paths !== null && !Array.isArray(scope.paths))) return 422;
    if (!boardGate(agentId)) return 403;
    pruneExpired();
    if (blank(scope.repository) || blank(scope.ref)) return 422;
    if (typeof scope.repository === 'string' && scope.repository.length > 4096) return 422;
    if (typeof scope.ref === 'string' && scope.ref.length > 4096) return 422;
    if (envelopePathsProblem(scope.paths)) return 422;
    if (!scope.paths.length) return 422; // reducer: "Claim paths must be explicit"
    if (activeClaim(state().workItems[itemId], nowMs)) return 409;
    if (oracleClaimProblem(scope)) return 422; // admission: invalid_claim_scope
    const mine = scope.paths.map(oracleParseScope);
    for (const c of liveClaims) {
      if (c.itemId === itemId || c.repo !== scope.repository || c.ref !== scope.ref) continue;
      if (mine.some(m => c.scopes.some(o => oracleWitnessCollision(m, o)))) return 409;
    }
    return 200;
  };
  const doAcquireMatrix = (itemSuffix, scopes) => {
    for (const a of AGENTS) {
      const itemId = `item-${a.id}-${itemSuffix}`;
      for (const scope of scopes) {
        const want = expectAcquire(a.id, itemId, scope);
        const att = runAttempt(a.id, T.CLAIM_ACQUIRED,
          { workItemId: itemId, expectedRevision: rev(itemId), repository: scope.repository, ref: scope.ref, paths: scope.paths, expiresAt: EXP() });
        if (want === 200) {
          checkPermit(att, `acquire ${a.id} ${itemId} ${JSON.stringify(scope)}`);
          const it = state().workItems[itemId];
          assert.equal(it.claim.holderId, a.id, 'holder recorded');
          assert.deepEqual(it.claim.paths, scope.paths, 'scope recorded exactly');
          assert.equal(it.claim.repository, scope.repository);
          assert.equal(it.claim.ref, scope.ref);
          liveClaims.push({ itemId, holder: a.id, repo: scope.repository, ref: scope.ref, scopes: scope.paths.map(oracleParseScope) });
          successes.acquire++;
        } else {
          checkDeny(att, want, `acquire ${a.id} ${itemId} ${JSON.stringify(scope).slice(0, 80)}`);
        }
      }
    }
  };
  doAcquireMatrix(1, SCOPES); // 6 x 160 = 960
  doAcquireMatrix(2, SCOPES); // 6 x 160 = 960

  // Renew matrix BEFORE releases: holder renews with/without a progress
  // message; strangers are denied. (progressMessageId is optional in the
  // reducer — a holder-only lease extension without a message is permitted.)
  pruneExpired();
  const renewTargets = liveClaims.slice(0, 6);
  for (const c of renewTargets) {
    const holder = c.holder;
    const msgId = `prog-${c.itemId}`;
    runAttempt(holder, T.MESSAGE_POSTED, { messageId: msgId, body: 'progress update' });
    cases++;
    const renewData = (pid, exp) => ({ workItemId: c.itemId, expectedRevision: rev(c.itemId),
      ...(pid ? { progressMessageId: pid } : {}), expiresAt: exp ?? EXP() });
    let att = runAttempt(holder, T.CLAIM_RENEWED, renewData(msgId)); // holder + msg -> permit
    checkPermit(att, `renew holder+msg ${holder} ${c.itemId}`);
    assert.equal(state().workItems[c.itemId].claim.renewals, 1);
    successes.renew++;
    att = runAttempt(holder, T.CLAIM_RENEWED, renewData(null)); // holder, no msg -> permit (holder-only extension)
    checkPermit(att, `renew holder-no-msg ${holder} ${c.itemId}`);
    assert.equal(state().workItems[c.itemId].claim.renewals, 2);
    successes.renew++;
    att = runAttempt(holder, T.CLAIM_RENEWED, renewData(msgId, new Date(nowMs - 1000).toISOString())); // past expiry -> 422
    checkDeny(att, 422, `renew holder-past-expiry ${holder} ${c.itemId}`);
    for (const m of ['owner', ...AGENTS.map(a => a.id)]) { // strangers -> deny
      if (m === holder) continue;
      att = runAttempt(m, T.CLAIM_RENEWED, renewData(msgId));
      checkDeny(att, boardGate(m) ? 422 : 403, `renew stranger ${m} ${c.itemId}`);
    }
  }

  // Release matrix: strangers first (denied on the live claim), then the
  // permit release alternating holder / owner (owner carries manage_claims),
  // then a double-release deny. A pure manage_claims member has no board
  // profile, so the reducer's holder-or-manager path is unreachable via
  // events for non-holders — admission fails closed (403).
  pruneExpired();
  const membersAll = ['owner', ...AGENTS.map(a => a.id)];
  [...liveClaims].forEach((c, idx) => {
    const holder = c.holder;
    for (const m of membersAll) {
      if (m === holder || m === 'owner' || !activeClaim(state().workItems[c.itemId], nowMs)) continue;
      const want = boardGate(m) ? 422 : 403;
      const att = runAttempt(m, T.CLAIM_RELEASED, { workItemId: c.itemId, expectedRevision: rev(c.itemId) });
      checkDeny(att, want, `release stranger ${m} ${c.itemId}`);
    }
    if (!activeClaim(state().workItems[c.itemId], nowMs)) return;
    const releaser = idx % 2 === 0 ? holder : 'owner';
    let att = runAttempt(releaser, T.CLAIM_RELEASED, { workItemId: c.itemId, expectedRevision: rev(c.itemId) });
    checkPermit(att, `release ${releaser} ${c.itemId}`);
    assert.equal(state().workItems[c.itemId].claim.status, 'released');
    const ix = liveClaims.findIndex(x => x.itemId === c.itemId);
    if (ix >= 0) liveClaims.splice(ix, 1);
    successes.release++;
    att = runAttempt(holder, T.CLAIM_RELEASED, { workItemId: c.itemId, expectedRevision: rev(c.itemId) });
    checkDeny(att, 422, `double release ${holder} ${c.itemId}`);
  });

  // Handoff matrix: each agent on their own item-2.
  for (const a of AGENTS) {
    const itemId = `item-${a.id}-2`;
    const st = state().workItems[itemId].state;
    if (!['accepted', 'working', 'blocked'].includes(st)) continue;
    const want = !boardGate(a.id) ? 403 : permsOf(a.id).includes('accept_work') ? 200 : 422;
    const att = runAttempt(a.id, T.WORK_HANDOFF_RECORDED,
      { workItemId: itemId, expectedRevision: rev(itemId), doneSummary: 'did things', nextAction: 'more', limitReason: 'fuzz' });
    if (want === 200) {
      checkPermit(att, `handoff ${a.id} ${itemId}`);
      assert.equal(state().workItems[itemId].handoff.open, true);
      successes.handoff++;
    } else checkDeny(att, want, `handoff ${a.id} ${itemId}`);
  }

  // Supersede matrix: each agent attempts on their own supA item.
  for (const a of AGENTS) {
    const itemId = `supA-${a.id}`;
    const want = !boardGate(a.id) ? 403 : permsOf(a.id).includes('steer') ? 200 : 422;
    const att = runAttempt(a.id, T.WORK_SUPERSEDED,
      { workItemId: itemId, expectedRevision: rev(itemId), supersededByWorkItemId: `supB-${a.id}`, reason: 'fuzz' });
    if (want === 200) {
      checkPermit(att, `supersede ${a.id} ${itemId}`);
      assert.equal(state().workItems[itemId].state, 'superseded');
      successes.supersede++;
    } else checkDeny(att, want, `supersede ${a.id} ${itemId}`);
  }
  // Owner supersedes too (owner holds steer).
  {
    const itemId = 'supA-contrib';
    if (state().workItems[itemId].state !== 'superseded') {
      const att = runAttempt('owner', T.WORK_SUPERSEDED,
        { workItemId: itemId, expectedRevision: rev(itemId), supersededByWorkItemId: 'supB-contrib', reason: 'fuzz-owner' });
      checkPermit(att, 'supersede owner supA-contrib');
      successes.supersede++;
    }
  }

  // Release everything, then hostile acquire sweep on freed items.
  pruneExpired();
  for (const c of [...liveClaims]) {
    const att = runAttempt(c.holder, T.CLAIM_RELEASED, { workItemId: c.itemId, expectedRevision: rev(c.itemId) });
    if (!att.error) { const ix = liveClaims.findIndex(x => x.itemId === c.itemId); if (ix >= 0) liveClaims.splice(ix, 1); successes.release++; cases++; }
    else { denies++; cases++; }
  }
  for (const a of AGENTS) {
    const itemId = `item-${a.id}-0`;
    for (const scope of HOSTILE) {
      const want = expectAcquire(a.id, itemId, scope);
      const att = runAttempt(a.id, T.CLAIM_ACQUIRED,
        { workItemId: itemId, expectedRevision: rev(itemId), repository: scope.repository, ref: scope.ref, paths: scope.paths, expiresAt: EXP() });
      if (want === 200) {
        checkPermit(att, `hostile acquire ${a.id} ${JSON.stringify(scope).slice(0, 90)}`);
        liveClaims.push({ itemId, holder: a.id, repo: scope.repository, ref: scope.ref, scopes: scope.paths.map(oracleParseScope) });
        successes.acquire++;
      } else checkDeny(att, want, `hostile acquire ${a.id} ${JSON.stringify(scope).slice(0, 90)}`);
    }
  }

  console.log(`[fuzz-16] store cross-product: cases=${cases} permits=${permits} denies=${denies} ` +
    `successes=${JSON.stringify(successes)} liveClaims=${liveClaims.length}`);
  assert.ok(cases >= 2000, `need >=2000 cross-product cases, ran ${cases}`);
  assert.ok(successes.acquire >= 10, 'gate must permit valid acquires (not deny-everything)');
  assert.ok(successes.release >= 3, 'gate must permit valid releases');
  assert.ok(successes.renew >= 3, 'gate must permit valid renews');
  assert.ok(successes.handoff >= 2, 'gate must permit valid handoffs');
  assert.ok(successes.supersede >= 1, 'gate must permit a valid supersede');
  // Global no-improper-grant invariant: no two live claims ever overlap on the
  // same repo+ref (checked incrementally at every permit above; re-verify).
  pruneExpired();
  for (let i = 0; i < liveClaims.length; i++) for (let j = i + 1; j < liveClaims.length; j++) {
    const x = liveClaims[i], y = liveClaims[j];
    if (x.repo !== y.repo || x.ref !== y.ref) continue;
    const clash = x.scopes.some(a => y.scopes.some(b => oracleWitnessCollision(a, b)));
    assert.equal(clash, false, `overlapping live claims: ${x.itemId} vs ${y.itemId}`);
  }
});
