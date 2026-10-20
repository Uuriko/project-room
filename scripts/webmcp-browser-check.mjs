import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';
for (const native of [false, true]) test(`browser tool post is inert until visible confirmation, records once as the human (${native ? 'native WebMCP' : 'adapter'})`,async t=>{
 const f=createAcceptanceFixture();const server=createRoomServer({store:f.store,streamInterval:40});let browser;
 t.after(async()=>{await browser?.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,args:native?['--enable-features=WebMCP']:[]});const page=await browser.newPage({viewport:{width:1280,height:900}});
 if (!native) await page.addInitScript(()=>{window.roomTools=new Map();Object.defineProperty(document,'modelContext',{value:{registerTool(tool,{signal}){window.roomTools.set(tool.name,tool);signal.addEventListener('abort',()=>window.roomTools.delete(tool.name));return Promise.resolve();}}});});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await signInFixture(page,f.keys.owner);
 if (native) {
   await page.waitForFunction(async()=>typeof document.modelContext?.getTools==='function' && (await document.modelContext.getTools()).length===7);
   // Chrome 151 consumes JSON text arguments; Chrome 155 accepts objects.
   await page.evaluate(async()=>{window.roomTools=new Map((await document.modelContext.getTools()).map(tool=>[tool.name,{execute:async args=>JSON.parse(await document.modelContext.executeTool(tool,JSON.stringify(args)))}]));});
 }
 await page.waitForFunction(()=>window.roomTools.size===7);
 const clock=f.store.now;let offset=0;f.store.now=()=>clock()+offset;
 for(let i=0;i<61;i++) {offset+=3000;f.store.command(f.keys.owner,'commons',{id:`webmcp-seed-${i}`,type:'message.posted',data:{messageId:`webmcp-seed-${i}`,body:`pagination needle ${i}`}});}
 const matches=await page.evaluate(async()=>{let cursor,ids=[];do{const r=await window.roomTools.get('room_search').execute({query:'pagination needle',limit:5,...(cursor?{cursor}:{})},{signal:new AbortController().signal});ids.push(...r.messages.map(m=>m.id));cursor=r.nextCursor;}while(cursor);return ids;});assert.equal(new Set(matches).size,61);
 const before=f.store.room('commons').state.messages.length;
 await page.evaluate(()=>{window.postResult=window.roomTools.get('room_post').execute({body:'WebMCP confirmed browser message'},{signal:new AbortController().signal});});
 await page.locator('#webmcp-confirm').waitFor({state:'visible'});assert.equal(f.store.room('commons').state.messages.length,before);
 mkdirSync('/tmp/project-room-webmcp-evidence',{recursive:true});await page.screenshot({path:'/tmp/project-room-webmcp-evidence/confirmation.png'});
 await page.locator('#webmcp-confirm button').filter({hasText:'Cancel'}).click();assert.equal((await page.evaluate(()=>window.postResult)).status,'cancelled');assert.equal(f.store.room('commons').state.messages.length,before);
 await page.evaluate(()=>{window.postResult=window.roomTools.get('room_post').execute({body:'WebMCP confirmed browser message'},{signal:new AbortController().signal});});
 await page.locator('#webmcp-confirm button').filter({hasText:'Confirm'}).click();assert.equal((await page.evaluate(()=>window.postResult)).status,'recorded');
 const messages=f.store.room('commons').state.messages.filter(m=>m.body==='WebMCP confirmed browser message');assert.equal(messages.length,1);assert.equal(messages[0].authorId,'owner');
 assert.equal(await page.getByText('WebMCP confirmed browser message',{exact:true}).count(),1);
});
