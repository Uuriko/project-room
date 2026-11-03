import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('actual Native mitigation cold-reads, edits and erases each escaped body family at the temporary limit', {timeout: 60000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'message-mitigation-native-'));
  const script = (await build({entryPoints: [new URL('./message-mitigation-native.test-fixture.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']})).outputFiles[0].text;
  const create = () => new Miniflare({script, modules: true, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'request_signal_passthrough', 'enable_nodejs_http_server_modules'], durableObjectsPersist: directory, durableObjects: {ROOM: {className: 'MessageMitigationRoom', useSQLite: true}}, bindings: {ROOM_ORIGIN: 'https://room.example.test'}, serviceBindings: {ASSETS: async () => new Response('missing', {status: 404})}});
  let mf = create();
  try {
    for (const [surface, body] of [['ascii', 'x'.repeat(8192)], ['cjk', '界'.repeat(8192)], ['control', '\u0001'.repeat(8192)], ['astral', '😀'.repeat(4096)]]) {
      const call = async (path, options = {}) => {
        const response = await mf.dispatchFetch('https://room.example.test' + path + (path.includes('?') ? '&' : '?') + 'surface=' + surface, options);
        return {status: response.status, value: await response.json()};
      };
      const saved = (await call('/__seed')).value;
      const headers = {authorization: 'Bearer ' + saved.owner, 'content-type': 'application/json'};
      const command = (id, type, data) => call('/api/rooms/commons/commands', {method: 'POST', headers, body: JSON.stringify({id, type, data})});
      for (const id of ['edit', 'delete']) assert.equal((await command('post-' + id, 'message.posted', {messageId: id, body})).status, 201);
      const tooLarge = await command('over', 'message.posted', {messageId: 'over', body: body + 'x'});
      assert.equal(tooLarge.status, 422); assert.equal(tooLarge.value.error.code, 'message_body_temporarily_limited');
      await mf.dispose(); mf = create();
      for (const id of ['edit', 'delete']) {
        const read = await call('/api/rooms/commons/conversation?messageId=' + id, {headers});
        assert.equal(read.status, 200, JSON.stringify(read)); assert.equal(read.value.messages[0].body, body);
      }
      assert.equal((await command('reply', 'message.posted', {messageId: 'reply', replyToId: 'edit', body: 'Useful reply'})).status, 201);
      assert.equal((await command('edit', 'message.edited', {messageId: 'edit', body: 'Short replacement', expectedMessageRevision: 0})).status, 201);
      assert.equal((await command('delete', 'message.deleted', {messageId: 'delete', expectedMessageRevision: 0})).status, 201);
      await mf.dispose(); mf = create();
      const edited = await call('/api/rooms/commons/conversation?messageId=edit', {headers});
      const deleted = await call('/api/rooms/commons/conversation?messageId=delete', {headers});
      assert.equal(edited.status, 200); assert.equal(edited.value.messages[0].body, 'Short replacement');
      assert.equal(deleted.status, 200); assert.equal(deleted.value.messages[0].body, null);
    }
    t.diagnostic('8192 UTF-16 body units admitted for all four families;8193 refused; production constructor/HTTP and cold persistence passed. No production load.');
  } finally { await mf.dispose(); await rm(directory, {recursive: true, force: true}); }
});
