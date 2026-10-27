import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('real workerd scan costs remain scoped and raw change probes are excluded',async()=>{
  const bundled=await build({entryPoints:[fileURLToPath(new URL('./sql-cost.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SqlCostTestRoom',useSQLite:true}}});
  try{
    const response=await mf.dispatchFetch('http://localhost/');
    assert.equal(response.status,200,await response.clone().text());
    const rows=await response.json();assert.equal(rows.length,2);
    assert.equal(rows[0].operation,'patrol');assert.equal(rows[0].statements,1);
    assert.equal(rows[0].rowsRead,100, 'actual scan, not returned row count');
    assert.equal(rows[1].operation,'mcp');assert.equal(rows[1].statements,3);
    assert.ok(rows[1].rowsRead>=200);assert.equal(rows[1].rowsWritten,1);
    assert.equal(rows[1].sqlErrors,1);assert.equal(rows[1].unknownRowCosts,1);
    assert.equal(rows[1].complete,false);assert.doesNotMatch(JSON.stringify(rows),/private_missing_table/);
  }finally{await mf.dispose();}
});

test('production DO wiring is opt-in and records readiness plus partial request scope', async () => {
  const bundled=await build({entryPoints:[fileURLToPath(new URL('./sql-cost.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  for (const enabled of ['0','1']) {
    const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SqlCostTestRoom',useSQLite:true},WIRED:{className:'WiredSqlCostRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_SQL_COST_LOG:enabled}});
    try {
      const response=await mf.dispatchFetch('http://localhost/wired');
      assert.equal(response.status,200,await response.clone().text());
      const result=await response.json();assert.equal(result.ready.ok,true);assert.equal(result.status,200);
      if(enabled==='0') assert.equal(result.rows.length,0);
      else {
        const readiness=result.rows.find(row=>row.scopeKind==='readiness');assert.equal(readiness.statements,1);
        const request=result.rows.find(row=>row.scopeKind==='request');assert.equal(request.complete,false);
        assert.equal(result.deniedStatus,401);
        assert.ok(result.rows.some(row=>row.scopeKind==='request' && row.operation==='room-view' && row.statements>0), 'ALS ownership survives actual HTTP adapter dispatch');
        assert.ok(result.rows.some(row=>row.scopeKind==='job' && row.operation==='integrity'), 'actual scheduled RPC has a child job scope');
        assert.ok(result.rows.some(row=>row.scopeKind==='scheduler' && row.operation==='job-eligibility'), 'scheduler scope emitted separately');
        assert.ok(result.rows.some(row=>row.scopeKind==='unscoped'), 'constructor costs are explicit unattributed totals');
        assert.doesNotMatch(JSON.stringify(result.rows),/room.example|api\/version/);
      }
    }finally{await mf.dispose();}
  }
});
