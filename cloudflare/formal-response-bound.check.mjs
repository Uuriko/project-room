import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('Native escaped 8192-character formal answer preserves exact content and retry across cold restart', async () => {
  const built = await build({entryPoints:[fileURLToPath(new URL('./formal-response-bound.test-fixture.mjs', import.meta.url))],
    bundle:true, write:false, format:'esm', platform:'neutral', external:['node:*', 'cloudflare:*']});
  const directory = await mkdtemp(join(tmpdir(), 'native-formal-response-bound-'));
  const create = () => new Miniflare({modules:true, script:built.outputFiles[0].text,
    compatibilityDate:'2026-07-30', compatibilityFlags:['nodejs_compat'], durableObjectsPersist:directory,
    durableObjects:{ROOM:{className:'FormalResponseBoundRoom', useSQLite:true}}});
  let mf = create();
  const call = async path => {
    const response = await mf.dispatchFetch('http://localhost' + path), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  try {
    await call('/seed');
    await call('/link');
    const answer = await call('/answer-boundary');
    assert.equal(answer.characters, 8192);
    assert.ok(answer.commandBytes > 16384);
    assert.ok(answer.commandBytes <= 65536);
    assert.equal(answer.exactRetry, true);
    await mf.dispose();
    mf = create();
    assert.deepEqual(await call('/answer-cold'), {status:'answered', characters:8192,
      exactBody:true, exactParticipants:true, coldRetry:true});
  } finally {
    await mf.dispose();
    await rm(directory, {recursive:true, force:true});
  }
});
