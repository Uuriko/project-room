// Disposable self-host entry, copy UI and deterministic structured-tool bridge.
import test from 'node:test';import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';import {join} from 'node:path';
import {createServer} from 'node:net';import {chromium} from 'playwright';
import {RoomStore} from '../server/store.mjs';import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';import {linkWithProof} from '../tests/helpers/link-with-proof.mjs';

test('selfhost generated prompt copies accessibly and bridges to the existing member MCP path', {timeout:45000},async t=>{
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const origin='http://127.0.0.1:'+port,store=new RoomStore(':memory:');store.initialize(initialRoom());
  const owner=store.issueAccessKey('commons','owner'),identity=store.identities.create('Mira');
  linkWithProof(store,owner,'commons',identity,{displayName:'Mira',permissions:['verify']});
  store.command(owner,'commons',{id:'assigned',type:'work.proposed',data:{workItemId:'assigned',title:'Inspect existing work',definitionOfDone:'Report evidence',accountableMemberId:identity.identityId,mode:'read'}});
  const makeServer=process.env.ENTRY_RUNTIME_DIR ? (await import(pathToFileURL(join(process.env.ENTRY_RUNTIME_DIR,'server/http.mjs')).href)).createRoomServer : createRoomServer;
  const server=makeServer({store,origin});await new Promise(r=>server.listen(port,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const before=store.headSequence('commons'),idsBefore=store.db.prepare('SELECT count(*) n FROM agent_identities').get().n;
  const page=await browser.newPage();
  await page.addInitScript(()=>{window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied.push(text);}}});});
  let prompt;
  for(const viewport of [{width:319,height:772},{width:1280,height:800}]){
    await page.setViewportSize(viewport);await page.goto(origin+'/docs/agents/paste?room=project-room-lobby');
    // The first paste block is the shareable-task prompt and correctly has no MCP URL.
    // The connect prompt is the one that must name this origin's /mcp path.
    const button=page.locator('[data-copy-prompt="agent-paste-prompt-2"]');await button.waitFor({state:'visible'});
    prompt=await page.locator('#agent-paste-prompt-2').inputValue();assert.ok(prompt.includes(origin+'/mcp'));assert.ok(!prompt.includes('room.trydemigod.com'));
    await page.keyboard.press('Tab');await page.keyboard.press('Tab');
    // Keyboard-focus the visible native button, then activate without a mouse.
    await button.focus();assert.equal(await button.evaluate(el=>getComputedStyle(el).outlineStyle),'solid');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#agent-paste-prompt-2-status').textContent.startsWith('Copied'));
    assert.equal(await page.evaluate(()=>window.copied.at(-1)),prompt);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.ENTRY_SCREENSHOT_DIR)await page.screenshot({path:process.env.ENTRY_SCREENSHOT_DIR+'/paste-'+viewport.width+'.png',fullPage:true});
  }
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}}));
  await page.locator('[data-copy-prompt="agent-paste-prompt-2"]').click();await page.waitForFunction(()=>document.querySelector('#agent-paste-prompt-2-status').textContent.startsWith('Copy the selected'));
  assert.equal(await page.locator('#agent-paste-prompt-2').evaluate(el=>el.selectionEnd-el.selectionStart),prompt.length);
  assert.equal(await page.locator('#agent-paste-prompt-2').evaluate(el=>document.activeElement===el),true);
  const nojs=await browser.newContext({javaScriptEnabled:false,viewport:{width:319,height:772}}),plain=await nojs.newPage();
  await plain.goto(origin+'/docs/agents/paste');assert.equal(await plain.locator('[data-copy-prompt]').first().isVisible(),false);
  await plain.locator('details').filter({has:plain.locator('#agent-paste-prompt-2')}).locator('summary').click();assert.equal(await plain.locator('#agent-paste-prompt-2').isVisible(),true);assert.equal(await plain.locator('#agent-paste-prompt-2').inputValue(),prompt);await nojs.close();
  await page.setViewportSize({width:319,height:772});
  await page.goto(origin+'/');assert.match(await page.locator('#agent-signin-description').innerText(),/existing agent identity/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.goto(origin+'/agent-signin');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.locator('a[href="/about"]').count(),1);assert.match(await page.locator('[data-agent-paste-hint]').innerText(),/owner approval/);assert.doesNotMatch(await page.locator('[data-agent-paste-hint]').innerText(),/sets itself up/);
  assert.equal((await fetch(origin+'/about')).status,200);
  // Deterministic bridge, NOT an LLM instruction-following trial or new enrollment.
  const rpc=async(name,args={})=>{const response=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+identity.secret},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{roomId:'commons',...args}}})});assert.equal(response.status,200);const json=await response.json();assert.equal(json.error,undefined,JSON.stringify(json));assert.notEqual(json.result.isError,true,JSON.stringify(json));return json.result.structuredContent;};
  assert.match(prompt,/room_check_access/);const access=await rpc('room_check_access');assert.equal(access.roomId,'commons');assert.equal(access.memberId,identity.identityId);assert.deepEqual(access.permissions,['verify']);assert.equal(access.externalExecution,false);
  const activation=await rpc('room_activation_pack',{view:'brief'});assert.equal(activation.room.slug,'commons');
  await rpc('room_read_inbox');const work=await rpc('room_list_work',{focus:'needs_me'});assert.ok(JSON.stringify(work).includes('assigned'));
  const selected=await rpc('room_read_work',{workItemId:'assigned',brief:true});assert.ok(JSON.stringify(selected).includes('assigned'));
  if(process.env.ENTRY_RESUME_MODULE){
    const {resumeAgent}=await import(pathToFileURL(process.env.ENTRY_RESUME_MODULE).href);const connection={origin,roomId:'commons',memberId:identity.identityId,token:identity.secret};
    const replies=await resumeAgent({connection,focus:'replies'}),full=await resumeAgent({connection,sinceVersion:replies.contextVersion});
    assert.ok(full.obligations.some(w=>w.id==='assigned'));assert.notEqual(replies.contextVersion,full.contextVersion);
    console.log('Scoped resume compatibility: '+replies.metrics.requests+' initial / '+full.metrics.requests+' returning reads.');
  }
  assert.equal(store.headSequence('commons'),before);assert.equal(store.db.prepare('SELECT count(*) n FROM agent_identities').get().n,idsBefore);
  console.log('Entry bridge:5 explicit read-only MCP calls; same existing room/member; no enrollment, writes or model execution.');
});
