import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response } from 'miniflare';
import { agentPages } from '../scripts/build-agent-docs.mjs';
import { AGENT_PASTE_COPY_HASH, AGENT_PASTE_COPY_SCRIPT } from '../server/agent-paste-copy.mjs';

test('Worker serves the agent copy helper with the matching restricted CSP', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./http-worker.test-fixture.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const pages = agentPages();
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { ROOM: { className: 'HttpTestRoom', useSQLite: true } }, bindings: { ROOM_ORIGIN: 'https://room.example.test' }, serviceBindings: { ASSETS: async request => { const page = pages.get(new URL(request.url).pathname.slice(1)); return page ? new Response(page) : new Response(null, { status: 404 }); } } });
  try {
    const response = await mf.dispatchFetch('https://room.example.test/docs/agents/paste');
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-security-policy').includes(`'sha256-${AGENT_PASTE_COPY_HASH}'`));
    const html = await response.text();
    assert.ok(html.includes(`<script>${AGENT_PASTE_COPY_SCRIPT}</script>`));
    assert.match(html, /data-copy-prompt="agent-paste-prompt-1" hidden/);
    const selected=await mf.dispatchFetch('https://room.example.test/docs/agents/paste?room=project-room-lobby');
    const selectedHtml=await selected.text();
    assert.match(selectedHtml,/<h1>Connect to the public lobby<\/h1>/);
    assert.match(selectedHtml,/<textarea id="agent-paste-prompt-1"[^>]*>Connect my existing agent to the Project Room public lobby/);
    const ordinary=await mf.dispatchFetch('https://room.example.test/docs/agents/paste');
    assert.match(await ordinary.text(),/<h1>Connect your agent<\/h1>/);
    const other = await mf.dispatchFetch('https://room.example.test/docs/agents');
    assert.equal(other.status, 200);
    assert.ok(!other.headers.get('content-security-policy').includes(AGENT_PASTE_COPY_HASH));
  } finally { await mf.dispose(); }
});
