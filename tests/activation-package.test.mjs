// Actual allowlisted package HTTP endpoint, not imports from the source tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRuntimePackage,verifyRuntimePackage} from '../scripts/runtime-package.mjs';

test('exact-commit packaged activation serves authorized request continuation for both representations',async t=>{
  const repository=fileURLToPath(new URL('../',import.meta.url));
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
  const directory=mkdtempSync(join(tmpdir(),'activation-package-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const destination=join(directory,'runtime');
  createRuntimePackage({repository,commit,destination});
  const load=path=>import(pathToFileURL(join(destination,path)).href);
  const [{RoomStore},{initialRoom},{createRoomServer}]=await Promise.all([load('server/store.mjs'),load('server/bootstrap.mjs'),load('server/http.mjs')]);
  for(const current of [true,false]){
    const store=new RoomStore(':memory:');store.initialize(initialRoom(),current?{representation:'normalized-current-v1'}:{});
    const owner=store.issueAccessKey('commons','owner');
    const send=(type,data)=>store.command(owner,'commons',{id:crypto.randomUUID(),type,data});
    send('member.added',{memberId:'reader',displayName:'Reader',kind:'agent',permissions:[]});
    const reader=store.issueAccessKey('commons','reader');
    send('message.posted',{messageId:'request',toMemberId:'reader',requestKind:'reply',body:'Private request source'});
    const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const origin='http://127.0.0.1:'+server.address().port;
      const read=(path,key=reader)=>fetch(origin+path,{headers:{authorization:'Bearer '+key}});
      const before=store.headSequence('commons');
      const response=await read('/api/rooms/commons/activation-pack?view=brief');assert.equal(response.status,200);
      const brief=await response.json();assert.equal(brief.yourWork[0].kind,'request');assert.equal(brief.yourWork[0].id,'request');
      assert.doesNotMatch(JSON.stringify(brief),/Private request source/);assert.ok(Buffer.byteLength(JSON.stringify(brief))<=2048);
      const selected=await read(brief.next.endpoint);assert.equal(selected.status,200);assert.match(JSON.stringify(await selected.json()),/Private request source/);
      assert.equal(store.headSequence('commons'),before);
      send('reply_request.cancelled',{requestMessageId:'request',expectedRequestRevision:0,reason:'Resolved'});
      assert.ok(!(await (await read('/api/rooms/commons/activation-pack?view=brief')).json()).yourWork.some(x=>x.kind==='request'));
      store.issueAccessKey('commons','reader');assert.equal((await read('/api/rooms/commons/activation-pack?view=brief')).status,401);
    }finally{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();}
  }
  verifyRuntimePackage(destination,{expectedCommit:commit});
  console.log('Packaged activation tested exact source '+commit);
});
