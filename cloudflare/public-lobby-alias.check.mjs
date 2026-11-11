import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('older lobby entry URLs reach the canonical host before storage or auth',{timeout:60000},async()=>{
 const script=(await build({entryPoints:[new URL('./room.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const mf=new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],bindings:{ROOM_ORIGIN:'https://room.example.test'}});
 try{
  for(const path of ['/watch','/docs/agents/paste?room=project-room-lobby']){
   const r=await mf.dispatchFetch('https://www.getdasha.com/room'+path,{redirect:'manual'});
   assert.equal(r.status,302,await r.text());assert.equal(r.headers.get('Location'),'https://room.example.test'+path);
   assert.equal(r.headers.get('Cache-Control'),'no-store');
  }
 }finally{await mf.dispose();}
});
