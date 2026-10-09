// tests/lifecycle.test.js — install/enable/disable/uninstall state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleError, NotFoundError, AlreadyInstalledError, STATES } from '../src/registry.mjs';
import { exampleSource, freshRegistry, installEnable } from './helpers.mjs';

test('full lifecycle: install -> enable -> disable -> enable -> uninstall', () => {
  const { registry } = freshRegistry();
  const manifest = registry.install(exampleSource('greet'));
  assert.equal(manifest.name, 'greet');
  assert.equal(registry.get('greet').state, STATES.INSTALLED);

  registry.enable('greet');
  assert.equal(registry.get('greet').state, STATES.ENABLED);

  registry.disable('greet');
  assert.equal(registry.get('greet').state, STATES.DISABLED);

  registry.enable('greet'); // re-enable from disabled
  assert.equal(registry.get('greet').state, STATES.ENABLED);

  registry.uninstall('greet');
  assert.throws(() => registry.get('greet'), NotFoundError);
});

test('uninstall from enabled auto-disables first', () => {
  const { registry, files } = freshRegistry();
  installEnable(registry, 'greet');
  registry.uninstall('greet');
  assert.throws(() => registry.get('greet'), NotFoundError);
  assert.deepEqual(files.listFiles('plugins/greet/'), []);
});

test('double install is rejected', () => {
  const { registry } = freshRegistry();
  registry.install(exampleSource('greet'));
  assert.throws(() => registry.install(exampleSource('greet')), AlreadyInstalledError);
});

test('invalid transitions throw LifecycleError and change nothing', () => {
  const { registry } = freshRegistry();
  registry.install(exampleSource('greet'));

  assert.throws(() => registry.disable('greet'), LifecycleError); // installed -> disable
  assert.throws(() => registry.enable('nope'), NotFoundError);
  assert.throws(() => registry.disable('nope'), NotFoundError); // unknown name
  assert.throws(() => registry.uninstall('nope'), NotFoundError);

  registry.enable('greet');
  assert.throws(() => registry.enable('greet'), LifecycleError); // double enable
  assert.equal(registry.get('greet').state, STATES.ENABLED); // unchanged
});

test('install with bad manifest or missing entry fails before any state change', () => {
  const { registry } = freshRegistry();
  const tree = exampleSource('greet');
  tree['plugin.json'] = tree['plugin.json'].replace('"greet"', '"BAD NAME"');
  assert.throws(() => registry.install(tree), /name/);
  assert.deepEqual(registry.list(), []);

  const tree2 = exampleSource('greet');
  delete tree2['index.js'];
  assert.throws(() => registry.install(tree2), /entry/);
  assert.deepEqual(registry.list(), []);
});

test('enable failure leaves plugin installed, never half-enabled', () => {
  const { registry } = freshRegistry();
  const tree = exampleSource('greet');
  tree['index.js'] = 'this is not valid javascript ((((';
  registry.install(tree);
  assert.throws(() => registry.enable('greet'), /entry failed/);
  assert.equal(registry.get('greet').state, STATES.INSTALLED);
  assert.equal(registry.bus.has('greet'), false);
});

test('journal records every transition', () => {
  const { registry } = freshRegistry();
  installEnable(registry, 'greet');
  registry.disable('greet');
  const actions = registry.journal.map((j) => j.action);
  assert.ok(actions.includes('install'));
  assert.ok(actions.includes('enable'));
  assert.ok(actions.includes('disable'));
  const en = registry.journal.find((j) => j.action === 'enable');
  assert.equal(en.from, 'installed');
  assert.equal(en.to, 'enabled');
});

test('no code runs at install time', () => {
  const { registry, logs } = freshRegistry();
  const tree = exampleSource('greet');
  tree['index.js'] = 'plugin.api.log("info", "RAN AT INSTALL");';
  registry.install(tree);
  assert.equal(logs.lines.length, 0);
});
