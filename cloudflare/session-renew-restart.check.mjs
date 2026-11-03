import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';import {Miniflare} from 'miniflare';
test('renewed account session and signout survive Workers restarts', {timeout:30000}, async()=>{
 const b=await build({entryPoints:[fileURLToPath(new URL('./session-renew-restart.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const dir=await mkdtemp(join(tmpdir(),'room-session-renew-worker-'));
 const worker=()=>new Miniflare({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SessionRenewTestRoom',useSQLite:true}},durableObjectsPersist:dir});
 let mf=worker();
 const call=async(path,input,status=200)=>{const r=await mf.dispatchFetch('http://localhost'+path,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{});const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body;};
 try{const seeded=await call('/seed');await mf.dispose();mf=worker();const session=await call('/read',{token:seeded.token});assert.equal(session.accountId,seeded.accountId);assert.ok(session.expiresAt-session.now>29*86400000);assert.ok(session.lineage);await call('/read',{token:seeded.oldToken},401);const rotated=await call('/rotate',{token:seeded.token});assert.equal(rotated.lineage,session.lineage);await mf.dispose();mf=worker();assert.equal((await call('/read',{token:rotated.token})).lineage,session.lineage);await call('/logout',{token:rotated.token});await mf.dispose();mf=worker();await call('/read',{token:rotated.token},401);}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});

test('Workers migrate a legacy account slot and retain draft scope on rotation', {timeout:30000}, async()=>{
 const b=await build({entryPoints:[fileURLToPath(new URL('./session-renew-restart.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const dir=await mkdtemp(join(tmpdir(),'room-session-legacy-worker-'));
 const worker=()=>new Miniflare({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SessionRenewTestRoom',useSQLite:true}},durableObjectsPersist:dir});
 let mf=worker();
 const call=async(path,input)=>{const r=await mf.dispatchFetch('http://localhost'+path,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{});assert.equal(r.status,200,await r.clone().text());return r.json();};
 try{const seeded=await call('/seed');await call('/legacy',{token:seeded.token});await mf.dispose();mf=worker();const legacy=await call('/read',{token:seeded.token});assert.equal(legacy.lineage,null);const next=await call('/rotate',{token:seeded.token});assert.equal(next.lineage,legacy.binding);await mf.dispose();mf=worker();assert.equal((await call('/read',{token:next.token})).lineage,legacy.binding);}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});

test('Workers password HTTP login renews an old slot across restart and logout', {timeout:30000}, async()=>{
 const b=await build({entryPoints:[fileURLToPath(new URL('./session-renew-http.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const dir=await mkdtemp(join(tmpdir(),'room-session-renew-http-')),origin='https://room.example.test';
 const worker=()=>new Miniflare({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SessionRenewHttpRoom',useSQLite:true}},durableObjectsPersist:dir,bindings:{ROOM_ORIGIN:origin}});
 let mf=worker();
 try{
  const password=crypto.randomUUID();
  const seeded=await (await mf.dispatchFetch(origin+'/__test-aged-slot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})})).json();
  const login=await mf.dispatchFetch(origin+'/api/auth/password/login',{method:'POST',headers:{Origin:origin,'content-type':'application/json'},body:JSON.stringify({email:'renew@example.invalid',password,sessionToken:seeded.token,sessionRevision:seeded.revision})});
  assert.equal(login.status,200,await login.clone().text());const raw=login.headers.get('set-cookie'),match=/account_session=([A-Za-z0-9_-]{43})/.exec(raw??'');assert.ok(match);assert.notEqual(match[1],seeded.token);assert.ok(Number(/Max-Age=(\d+)/i.exec(raw)?.[1])>29*86400);
  const cookie='__Host-account_session='+match[1];await mf.dispose();mf=worker();
  const response=await mf.dispatchFetch(origin+'/api/account-session',{headers:{Cookie:cookie}});const session=await response.json();assert.equal(response.status,200);assert.equal(session.authenticated,true);assert.equal(session.account.id,'worker-renew-owner');
  const old=await mf.dispatchFetch(origin+'/api/account-session',{headers:{Cookie:'__Host-account_session='+seeded.token}});const oldView=await old.json();assert.equal(oldView.authenticated,false);
  const out=await mf.dispatchFetch(origin+'/api/account-session',{method:'DELETE',headers:{Origin:origin,Cookie:cookie,'content-type':'application/json','X-CSRF-Token':session.csrf,'X-Session-Binding':session.sessionBinding},body:JSON.stringify({expectedSessionRevision:session.sessionRevision})});assert.equal(out.status,200,await out.clone().text());
  await mf.dispose();mf=worker();const after=await (await mf.dispatchFetch(origin+'/api/account-session',{headers:{Cookie:cookie}})).json();assert.equal(after.authenticated,false);
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
