import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('Native MCP ingress admits bounded OAuth-size bodies to auth without authenticating forged tokens',async t=>{
 const built=await build({stdin:{contents:"export {default,ProjectRoom} from './room.mjs';",resolveDir:fileURLToPath(new URL('.',import.meta.url))},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const origin='https://room.example.test';
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'ProjectRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:origin}});
 t.after(()=>mf.dispose());
 const body=JSON.stringify({jsonrpc:'2.0',id:'large-oauth-body',method:'tools/call',params:{name:'room_post_message',arguments:{body:'line with "quotes"\n'.repeat(2200)}}});
 assert.ok(Buffer.byteLength(body)>16384);
 for(const prefix of ['oat_','iat_','pri_']){
  const response=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+prefix+'invalid-synthetic-fixture'},body});
  assert.equal(response.status,401,prefix+': must reach auth, not fail at anonymous-size cap');
 }
 const anonymous=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body});
 assert.equal(anonymous.status,413,'anonymous ingress remains bounded');
});
