import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('actual workerd settlement savepoints retain prior/later events and notify only after outer commit',async()=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./claim-pr-savepoint.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{PROBE:{className:'ClaimSavepointProbe',useSQLite:true}}});
  try{for(const kind of ['invalid-claim','storage','unexpected']){
    const response=await mf.dispatchFetch('http://localhost/'+kind),result=await response.json();
    assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.bad.state,'claimed');assert.equal(result.bad.pullRequest.outcome,null);
    if(kind==='invalid-claim'){
      assert.deepEqual(result.writes,['target','bad-middle','good-last']);
      assert.deepEqual(result.out.applied.map(item=>item.claimId),['target','good-last']);
      assert.equal(result.headDelta,2);assert.equal(result.stampDelta,1);
      assert.deepEqual(result.notifications,[{roomId:'commons',inTransaction:false,head:result.head+2}]);
    }else{
      assert.deepEqual(result.writes,['target','bad-middle']);assert.equal(result.headDelta,0);assert.equal(result.stampDelta,0);
      assert.equal(result.rowsEqual,true);assert.deepEqual(result.notifications,[]);assert.ok(result.error);
      if(kind==='storage')assert.equal(result.error.code,'storage_unavailable');
    }
  }}finally{await mf.dispose();}
});
