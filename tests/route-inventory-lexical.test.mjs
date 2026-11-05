import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync}from'node:fs';
import {extractLegacyRoutes,loadRouteSources,allowlistProblems}from'../scripts/routes-inventory.mjs';
import {RoomStore}from'../server/store.mjs';import{initialRoom}from'../server/bootstrap.mjs';import{createRoomServer}from'../server/http.mjs';
const root=new URL('../',import.meta.url).pathname;
function scan(http){const source=loadRouteSources(root);for(const key of Object.keys(source))if(key!=='constants')source[key]='';return extractLegacyRoutes({...source,http:'function dispatch(req,url){'+http+'}'}).map(r=>r.method+' '+r.path).sort();}
test('OAuth choice shadow cannot inherit a room matcher from another scope',()=>{
 const source=String.raw`const match = /^\/api\/rooms\/([^/]{1,384})(?:\/(commands|events|activity-read))?$/.exec(url.pathname);
 if(url.pathname === "/oauth/authorize" && req.method === "GET") { const match = agentChoices.find(choice => choice.id === selected); if(match) agentChoices.splice(0, agentChoices.length, match); }
 const route = match ? (match[2] ?? "") : "";
 if(route === "commands" && req.method === "POST") { json(res,200,store.command()); }
 if(route === "events" && req.method === "GET") { json(res,200,store.events()); }
 if(route === "activity-read" && req.method === "POST") { json(res,200,store.mark()); }`;
 assert.deepEqual(scan(source),['GET /api/rooms/{id}/events','GET /oauth/authorize','POST /api/rooms/{id}/activity-read','POST /api/rooms/{id}/commands']);
});
test('distinct lexical matchers, aliases, nested method gates and parameter shadows remain accurate',()=>{
 const source=String.raw`
 const match = /^\/api\/outer$/.exec(url.pathname);
 function first(){const match=/^\/api\/first$/.exec(url.pathname);if(match && req.method === "GET"){return json(res,200,{});}}
 function second(){const pattern=/^\/api\/second$/;const match=pattern.exec(url.pathname);const alias=match;if(req.method === "POST"){if(alias){return json(res,200,{});}}}
 function unrelated(match){if(req.method === "DELETE"){if(match){return selected.splice(0,1);}}}
 if(match && req.method === "HEAD"){return json(res,200,{});}`;
 assert.deepEqual(scan(source),['GET /api/first','HEAD /api/outer','POST /api/second']);
});
test('exact real HTTP source agrees with unchanged RT-0 inventory',()=>{
 const source=loadRouteSources(root),document=JSON.parse(readFileSync(new URL('../scripts/routes-legacy-allowlist.json',import.meta.url),'utf8'));
 assert.deepEqual(allowlistProblems(extractLegacyRoutes(source),document),[]);
});
test('authenticated HTTP methods retain actual POST dispatch and reject fabricated GETs',async t=>{
 const store=new RoomStore(':memory:');store.initialize(initialRoom());const key=store.issueAccessKey('commons','owner'),server=createRoomServer({store});
 t.after(async()=>{server.closeStreams();server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));store.close();});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const call=async(path,method,data)=>{const r=await fetch(origin+path,{method,redirect:'manual',headers:{Origin:origin,Authorization:'Bearer '+key,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return{status:r.status,body:await r.json().catch(()=>null)};};
 const mark=await call('/api/rooms/commons/activity-read','POST',{ids:[1]});assert.equal(mark.status,200);assert.equal(mark.body.read,0);
 for(const path of ['/api/rooms/commons/activity-read','/api/rooms/commons/commands','/api/rooms/commons/import']){const denied=await call(path,'GET');assert.equal(denied.status,405,path);assert.equal(denied.body.error.code,'method_not_allowed',path);}
 const badCommand=await call('/api/rooms/commons/commands','POST',{});assert.equal(badCommand.status,422);
 const missing=await call('/api/rooms/commons/not-a-real-route','GET');assert.equal(missing.status,404);
});
