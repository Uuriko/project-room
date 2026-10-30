import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

test('real workerd restricted callback transport verifies signed challenge and refuses untrusted origins', async () => {
  const bundle = await build({ stdin: { contents: `
    import { createWorkersMcpEventTransport } from './mcp-event-transport.mjs';
    import { verifyMcpEventCallback } from '../server/mcp-events-wire.mjs';
    export default { async fetch(request) {
      const path = new URL(request.url).pathname;
      let sent = 0;
      const transport = createWorkersMcpEventTransport(['https://receiver.example.com'], async (_url, init) => {
        sent++;
        if (init.redirect !== 'manual' || !init.headers['webhook-signature']) throw new Error('unsafe request');
        return Response.json({ challenge: JSON.parse(init.body).challenge });
      });
      try {
        const result = await verifyMcpEventCallback({subscriptionId:'sub_workerd', secret:'whsec_' + Buffer.alloc(32, 7).toString('base64'),
          url: path === '/allowed' ? 'https://receiver.example.com/callback' : 'https://other.example.com/private?secret=hidden', transport,
          dnsResolvers: {dohFetch: async url => ({ok:true,json:async()=>({Status:0,Answer:new URL(url).searchParams.get('type')==='A'?[{type:1,TTL:1,data:'8.8.8.8'}]:[]})})} });
        return Response.json({result, sent});
      } catch(error) { return Response.json({code:error.code,data:error.data,sent}); }
    }};`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'] });
  try {
    assert.deepEqual(await (await mf.dispatchFetch('https://room.test/allowed')).json(), { result: { verified: true }, sent: 1 });
    assert.deepEqual(await (await mf.dispatchFetch('https://room.test/blocked')).json(), { code: -32015, data: { reason: 'callback_origin_not_allowed', origin: 'https://other.example.com' }, sent: 0 });
  } finally { await mf.dispose(); }
});
