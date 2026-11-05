import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildBrowserFailureWork } from '../scripts/browser-failure-work.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'browser-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
  git(['remote', 'add', 'origin', 'https://github.com/example/room.git']);
  mkdirSync(join(dir, 'scripts')); writeFileSync(join(dir, 'scripts/browser.mjs'), '// fixture');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const revision = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  const receipt = { revision, index: 1, total: 6, runId: '123', runAttempt: '1', planHash: 'a'.repeat(64), status: 1, signal: null, files: ['scripts/browser.mjs'] };
  const options = { checkout: dir, repo: 'example/room', revision, tree, runId: '123', runAttempt: '1', sourceRoot: '/producer/private-checkout', accountableMember: 'agent', receipt: join(dir, 'receipt.json'), junit: join(dir, 'junit.xml') };
  const xml = (name = 'renders safely', file = '/producer/private-checkout/scripts/browser.mjs', failed = true) => `<testsuites><testcase name="${name}" file="${file}" classname="test">${failed ? '<failure message="private token secret">private error body</failure>' : ''}</testcase></testsuites>`;
  const save = (r = receipt, text = xml()) => { writeFileSync(options.receipt, JSON.stringify(r)); writeFileSync(options.junit, text); };
  save(); return { dir, options, receipt, xml, save };
}
test('preview binds source and exact failed case without copying private paths or errors', t => {
  const f = fixture(t), packet = buildBrowserFailureWork(f.options);
  assert.equal(packet.failures.length, 1); assert.equal(packet.failures[0].testName, 'renders safely');
  assert.equal(packet.source.tree, f.options.tree); assert.match(packet.evidence.junitSha256, /^[a-f0-9]{64}$/);
  assert.equal(packet.failures[0].workAction.name, 'room_propose_work');
  assert.doesNotMatch(JSON.stringify(packet), /private-checkout|private token|private error/);
  assert.doesNotMatch(JSON.stringify(packet.failures[0].workAction), /renders safely/);
});
test('duplicate cases collapse and failure identity survives retry attempts and report ordering', t => {
  const f = fixture(t), one = buildBrowserFailureWork(f.options);
  f.save({ ...f.receipt, runAttempt: '2' }, f.xml().replace('</testsuites>', '') + f.xml().replace('<testsuites>', ''));
  const two = buildBrowserFailureWork({ ...f.options, runAttempt: '2' });
  assert.equal(two.failures.length, 1); assert.equal(two.failures[0].id, one.failures[0].id);
  assert.deepEqual(two.failures[0].workAction, one.failures[0].workAction);
  assert.notEqual(two.evidence.junitSha256, one.evidence.junitSha256);
});
test('cross-source and mismatched run evidence is refused', t => {
  const f = fixture(t);
  for (const patch of [{ tree: 'b'.repeat(40) }, { repo: 'other/room' }, { runId: '999' }, { runAttempt: '2' }, { revision: 'b'.repeat(40) }])
    assert.throws(() => buildBrowserFailureWork({ ...f.options, ...patch }));
  f.save({ ...f.receipt, files: ['scripts/missing.mjs'] }); assert.throws(() => buildBrowserFailureWork(f.options));
});
test('private paths, traversal, malformed XML, no failures and contradictory receipt are refused', t => {
  const f = fixture(t);
  for (const xml of [f.xml('test', '/another/private/scripts/browser.mjs'), f.xml('test', '../scripts/browser.mjs'), '<testsuites><testcase>', '<!DOCTYPE testsuites><testsuites/>', f.xml('pass', undefined, false), f.xml().replace('</testcase>', '')]) {
    f.save(f.receipt, xml); assert.throws(() => buildBrowserFailureWork(f.options));
  }
  f.save({ ...f.receipt, status: 0 }); assert.throws(() => buildBrowserFailureWork(f.options));
  f.save({ ...f.receipt, files: ['scripts/browser.mjs', 'scripts/browser.mjs'] }); assert.throws(() => buildBrowserFailureWork(f.options));
});
test('actual CLI writes exclusive preview and never interprets testcase shell text', t => {
  const f = fixture(t), out = join(f.dir, 'preview.json');
  f.save(f.receipt, f.xml('$(touch SHOULD-NOT-EXIST)'));
  const names = { runId: 'run-id', runAttempt: 'run-attempt', sourceRoot: 'source-root', accountableMember: 'accountable-member' };
  const args = Object.entries({ ...f.options, out }).flatMap(([k,v]) => [`--${names[k] ?? k}`, v]);
  const cli = resolve('scripts/browser-failure-work.mjs');
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: f.dir });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /no Room writes/);
  assert.equal(JSON.parse(readFileSync(out)).failures[0].testName, '$(touch SHOULD-NOT-EXIST)');
  assert.equal(spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }).status, 1);
  assert.throws(() => readFileSync(join(f.dir, 'SHOULD-NOT-EXIST')));
});

test('imports a real Node JUnit failure bound to its committed script and actual exit', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'scripts/browser.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('real failing fixture',()=>assert.equal(1,2));\n");
  const git = args => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' }).trim();
  git(['add', 'scripts/browser.mjs']); git(['commit', '-qm', 'real failed test']);
  const revision = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=junit', 'scripts/browser.mjs'], { cwd: f.dir, encoding: 'utf8', env });
  assert.equal(result.status, 1);
  f.save({ ...f.receipt, revision, status: result.status }, result.stdout);
  const packet = buildBrowserFailureWork({ ...f.options, revision, tree, sourceRoot: realpathSync(f.dir) });
  assert.equal(packet.failures[0].testName, 'real failing fixture');
  assert.equal(packet.failures[0].script, 'scripts/browser.mjs');
  assert.doesNotMatch(JSON.stringify(packet), /AssertionError|ERR_ASSERTION|Expected values/);
});

test('repository is part of dedup identity, not merely revision and test name', t => {
  const f = fixture(t), first = buildBrowserFailureWork(f.options);
  execFileSync('git', ['-C', f.dir, 'remote', 'set-url', 'origin', 'https://github.com/other/room.git']);
  const second = buildBrowserFailureWork({ ...f.options, repo: 'other/room' });
  assert.notEqual(first.failures[0].id, second.failures[0].id);
});


test('tracked imported passing cases are allowed but imported failures remain unsupported', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'scripts/helper.mjs'), '// imported tests');
  const git = args => execFileSync('git', ['-C', f.dir, ...args], { encoding: 'utf8' }).trim();
  git(['add', 'scripts/helper.mjs']); git(['commit', '-qm', 'helper']);
  const revision = git(['rev-parse', 'HEAD']), tree = git(['rev-parse', 'HEAD^{tree}']);
  const options = { ...f.options, revision, tree };
  const combine = failed => f.xml().replace('</testsuites>', '') + f.xml('imported', '/producer/private-checkout/scripts/helper.mjs', failed).replace('<testsuites>', '');
  f.save({ ...f.receipt, revision }, combine(false));
  assert.equal(buildBrowserFailureWork(options).failures.length, 1);
  f.save({ ...f.receipt, revision }, combine(true));
  assert.throws(() => buildBrowserFailureWork(options), /Failed imported testcase/);
  f.save({ ...f.receipt, revision }, combine(false).replace('scripts/helper.mjs', 'scripts/untracked.mjs'));
  assert.throws(() => buildBrowserFailureWork(options), /outside source root/);
});
