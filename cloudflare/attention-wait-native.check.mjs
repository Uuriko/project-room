import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

test('production Native MCP waits across another request and cold cursor reuse', {timeout: 60000}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'attention-wait-native-'));
  const script = (await build({entryPoints: [new URL('./attention-wait-native.test-fixture.mjs', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*']})).outputFiles[0].text;
  const create = () => new Miniflare({script, modules: true, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_request_signal', 'request_signal_passthrough', 'enable_nodejs_http_server_modules'], durableObjectsPersist: directory, durableObjects: {ROOM: {className: 'AttentionWaitRoom', useSQLite: true}}, bindings: {ROOM_ORIGIN: 'https://room.example.test'}, serviceBindings: {ASSETS: async () => new Response('missing', {status: 404})}});
  let mf = create();
  const invoke = (saved, timeoutSec, after = saved.after, signal) => mf.dispatchFetch('https://room.example.test/mcp', {method: 'POST', signal, headers: {Host: 'room.example.test', Authorization: 'Bearer ' + saved.token, 'Content-Type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 'wait', method: 'tools/call', params: {name: 'room_wait_for_attention', arguments: {roomId: 'commons', after, timeoutSec}}})}).then(async response => ({status: response.status, body: await response.json()}));
  const accepted = value => { assert.equal(value.status, 200, JSON.stringify(value)); assert.ok(value.body.result?.structuredContent, JSON.stringify(value)); assert.notEqual(value.body.result?.isError, true, JSON.stringify(value)); return value.body.result.structuredContent; };
  try {
    const saved = await (await mf.dispatchFetch('https://room.example.test/__seed')).json();
    const waiting = invoke(saved, 2);
    await delay(80);
    assert.equal((await mf.dispatchFetch('https://room.example.test/__post?id=native-attention')).status, 200);
    const ready = accepted(await waiting);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.items.map(item => item.messageId), ['native-attention']);
    assert.equal(ready.acknowledges, false);
    assert.equal(accepted(await invoke(saved, 1, ready.after)).status, 'timeout');
    const cancel = new AbortController();
    const cancelled = assert.rejects(invoke(saved, 2, ready.after, cancel.signal), error => error.name === 'AbortError');
    await delay(60);
    cancel.abort();
    await cancelled;
    // The client disconnect still may not propagate through the Native hop.
    // Immediate authenticated retry supersedes that retained generation.
    assert.equal(accepted(await invoke(saved, 0, ready.after)).status, 'timeout');
    await mf.dispose();
    mf = create();
    assert.equal(accepted(await invoke(saved, 0, ready.after)).status, 'timeout');
    t.diagnostic('Actual Native commit-notified wake, timeout and cold cursor reuse passed. Native retry immediately reclaimed the disconnected wait through generation replacement. Immediate native disconnect propagation and 120-second host acceptance remain unqualified.');
  } finally { await mf.dispose(); await rm(directory, {recursive: true, force: true}); }
});
