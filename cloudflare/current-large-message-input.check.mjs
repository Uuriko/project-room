import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('actual Native large canonical input retains cold privacy/proofs and flat addressed 1k/5k source cost', {timeout: 120000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'large-message-input-native-'));
  const script = (await build({entryPoints: [new URL('./current-large-message-input.test-fixture.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']})).outputFiles[0].text;
  const create = () => new Miniflare({script, modules: true, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'request_signal_passthrough', 'enable_nodejs_http_server_modules'], durableObjectsPersist: directory, durableObjects: {ROOM: {className: 'LargeMessageInputRoom', useSQLite: true}}, bindings: {ROOM_ORIGIN: 'https://room.example.test'}, serviceBindings: {ASSETS: async () => new Response('missing', {status: 404})}});
  let mf = create(); const costs = [];
  try {
    for (const [kind, count, live = false] of [['ascii', 0], ['cjk', 0], ['astral', 0], ['control', 1000], ['control', 5000], ['ascii', 0, true], ['cjk', 0, true], ['control', 0, true], ['astral', 0, true]]) {
      const surface = kind + count + (live ? '-live' : '');
      const call = async (path, options = {}) => {
        const response = await mf.dispatchFetch('https://room.example.test' + path + (path.includes('?') ? '&' : '?') + 'surface=' + surface, options);
        return {status: response.status, value: await response.json()};
      };
      const saved = (await call('/__large-seed?kind=' + kind + '&count=' + count + (live ? '&empty=1' : ''))).value;
      const headers = {authorization: 'Bearer ' + saved.owner, 'content-type': 'application/json'};
      const command = (id, type, data) => call('/api/rooms/commons/commands', {method: 'POST', headers, body: JSON.stringify({id, type, data})});
      if (live) {
        const body = kind === 'cjk' ? '界'.repeat(65536) : kind === 'control' ? '\u0001'.repeat(65536) : kind === 'astral' ? '😀'.repeat(32768) : 'x'.repeat(65536);
        for (const id of ['edit', 'delete', 'private']) assert.equal((await command('post-' + id, 'message.posted', {messageId: id, body, ...(id === 'private' ? {toMemberId: 'party'} : {})})).status, 201);
        assert.equal((await command('over-limit', 'message.posted', {messageId: 'over-limit', body: body + 'x'})).status, 422);
      }
      await mf.dispose(); mf = create();
      const selected = () => call('/api/rooms/commons/conversation?messageId=edit', {headers});
      assert.equal((await selected()).status, 200);
      const warm = await selected(); assert.equal(warm.status, 200); assert.equal(warm.value.messages[0].body.length, 65536);
      if (count) { const cost = (await call('/__large-cost')).value; assert.equal(cost.unknown, 0); assert.equal(cost.writes, 0); costs.push({kind, count, ...cost}); }
      for (const [id, token] of [['private', saved.other], ...(!live ? [['edit', saved.late]] : [])]) assert.equal((await call('/api/rooms/commons/conversation?messageId=' + id, {headers: {authorization: 'Bearer ' + token}})).status, 404);
      assert.equal((await command('reply', 'message.posted', {messageId: 'reply', body: 'Useful reply', replyToId: 'edit'})).status, 201);
      assert.equal((await command('edit', 'message.edited', {messageId: 'edit', body: 'Short replacement', expectedMessageRevision: 0})).status, 201);
      assert.equal((await command('edit', 'message.edited', {messageId: 'edit', body: 'Short replacement', expectedMessageRevision: 0})).status, 200);
      assert.equal((await command('delete', 'message.deleted', {messageId: 'delete', expectedMessageRevision: 0})).status, 201);
      await mf.dispose(); mf = create();
      assert.equal((await selected()).value.messages[0].body, 'Short replacement');
      assert.equal((await call('/api/rooms/commons/conversation?messageId=delete', {headers})).value.messages[0].body, null);
      const mode = kind === 'ascii' ? 'body' : kind === 'cjk' ? 'hash' : 'witness';
      assert.equal((await call('/__large-tamper?mode=' + mode)).status, 200);
      assert.notEqual((await call('/api/rooms/commons/conversation?messageId=private', {headers})).status, 200);
    }
    assert.equal(costs[0].reads, costs[1].reads);
    assert.equal(costs[0].statements, costs[1].statements);
    t.diagnostic('LARGE_CANONICAL_INPUT_NATIVE ' + JSON.stringify(costs));
  } finally { await mf.dispose(); await rm(directory, {recursive: true, force: true}); }
});
