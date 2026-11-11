import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('actual Worker selected Operator status compares fresh proofs without writes, refuses corrupt content and gates parsing',async()=>{
  const token='synthetic-selected-parity-operator-0123456789';
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./operator-selected-parity.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SelectedParityRoom',useSQLite:true}},bindings:{ROOM_OPERATOR_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')}});
  const call=async(path,auth=true)=>{const response=await mf.dispatchFetch('http://localhost'+path,{headers:auth?{authorization:'Operator '+token}:{}});return response.json();};
  try {
    const {head}=await call('/seed'),query='/api/operator/status?parityRoom=commons&expectedHead='+head;
    const clean=await call(query);assert.equal(clean.status,200,JSON.stringify(clean));assert.equal(clean.body.messageParityDiagnostics.rooms[0].status,'clean');assert.equal(clean.body.messageParityDiagnostics.rooms[0].proofsVerified,true);assert.equal(clean.writes,0);
    assert.ok(Buffer.byteLength(JSON.stringify(clean.body))<=4096);assert.doesNotMatch(JSON.stringify(clean),/PRIVATE_/);
    const refused=await call('/api/operator/status?parityRoom=&expectedHead=bad',false);assert.equal(refused.status,404);assert.equal(refused.writes,0);
    const invalid=await call('/api/operator/status?parityRoom=&expectedHead=bad');assert.equal(invalid.status,422);assert.equal(invalid.writes,0);
    await call('/corrupt');const corrupt=await call(query);assert.equal(corrupt.body.messageParityDiagnostics.rooms[0].status,'unknown');assert.equal(corrupt.writes,0);
  } finally {await mf.dispose();}
});
