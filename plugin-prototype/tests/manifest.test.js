// tests/manifest.test.js — plugin.json validation (fail-closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, validateManifest, ManifestError, HOOK_ALLOWLIST, CAPABILITY_ALLOWLIST } from '../src/manifest.mjs';

const good = () => ({
  manifestVersion: 1,
  name: 'greet',
  version: '1.2.0',
  description: 'Greets newcomers',
  author: 'jill',
  entry: 'index.js',
  hooks: ['room.member.joined'],
  capabilities: ['log', 'storage.kv'],
  config: { greeting: 'hi' },
});

const bad = (mutate) => {
  const m = good();
  mutate(m);
  assert.throws(() => validateManifest(m), ManifestError);
};

test('accepts a valid manifest and freezes it', () => {
  const m = validateManifest(good());
  assert.equal(m.name, 'greet');
  assert.ok(Object.isFrozen(m));
  assert.ok(Object.isFrozen(m.config));
});

test('parseManifest rejects invalid JSON', () => {
  assert.throws(() => parseManifest('{nope'), ManifestError);
});

test('rejects wrong/unknown manifestVersion', () => {
  bad((m) => { m.manifestVersion = 2; });
  bad((m) => { m.manifestVersion = '1'; });
  bad((m) => { delete m.manifestVersion; });
});

test('rejects bad names', () => {
  bad((m) => { m.name = 'Has Caps'; });
  bad((m) => { m.name = 'has space'; });
  bad((m) => { m.name = '-leading-dash'; });
  bad((m) => { m.name = 'UPPER'; });
  bad((m) => { m.name = ''; });
  bad((m) => { m.name = '../escape'; });
});

test('rejects non-strict semver', () => {
  bad((m) => { m.version = 'v1.2.0'; });
  bad((m) => { m.version = '1.2'; });
  bad((m) => { m.version = '1.2.0-beta'; });
  bad((m) => { m.version = '01.2.0'; });
});

test('rejects unsafe entry paths', () => {
  bad((m) => { m.entry = '../evil.js'; });
  bad((m) => { m.entry = '/abs.js'; });
  bad((m) => { m.entry = 'sub\\win.js'; });
  bad((m) => { m.entry = 'index.ts'; });
});

test('rejects unknown hooks and duplicates', () => {
  bad((m) => { m.hooks = ['room.nuke.everything']; });
  bad((m) => { m.hooks = ['room.message.posted', 'room.message.posted']; });
  bad((m) => { m.hooks = 'room.message.posted'; });
  assert.ok(HOOK_ALLOWLIST.length >= 7);
});

test('rejects unknown capabilities', () => {
  bad((m) => { m.capabilities = ['network']; });
  bad((m) => { m.capabilities = ['fs.read']; });
  bad((m) => { m.capabilities = ['log', 'log']; });
  assert.deepEqual([...CAPABILITY_ALLOWLIST].sort(), ['log', 'storage.kv', 'timers']);
});

test('rejects unknown top-level fields (typo fail-closed)', () => {
  bad((m) => { m.capabilitiez = ['log']; });
});

test('rejects bad description/author/config shapes', () => {
  bad((m) => { m.description = ''; });
  bad((m) => { m.description = 'x'.repeat(281); });
  bad((m) => { m.author = ''; });
  bad((m) => { m.config = [1, 2]; });
});

test('hooks/capabilities default to empty arrays', () => {
  const m = good();
  delete m.hooks; delete m.capabilities;
  const v = validateManifest(m);
  assert.deepEqual([...v.hooks], []);
  assert.deepEqual([...v.capabilities], []);
});
