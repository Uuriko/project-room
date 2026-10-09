// tests/fakes.test.js — the fake backends behave like their contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeFiles, FakeKV, FakeLogSink, makeBackends } from '../fakes/fake-store.mjs';

test('FakeFiles: write/read/list/removeDir', () => {
  const f = new FakeFiles();
  f.writeFile('plugins/a/index.js', 'code');
  f.writeFile('plugins/a/plugin.json', '{}');
  f.writeFile('plugins/b/index.js', 'other');
  assert.equal(f.readFile('plugins/a/index.js'), 'code');
  assert.deepEqual(f.listFiles('plugins/a/').sort(), ['plugins/a/index.js', 'plugins/a/plugin.json']);
  assert.throws(() => f.readFile('plugins/nope/x.js'), /not found/);
  f.removeDir('plugins/a/');
  assert.deepEqual(f.listFiles('plugins/a/'), []);
  assert.equal(f.readFile('plugins/b/index.js'), 'other');
});

test('FakeKV: clone-on-write and clone-on-read', () => {
  const kv = new FakeKV();
  const v = { nested: { x: 1 } };
  kv.set('k', v);
  v.nested.x = 999;
  assert.equal(kv.get('k').nested.x, 1);
  const out = kv.get('k');
  out.nested.x = 555;
  assert.equal(kv.get('k').nested.x, 1);
  assert.equal(kv.get('missing'), undefined);
  kv.del('k');
  assert.equal(kv.get('k'), undefined);
});

test('FakeKV: keys() filters by prefix', () => {
  const kv = new FakeKV();
  kv.set('plugin:a:x', 1);
  kv.set('plugin:a:y', 2);
  kv.set('plugin:b:x', 3);
  assert.deepEqual(kv.keys('plugin:a:').sort(), ['plugin:a:x', 'plugin:a:y']);
});

test('FakeLogSink: captures and filters by plugin', () => {
  const logs = new FakeLogSink();
  logs.sink('info', 'a', 'hello');
  logs.sink('error', 'b', 'boom');
  assert.equal(logs.lines.length, 2);
  assert.deepEqual(logs.forPlugin('a').map((l) => l.line), ['hello']);
  assert.equal(logs.forPlugin('a')[0].level, 'info');
  logs.clear();
  assert.equal(logs.lines.length, 0);
});

test('makeBackends wires registry-shaped backends', () => {
  const { files, store, logs, backends } = makeBackends();
  assert.ok(files instanceof FakeFiles);
  assert.ok(store instanceof FakeKV);
  assert.ok(logs instanceof FakeLogSink);
  assert.equal(typeof backends.logSink, 'function');
  assert.equal(typeof backends.store.get, 'function');
});
