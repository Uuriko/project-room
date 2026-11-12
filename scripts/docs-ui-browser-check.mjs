import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signInFixture } from './auth-signin.mjs';

test('authenticated room documents: create, read, conflict and retain draft',{timeout:60000},async t=>{
 const f=createAcceptanceFixture(), server=createRoomServer({store:f.store,roomDocsEnabled:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.ROOM_TEST_CHROMIUM_PATH?{executablePath:process.env.ROOM_TEST_CHROMIUM_PATH}:{})});
 t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true})});
 const page=await browser.newPage(),errors=[];page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);try{await signInFixture(page,f.keys.owner)}catch(e){t.diagnostic(JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(0,2000)}));throw e}await page.locator('#main:not([hidden])').waitFor();
 await page.locator('#room-docs-open').click();await page.getByRole('dialog',{name:'Docs'}).waitFor();page.once('dialog',d=>d.accept('test-doc'));await page.getByRole('button',{name:'New document'}).click();await page.locator('[data-title]').fill('Test document');await page.locator('[data-body]').fill('First draft');await page.locator('[data-save]').click();try{await page.getByText('Saved.',{exact:true}).waitFor()}catch(e){t.diagnostic(JSON.stringify({errors,doc:await page.locator('#room-docs-root').innerText()}));throw e};
 await page.getByRole('button',{name:'Test document'}).waitFor();await page.getByRole('button',{name:'Test document'}).click();assert.equal(await page.locator('[data-content] pre').innerText(),'First draft');await page.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('[data-body]').fill('Unsaved local draft');
 const response=await page.request.post(`http://127.0.0.1:${server.address().port}/api/rooms/commons/docs/test-doc`,{headers:{authorization:`Bearer ${f.keys.owner}`},data:{title:'Test document',body:'Peer revision',baseRev:1}});assert.equal(response.status(),200);
 await page.locator('[data-save]').click();await page.getByText(/This document changed/).waitFor();assert.equal(await page.locator('[data-body]').inputValue(),'Unsaved local draft');assert.match(await page.locator('[data-conflict]').innerText(),/Peer revision/);assert.deepEqual(errors,[]);
});

test('disabled docs do not expose navigation',{timeout:30000},async t=>{
 const f=createAcceptanceFixture(),server=createRoomServer({store:f.store,roomDocsEnabled:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.ROOM_TEST_CHROMIUM_PATH?{executablePath:process.env.ROOM_TEST_CHROMIUM_PATH}:{})});
 t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true})});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);const probe=page.waitForResponse(r=>r.url().includes('/api/rooms/commons/docs?limit=1')&&r.status()===404);await signInFixture(page,f.keys.owner);await page.locator('#main:not([hidden])').waitFor();await probe;assert.equal(await page.locator('#room-docs-open').isVisible(),false);
});
