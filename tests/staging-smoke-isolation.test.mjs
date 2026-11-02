import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {liveSmoke,DISCOVERY,PUBLIC_PAGES,LIVE_ORIGIN} from '../scripts/live-smoke.mjs';
import {agentCard} from '../server/agent-discovery.mjs';
const origin='https://staging.example.test',revision='a'.repeat(40),githubApi='https://github-api.example.test';
function fixture(t,{a2a=405,redirect=false}={}){
 const calls=[],card=JSON.stringify({url:LIVE_ORIGIN+'/a2a',entry:'https://www.getdasha.com/room/a2a',provider:'https://accounts.google.com/o/oauth2/v2/auth',marketing:'https://www.getdasha.com/pricing',networkPath:LIVE_ORIGIN+'//provider.example/a2a'});
 t.mock.method(globalThis,'fetch',async(raw,init={})=>{
  const u=new URL(raw);calls.push({url:u.href,redirect:init.redirect});
  if(u.origin===githubApi)return Response.json({sha:revision});
  if(u.origin!==origin)return new Response('production unavailable',{status:503});
  if(u.pathname==='/api/version')return Response.json({sourceRevision:revision});
  if(u.pathname==='//provider.example/a2a')return new Response('{}',{status:405});
  if(u.pathname==='/a2a')return new Response('{}',{status:redirect?302:a2a,headers:{'content-type':'application/json',...(redirect?{location:LIVE_ORIGIN+'/a2a'}:{})}});
  const doc=DISCOVERY.find(d=>d.path===u.pathname);
  if(doc)return new Response(doc.path==='/.well-known/agent-card.json'?card:doc.json?'{}':doc.path==='/robots.txt'?'User-agent: *\nAllow: /':'<xml/>',{headers:{'content-type':doc.type==='json'?'application/json':doc.type==='xml'?'application/xml':doc.type}});
  return new Response('<!doctype html><title>Room</title>',{status:PUBLIC_PAGES.includes(u.pathname)||u.pathname==='/favicon.ico'?200:404,headers:{'content-type':'text/html'}});
 });
 return{calls,card};
}
test('isolated staging probes equivalent Room endpoints without following canonical/provider origins',async t=>{
 const f=fixture(t),before=JSON.stringify(agentCard());
 const report=await liveSmoke({origin,githubApi,isolated:true});
 assert.equal(report.ok,true,JSON.stringify(report.findings));
 assert.match(report.discoveryScope,/canonical availability not tested/);
 assert.ok(report.advertisedChecks.some(c=>c.advertisedUrl===LIVE_ORIGIN+'/a2a'&&c.testedUrl===origin+'/a2a'&&c.status===405));
 assert.ok(report.advertisedChecks.some(c=>c.advertisedUrl==='https://www.getdasha.com/room/a2a'&&c.testedUrl===origin+'/a2a'));
 assert.ok(report.advertisedChecks.some(c=>c.advertisedUrl==='https://www.getdasha.com/pricing'&&c.testedUrl===null));
 assert.ok(f.calls.every(c=>[origin,githubApi].includes(new URL(c.url).origin)));
 assert.ok(report.advertisedChecks.some(c=>c.testedUrl===origin+'//provider.example/a2a'));
 assert.equal(JSON.stringify(agentCard()),before,'signed canonical card builder remains untouched');
 assert.equal(agentCard().url,LIVE_ORIGIN);
});
for(const options of [{a2a:503},{redirect:true}])test('isolated staging still fails broken endpoints or redirects into production '+JSON.stringify(options),async t=>{
 const f=fixture(t,options),report=await liveSmoke({origin,githubApi,isolated:true});
 assert.equal(report.ok,false);assert.ok(report.findings.some(x=>x.code==='advertised_url'&&x.severity==='fail'));
 assert.ok(f.calls.every(c=>[origin,githubApi].includes(new URL(c.url).origin)));
});
test('ordinary production-scope smoke still detects canonical outage',async t=>{
 const f=fixture(t),report=await liveSmoke({origin,githubApi});
 assert.equal(report.ok,false);assert.ok(report.findings.some(x=>x.code==='advertised_url'&&x.detail.startsWith(LIVE_ORIGIN+'/a2a -> 503')));
 assert.ok(f.calls.some(c=>c.url===LIVE_ORIGIN+'/a2a'));
});
test('isolated mode cannot relabel the production host as staging',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('No network allowed in qualification');});
 await assert.rejects(liveSmoke({origin:LIVE_ORIGIN,isolated:true}),/separate environment/);
});
test('staging explicitly scopes smoke and uploads failure artifacts only after its secret gate passed',()=>{
 const workflow=parse(readFileSync(new URL('../.github/workflows/staging.yml',import.meta.url),'utf8'));
 const steps=workflow.jobs.deploy.steps;
 assert.equal(steps.find(s=>s.name==='Smoke and browser checks').env.ROOM_SMOKE_ISOLATED,'1');
 assert.equal(steps.find(s=>s.uses?.startsWith('actions/upload-artifact@')).if,"always() && steps.gate.outputs.ready == 'true'");
 assert.ok(steps.find(s=>s.name==='Deploy isolated staging').env.ROOM_AGENT_CARD_SIGNING_KEY);
 assert.ok(steps.find(s=>s.name==='Deploy isolated staging').run.includes('--env staging'));
});
