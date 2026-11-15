import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as reserveServer } from 'node:net';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentPages } from '../scripts/build-agent-docs.mjs';
import { allowed, verifyRuntimeImports } from '../scripts/runtime-package.mjs';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';

test('explicit instance guides use their own MCP endpoint and no hosted lobby prerequisite', () => {
  const hosted = agentPages();
  assert.deepEqual(agentPages(undefined, { origin: 'https://room.trydemigod.com' }), hosted);
  for (const origin of ['https://alpha.example', 'https://beta.example']) {
    const pages = agentPages(undefined, { origin });
    for (const [path, html] of pages) {
      assert.ok(html.includes(origin), path);
      assert.equal(html.includes('https://room.trydemigod.com'), false, path);
      assert.equal(html.includes('project-room-lobby'), false, path);
    }
    assert.ok(pages.get('docs/agents/codex.html').includes(origin + '/mcp'));
    assert.ok(pages.get('docs/agents/paste.html').includes('room_check_access'));
  }
  for (const origin of ['https://alpha.example/path', 'https://user:password@alpha.example', 'http://remote.example']) {
    assert.throws(() => agentPages(undefined, { origin }));
  }
});

test('cold Node serves instance-local guides without a generated HTML build or header trust', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cold-instance-guides-'));
  const hosts = [];
  try {
    for (const label of ['alpha', 'beta']) {
      const reserve = reserveServer();
      await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
      const port = reserve.address().port;
      await new Promise(resolve => reserve.close(resolve));
      const origin = `http://127.0.0.1:${port}`;
      const store = new RoomStore(join(directory, label + '.sqlite'));
      const server = createRoomServer({ store, origin, assetRoot: new URL('file://' + directory + '/') });
      hosts.push({ server, store, origin });
      await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    }
    for (const { origin } of hosts) {
      for (const path of ['/docs/agents/paste', '/docs/agents/codex', '/docs/agents/paste?room=project-room-lobby']) {
        const response = await fetch(origin + path, { headers: { 'X-Forwarded-Host': 'wrong.example', 'X-Forwarded-Proto': 'https' } });
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.ok(html.includes(origin + '/mcp'));
        assert.equal(html.includes('https://room.trydemigod.com'), false);
        assert.equal(html.includes('project-room-lobby'), false);
        assert.equal(html.includes(hosts.find(host => host.origin !== origin).origin), false);
        assert.equal(html.includes('wrong.example'), false);
      }
      const head = await fetch(origin + '/docs/agents/paste', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    }
  } finally {
    for (const { server, store } of hosts) {
      server.closeStreams(); server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      store.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime source closure refuses missing guidance inputs', () => {
  const root = new URL('../', import.meta.url);
  const files = new Map([...allowed].filter(path => existsSync(new URL(path, root))).map(path => [path, readFileSync(new URL(path, root))]));
  assert.doesNotThrow(() => verifyRuntimeImports(files));
  files.delete('docs/agents/paste.md');
  assert.throws(() => verifyRuntimeImports(files), /runtime guidance source is missing: docs\/agents\/paste.md/);
});
