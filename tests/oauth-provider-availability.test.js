import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

test('public provider availability is bounded metadata without a session or secrets', async t => {
  for (const [githubAuth, configured] of [[null, false], [{ clientId: 'fixture-client', clientSecret: 'private-fixture-secret' }, true], [{ clientId: 'broken' }, false]]) {
    const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, githubAuth });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.address().port}/api/auth/providers`;
    const response = await fetch(url); assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { providers: { github: { configured } } });
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  }
});
