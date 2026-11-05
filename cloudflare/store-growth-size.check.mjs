import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

test('actual Worker reports native SQLite bytes without unsupported page PRAGMAs', async () => {
  const bundled = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js', contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { measureStoreGrowth } from '../server/jobs.mjs';
    export class Gauge extends DurableObject {
      constructor(ctx,env) { super(ctx,env); ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY,sequence INTEGER,projection TEXT)'); }
      fetch() {
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO rooms VALUES ('synthetic',1,?)",'x'.repeat(16384));
        let pragmas=0;
        const sql=this.ctx.storage.sql;
        const db={storage:this.ctx.storage,prepare(query) { if(query.startsWith('PRAGMA'))pragmas++;return {get:()=>sql.exec(query).toArray()[0]}; }};
        const gauges=measureStoreGrowth({db});
        return Response.json({gauges,nativeBytes:sql.databaseSize,pragmas});
      }
    }
    export default {fetch(request,env) {return env.GAUGE.getByName('synthetic').fetch(request);}};
  ` }, bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*'] });
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { GAUGE: { className: 'Gauge', useSQLite: true } } });
  try {
    const response = await mf.dispatchFetch('https://fixture.example/');
    assert.equal(response.status,200);
    const value = await response.json();
    assert.ok(value.nativeBytes > 16384);
    assert.equal(value.gauges.dbBytes,value.nativeBytes,'unknown bytes must not look like an empty store');
    assert.equal(value.pragmas,0,'use the platform measurement without page scans or unsupported SQL');
    assert.equal(value.gauges.rooms,1);
    console.log(JSON.stringify({nativeBytes:value.nativeBytes,reportedBytes:value.gauges.dbBytes,pragmas:value.pragmas}));
  } finally { await mf.dispose(); }
});
