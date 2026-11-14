// The in-Room email inbox (/api/inbox, /api/auth/gmail/*) is served only on
// self-hosted Room with enableDeferredInbox; room.trydemigod.com answers 404.
// docs/openapi.yaml marks those paths x-self-host-only so agents reading the
// spec against the hosted site do not call dead routes, and the hosted
// /openapi.json must never list them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildOpenApiJson } from '../server/discoverability.mjs';

const yaml = readFileSync('docs/openapi.yaml', 'utf8').split('\n');
const inboxPath = p => p === '/api/inbox' || p.startsWith('/api/inbox/') || p.startsWith('/api/auth/gmail/');

function pathItems() {
  const items = [];
  for (let i = 0; i < yaml.length; i += 1) {
    const m = /^  (\/\S+):\s*$/.exec(yaml[i]);
    if (!m) continue;
    let selfHostOnly = false;
    for (let j = i + 1; j < yaml.length && !/^  \S/.test(yaml[j]) && !/^\S/.test(yaml[j]); j += 1) {
      if (/^    x-self-host-only: true\s*$/.test(yaml[j])) selfHostOnly = true;
    }
    items.push({ path: m[1], selfHostOnly });
  }
  return items;
}

test('every inbox and Gmail path in openapi.yaml is marked x-self-host-only', () => {
  const inbox = pathItems().filter(item => inboxPath(item.path));
  assert.ok(inbox.length >= 20, `expected the inbox paths, found ${inbox.length}`);
  assert.deepEqual(inbox.filter(item => !item.selfHostOnly).map(item => item.path), []);
});

test('only inbox and Gmail paths carry the marker', () => {
  assert.deepEqual(pathItems().filter(item => item.selfHostOnly && !inboxPath(item.path)).map(item => item.path), []);
});

test('the hosted /openapi.json lists no self-host-only path', () => {
  const doc = buildOpenApiJson({ origin: 'https://room.example' });
  assert.deepEqual(Object.keys(doc.paths).filter(inboxPath), []);
});
