import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions, assertSource, assertIdentity, assertShippingBundle, distribute } from '../desktop/macos/distribute.mjs';

const revision = 'a'.repeat(40), identity = 'B'.repeat(40);
const options = { revision, identity, version: '1.0.0', 'notary-profile': 'release', output: '/tmp/new-release' };
const args = Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]);

test('distribution arguments require pinned source, certificate and explicit destinations', () => {
  assert.deepEqual(parseOptions(args), options);
  for (const replacement of [{ revision: 'main' }, { identity: '-' }, { version: '../escape' }, { output: 'relative' }, { 'notary-profile': '' }]) {
    assert.throws(() => parseOptions(Object.entries({ ...options, ...replacement }).flatMap(([k, v]) => [`--${k}`, v])));
  }
  assert.throws(() => parseOptions([...args, '--version', '2.0.0']));
  assert.throws(() => parseOptions([...args, '--password', 'secret']));
});

test('source provenance rejects untracked files and unexpected HEAD', () => {
  assert.throws(() => assertSource(options, (_, args) => args[0] === 'rev-parse' ? revision : '?? extra'), /clean/);
  assert.throws(() => assertSource(options, () => 'b'.repeat(40)), /revision/);
});

test('only the selected valid Developer ID Application certificate qualifies', () => {
  assertIdentity(options, () => `  1) ${identity} "Developer ID Application: Example (TEAM)"\n 1 valid identities found`);
  for (const text of ['0 valid identities found', `1) ${identity} "Apple Development: Example"`, `1) ${identity} "Developer ID Application: Example" (CSSMERR_TP_CERT_EXPIRED)`])
    assert.throws(() => assertIdentity(options, () => text), /unavailable/);
});

function bundle(t) {
  const app = mkdtempSync(join(tmpdir(), 'room-distribution-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  for (const directory of ['MacOS', 'Resources', '_CodeSignature']) mkdirSync(join(app, 'Contents', directory), { recursive: true });
  for (const file of ['Info.plist', 'MacOS/ProjectRoom', 'MacOS/ProjectRoomTools', 'Resources/ProjectRoom.icns', '_CodeSignature/CodeResources']) writeFileSync(join(app, 'Contents', file), 'fixture');
  return app;
}

test('shipping inventory rejects stale acceptance executables and symbolic links', t => {
  const app = bundle(t);
  assertShippingBundle(app, fs);
  const extra = join(app, 'Contents/MacOS/RoomAcceptance');
  writeFileSync(extra, 'test-only');
  assert.throws(() => assertShippingBundle(app, fs), /Unexpected/);
  rmSync(extra);
  rmSync(join(app, 'Contents/MacOS/ProjectRoomTools'));
  symlinkSync('/tmp/outside', join(app, 'Contents/MacOS/ProjectRoomTools'));
  assert.throws(() => assertShippingBundle(app, fs), /symbolic/);
});

function harness(t, { notaryStatus = 'Accepted', failAt = null, dirtyAfterBuild = false, architecturesDiffer = false } = {}) {
  const template = bundle(t), output = join(template, 'release');
  const calls = [];
  let built = false;
  const run = (executable, args) => {
    calls.push([executable, ...args]);
    if (executable === failAt) throw new Error(`failed ${executable}`);
    if (executable === 'git') return args[0] === 'rev-parse' ? revision : (built && dirtyAfterBuild ? ' M source' : '');
    if (executable === 'security') return `1) ${identity} "Developer ID Application: Example (TEAM)"`;
    if (executable === '/bin/bash') built = true;
    if (executable === 'ditto' && args.length === 2) {
      mkdirSync(args[1]);
      fs.cpSync(join(template, 'Contents'), join(args[1], 'Contents'), { recursive: true });
    }
    if (executable === 'ditto' && args[0] === '-c') writeFileSync(args.at(-1), 'synthetic archive');
    if (executable === 'plutil' && args[0] === '-extract') return ({ ProjectRoomSourceRevision: revision, ProjectRoomSourceDirty: 'false', LSMinimumSystemVersion: '14.0', CFBundleVersion: '42' })[args[1]];
    if (executable === 'xcrun' && args[1] === 'submit') return JSON.stringify({ status: notaryStatus, id: 'synthetic-notary-id' });
    if (executable === 'lipo') return architecturesDiffer && args[1].endsWith('ProjectRoomTools') ? 'x86_64' : 'arm64';
    return '';
  };
  return { calls, output, run, invoke: () => distribute({ ...options, output }, { run, platform: 'darwin' }) };
}

test('receipt is emitted only after notarization, stapling and Gatekeeper verification', t => {
  const h = harness(t);
  const result = h.invoke();
  assert.equal(result.status, 'notarized');
  assert.equal(result.sourceRevision, revision);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.bytes, 17);
  const signing = h.calls.filter(call => call[0] === 'codesign' && call.includes('--sign'));
  assert.equal(signing.length, 2);
  assert.ok(signing.every(call => call.includes('runtime') && call.includes('--timestamp') && !call.includes('-')));
  const receipt = fs.readFileSync(join(h.output, 'release-receipt.json'), 'utf8');
  assert.ok(!receipt.includes(identity));
  assert.ok(h.calls.find(call => call[0] === 'spctl'));
  assert.ok(h.calls.find(call => call[0] === 'xcrun' && call[1] === 'stapler' && call[2] === 'validate'));
});

for (const [name, config] of [['notary rejection', { notaryStatus: 'Invalid' }], ['Gatekeeper failure', { failAt: 'spctl' }], ['source drift during build', { dirtyAfterBuild: true }], ['helper architecture mismatch', { architecturesDiffer: true }]]) {
  test(`${name} emits no success receipt`, t => {
    const h = harness(t, config);
    assert.throws(h.invoke);
    assert.equal(fs.existsSync(join(h.output, 'release-receipt.json')), false);
    if (config.dirtyAfterBuild || config.architecturesDiffer) assert.equal(h.calls.some(call => call[0] === 'codesign'), false);
    if (config.notaryStatus) assert.equal(h.calls.some(call => call[0] === 'spctl'), false);
  });
}

test('missing identity or wrong platform performs no build or upload', () => {
  const calls = [];
  const run = (exe, args) => { calls.push(exe); return exe === 'git' && args[0] === 'rev-parse' ? revision : ''; };
  assert.throws(() => distribute(options, { run, platform: 'linux' }), /macOS/);
  assert.equal(calls.length, 0);
  assert.throws(() => distribute(options, { run, platform: 'darwin' }), /unavailable/);
  assert.ok(!calls.includes('/bin/bash'));
});
