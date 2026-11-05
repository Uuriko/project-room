import * as gate from '../../../scripts/coverage-thresholds.mjs';
const root='/tmp/root-coverage-memory-fixture',url='file://'+root+'/mod/a.mjs';
function* payloads(){for(let i=0;i<2000;i++)yield{result:[{url,functions:Array.from({length:150},()=>({functionName:'synthetic',ranges:Array.from({length:12},()=>({startOffset:0,endOffset:24,count:1}))}))}]};}
const config={modules:{mod:{dir:'mod',threshold:100}}};
const start=performance.now();
const results=process.argv[2]==='reference'?gate.evaluateModules(root,config,gate.groupFunctionsByUrl(payloads(),root)):gate.evaluatePayloads(root,config,payloads()).results;
console.log(JSON.stringify({mode:process.argv[2],pct:results.mod.pct,elapsedMs:performance.now()-start,maxRSS:process.resourceUsage().maxRSS}));
