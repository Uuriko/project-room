import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundled=await build({entryPoints:[fileURLToPath(new URL('./count-cost.bench-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'CountRoom',useSQLite:true}}});
try{
 await (await mf.dispatchFetch('http://localhost/?m=warm')).json();
 const out={};
 for(const m of ['old','new','old','new']){
  const walls=[];let last;
  for(let i=0;i<15;i++){const t=performance.now();const r=await mf.dispatchFetch('http://localhost/?m='+m);last=await r.json();walls.push(performance.now()-t);}
  walls.sort((a,b)=>a-b); out[m]={...last,wallMedianMs:+walls[7].toFixed(2),wallMinMs:+walls[0].toFixed(2)};
 }
 console.log(JSON.stringify(out,null,1));
 if(out.old.value!==out.new.value) throw new Error('count mismatch');
}finally{await mf.dispose();}
