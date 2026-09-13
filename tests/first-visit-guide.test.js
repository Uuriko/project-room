import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('first-visit guide is short, works in populated rooms, and remembers each membership', () => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('let roomGuideStep = 0;'), source.indexOf('function syncComposerChrome()'));
  const nodes = new Map(), saved = new Map();
  const context = { state: { room: { id: 'welcome' }, messages: [{ body: 'Existing chat' }] }, session: { member: { id: 'alice' } },
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } };
  runInNewContext(functions + '\nshowRoomGuide();', context);
  assert.equal(nodes.get('#room-guide').hidden, false);
  assert.match(nodes.get('#room-guide-copy').textContent, /shared/);
  runInNewContext('roomGuideStep = 1; renderRoomGuide();', context);
  assert.match(nodes.get('#room-guide-copy').textContent, /Type @/);
  runInNewContext('roomGuideStep = 2; renderRoomGuide();', context);
  assert.equal(nodes.get('#room-guide-next').textContent, 'Got it');
  runInNewContext('dismissRoomGuide(); showRoomGuide();', context);
  assert.equal(nodes.get('#room-guide').hidden, true);
  context.session = { member: { id: 'bob' } };
  runInNewContext('showRoomGuide();', context);
  assert.equal(nodes.get('#room-guide').hidden, false);
});
