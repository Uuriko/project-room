// tests/sandbox.test.js — the execution boundary holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxTimeoutError, STATES } from '../src/registry.mjs';
import { exampleSource, freshRegistry, installEnable } from './helpers.mjs';

test('evil plugin: every escape attempt is blocked, host untouched', () => {
  const { registry, logs } = freshRegistry();
  installEnable(registry, 'evil');

  // Host globals must not exist inside the sandbox.
  const [res] = registry.dispatch('room.message.posted', { author: 'x', body: 'hi' });
  assert.equal(res.ok, true);
  const r = res.result.results;
  assert.match(r.process, /blocked|undefined/);
  assert.match(r.process2, /blocked|undefined/);
  assert.match(r.require, /blocked|undefined/);
  assert.match(r.fetch, /blocked|undefined/);
  assert.match(r['fs-via-constructor'], /blocked|undefined/);
  assert.match(r['api-escape'], /blocked|undefined/);
  assert.match(r.wasm, /blocked|undefined/);
  assert.equal(r['timer-escape'], 'undefined'); // no timers capability

  // Host process itself is provably unaffected.
  assert.equal(globalThis.__pwned, undefined);
  assert.equal(Object.prototype.__polluted, undefined);
  assert.equal(typeof process, 'object'); // host still has its own process
  assert.ok(process.pid > 0);

  const line = logs.forPlugin('evil').find((l) => l.line.includes('evil results'));
  assert.ok(line, 'evil plugin logged its attempt results');
});

test('plugin cannot read host secrets via api or console', () => {
  const { registry, logs } = freshRegistry();
  const tree = exampleSource('greet');
  tree['index.js'] = `
    plugin.on('room.message.posted', () => {
      let saw = 'none';
      try { saw = typeof process.env.SECRET_TOKEN; } catch (e) { saw = 'blocked'; }
      console.log('saw=' + saw);
      return { ok: true };
    });`;
  tree['plugin.json'] = tree['plugin.json'].replace('"room.member.joined"', '"room.message.posted"');
  registry.install(tree);
  registry.enable('greet');
  process.env.SECRET_TOKEN = 'shh-test-value';
  try {
    registry.dispatch('room.message.posted', {});
    const line = logs.forPlugin('greet').find((l) => l.line.includes('saw='));
    assert.ok(line && !line.line.includes('shh-test-value'), 'secret never leaked into plugin logs');
  } finally {
    delete process.env.SECRET_TOKEN;
  }
});

test('infinite loop in entry is killed by timeout; enable fails closed', () => {
  const { registry } = freshRegistry({
    sandboxLimits: { entryTimeoutMs: 200, hookTimeoutMs: 100 },
  });
  const tree = exampleSource('greet');
  tree['index.js'] = 'while (true) {}';
  registry.install(tree);
  assert.throws(() => registry.enable('greet'), SandboxTimeoutError);
  assert.equal(registry.get('greet').state, STATES.INSTALLED);
  assert.equal(registry.bus.has('greet'), false);
});

test('infinite loop in hook handler auto-disables the plugin', () => {
  const { registry } = freshRegistry({
    sandboxLimits: { entryTimeoutMs: 1000, hookTimeoutMs: 100 },
  });
  const tree = exampleSource('greet');
  tree['plugin.json'] = tree['plugin.json'].replace('"room.member.joined"', '"room.message.posted"');
  tree['index.js'] = `plugin.on('room.message.posted', () => { while (true) {} });`;
  registry.install(tree);
  registry.enable('greet');
  const [res] = registry.dispatch('room.message.posted', {});
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(registry.get('greet').state, STATES.DISABLED);
  assert.ok(registry.journal.some((j) => j.action === 'auto-disable'));
});

test('plugin config is deep-frozen and cannot be mutated', () => {
  const { registry } = freshRegistry();
  const tree = exampleSource('greet');
  tree['index.js'] = `
    let before, after;
    plugin.on('room.member.joined', () => {
      before = plugin.config.greeting;
      try { plugin.config.greeting = 'hacked'; } catch (e) {}
      after = plugin.config.greeting;
      return { ok: true, before, after };
    });`;
  registry.install(tree);
  registry.enable('greet');
  const [res] = registry.dispatch('room.member.joined', { member: 'zoe' });
  assert.equal(res.result.before, 'welcome');
  assert.equal(res.result.after, 'welcome');
});

test('undeclared hook registration is rejected', () => {
  const { registry } = freshRegistry();
  const tree = exampleSource('greet');
  tree['index.js'] = `plugin.on('room.nuke.everything', () => {});`;
  registry.install(tree);
  assert.throws(() => registry.enable('greet'), /not declared in manifest/);
  assert.equal(registry.get('greet').state, STATES.INSTALLED);
});

test('duplicate handler registration for one hook is rejected', () => {
  const { registry } = freshRegistry();
  const tree = exampleSource('greet');
  tree['index.js'] = `
    plugin.on('room.member.joined', () => {});
    plugin.on('room.member.joined', () => {});`;
  registry.install(tree);
  assert.throws(() => registry.enable('greet'), /already registered/);
});
