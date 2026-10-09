// tests/hooks.test.js — hook fan-out, isolation, and boundary cloning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleSource, freshRegistry, installEnable } from './helpers.mjs';

test('greet + audit both fire on their hooks; results collected per plugin', async () => {
  const { registry, logs, store } = freshRegistry();
  installEnable(registry, 'greet');
  installEnable(registry, 'audit');

  const r1 = registry.dispatch('room.member.joined', { member: 'zoe' });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].plugin, 'greet');
  assert.equal(r1[0].ok, true);
  assert.equal(r1[0].result.greeted, 'zoe');

  // greet's deferred timer fires after dispatch returns
  await new Promise((r) => setTimeout(r, 60));
  const greetLines = logs.forPlugin('greet').map((l) => l.line);
  assert.ok(greetLines.some((l) => l.includes('welcome, zoe!')));
  assert.ok(greetLines.some((l) => l.includes('psst, zoe')));

  const r2 = registry.dispatch('room.message.posted', { author: 'zoe', body: 'hello room' });
  assert.equal(r2.length, 1);
  assert.equal(r2[0].plugin, 'audit');
  assert.equal(r2[0].result.count, 1);
  const messages = store.get('plugin:audit:messages');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].author, 'zoe');
});

test('one plugin throwing does not break the others', () => {
  const { registry, logs } = freshRegistry();
  installEnable(registry, 'audit');
  const tree = exampleSource('greet');
  tree['plugin.json'] = tree['plugin.json'].replace('"room.member.joined"', '"room.message.posted"');
  tree['index.js'] = `plugin.on('room.message.posted', () => { throw new Error('boom'); });`;
  registry.install(tree);
  registry.enable('greet');

  const results = registry.dispatch('room.message.posted', { author: 'a', body: 'b' });
  assert.equal(results.length, 2);
  const byName = Object.fromEntries(results.map((r) => [r.plugin, r]));
  assert.equal(byName.greet.ok, false);
  assert.match(byName.greet.error, /boom/);
  assert.equal(byName.audit.ok, true); // unaffected
  assert.equal(byName.audit.result.count, 1);
});

test('payload mutations inside a plugin never reach the host object', () => {
  const { registry } = freshRegistry();
  const tree = exampleSource('audit');
  tree['index.js'] = `
    plugin.on('room.message.posted', (p) => { p.author = 'mallory'; p.extra = 1; return { ok: true }; });`;
  registry.install(tree);
  registry.enable('audit');
  const payload = { author: 'zoe', body: 'hi' };
  registry.dispatch('room.message.posted', payload);
  assert.deepEqual(payload, { author: 'zoe', body: 'hi' });
});

test('hook results are detached from the sandbox (no live context objects)', () => {
  const { registry } = freshRegistry();
  const tree = exampleSource('audit');
  tree['index.js'] = `
    plugin.on('room.message.posted', () => { const o = { nested: { x: 1 } }; return { ok: true, o }; });`;
  registry.install(tree);
  registry.enable('audit');
  const [res] = registry.dispatch('room.message.posted', {});
  assert.deepEqual(res.result.o, { nested: { x: 1 } });
  // Mutating the returned result cannot affect any sandbox-side object:
  res.result.o.nested.x = 999;
  const [res2] = registry.dispatch('room.message.posted', {});
  assert.equal(res2.result.o.nested.x, 1);
});

test('storage is namespaced per plugin', () => {
  const { registry, store } = freshRegistry();
  installEnable(registry, 'audit');
  registry.dispatch('room.message.posted', { author: 'z', body: 'm' });
  assert.deepEqual(store.keys('plugin:audit:'), ['plugin:audit:messages']);
  assert.deepEqual(store.keys('plugin:greet:'), []);
});

test('dispatch to a hook nobody declared returns empty', () => {
  const { registry } = freshRegistry();
  installEnable(registry, 'greet');
  assert.deepEqual(registry.dispatch('work.claim.created', {}), []);
});

test('disabled plugin stops receiving hooks; timers are killed', async () => {
  const { registry, logs } = freshRegistry();
  installEnable(registry, 'greet');
  registry.disable('greet');
  assert.deepEqual(registry.dispatch('room.member.joined', { member: 'zoe' }), []);
  const before = logs.lines.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(logs.lines.length, before); // no deferred timer fired after disable
});
