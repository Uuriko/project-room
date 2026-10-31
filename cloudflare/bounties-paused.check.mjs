import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('actual Workers production bindings pause new bounty work and preserve settlement routes', async () => {
  const bundled = await build({ stdin: {
    contents: `import { bountyNewWorkEnabled, BOUNTY_NEW_WORK_ROUTES } from '../server/bounty-flag.mjs';
      export default {fetch(){return Response.json({enabled:bountyNewWorkEnabled(),
        blocked:[...BOUNTY_NEW_WORK_ROUTES]});}};`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url))
  }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  for (const [bindings, enabled] of [
    [{ ROOM_DEPLOYMENT: 'production' }, false],
    [{ ROOM_DEPLOYMENT: 'production', ROOM_BOUNTY_WORK: '1' }, true],
    [{ ROOM_DEPLOYMENT: 'staging', ROOM_BOUNTY_WORK: '0' }, false]
  ]) {
    const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', 'enable_request_signal',
        'request_signal_passthrough', 'enable_nodejs_http_server_modules'], bindings });
    try {
      const response = await mf.dispatchFetch('https://room.example.test/');
      const result = await response.json();
      assert.equal(result.enabled, enabled);
      assert.deepEqual(result.blocked.sort(), ['claim', 'create', 'fund', 'submit']);
      for (const route of ['accept', 'dispute', 'finalize', 'transfer']) assert.equal(result.blocked.includes(route), false);
    } finally { await mf.dispose(); }
  }
});
