import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {chromium} from 'playwright';
import {createAcceptanceFixture} from './acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';

async function fixture(t){
 const f=createAcceptanceFixture(),server=createRoomServer({store:f.store,roomDocsEnabled:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.ROOM_TEST_CHROMIUM_PATH?{executablePath:process.env.ROOM_TEST_CHROMIUM_PATH}:{})});
 t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 const page=await browser.newPage({serviceWorkers:'block'});page.setDefaultTimeout(8000);await page.goto(`http://127.0.0.1:${server.address().port}`);return page;
}
async function register(page,email){await page.getByRole('button',{name:'Create account',exact:true}).click();await page.getByLabel('Email').fill(email);await page.getByLabel('Password',{exact:true}).fill('Local-only-password-482!');await page.getByRole('button',{name:'Create account',exact:true}).click();await page.locator('#main:not([hidden])').waitFor();}
async function create(page){await page.locator('#room-docs-open').click();await page.getByRole('button',{name:'New document'}).click();await page.locator('[data-title]').fill('Race document');await page.locator('[data-body]').fill('Initial');await page.locator('[data-save]').click();await page.getByText('Saved.',{exact:true}).waitFor();}

test('late save response after navigation preserves a newer local draft and selection',{timeout:30000},async t=>{
 const page=await fixture(t);await register(page,'race@example.invalid');await create(page);
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('[data-body]').fill('Submitted earlier');
 let release,arrived;const held=new Promise(r=>release=r),ready=new Promise(r=>arrived=r);
 await page.route('**/*',async route=>{if(route.request().method()!=='POST'||!route.request().url().includes('/docs/'))return route.continue();const response=await route.fetch({timeout:5000});arrived();await held;await route.fulfill({response});});
 await page.locator('[data-save]').click();await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Save interception missing')),5000))]);
 await page.getByRole('button',{name:'New document'}).click();await page.locator('[data-title]').fill('Separate draft');
 await page.getByRole('button',{name:'Race document',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-content] h3')?.textContent==='Race document');await page.locator('[data-body]').fill('Newer unsaved text');
 const completed=page.waitForResponse(r=>r.request().method()==='POST'&&/\/docs\//.test(r.url()));release();await (await completed).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.locator('[data-content] h3').innerText(),'Race document');assert.equal(await page.locator('[data-body]').inputValue(),'Newer unsaved text');
 await page.reload();await page.locator('#room-docs-open').click();await page.getByRole('button',{name:'Race document',exact:true}).click();
 assert.equal(await page.locator('[data-body]').inputValue(),'Newer unsaved text');
});

test('real logout and a second account cannot recover the first account document draft',{timeout:30000},async t=>{
 const page=await fixture(t);await register(page,'first@example.invalid');await create(page);
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('[data-body]').fill('Private first-account draft');
 const original=await page.evaluate(()=>sessionStorage.getItem('project-room:doc-drafts:v2'));assert.match(original,/Private first-account draft/);
 await page.locator('#room-docs-close').click();await page.locator('#session-menu-button').click();await page.locator('#signout-button').click();await page.locator('#auth-panel:visible').waitFor();
 await page.goto(new URL(page.url()).origin);await register(page,'second@example.invalid');await page.locator('#room-docs-open').click();assert.doesNotMatch(await page.locator('#room-docs-root').innerText(),/Race document|Private first-account draft/);
 // Restoring an old storage record is stronger than only relying on logout cleanup:
 // the real new authenticated session must reject the first session's scope.
 await page.evaluate(value=>sessionStorage.setItem('project-room:doc-drafts:v2',value),original);await page.reload();await page.locator('#room-docs-open').click();assert.doesNotMatch(await page.locator('#room-docs-root').innerText(),/Race document|Private first-account draft/);
});

test('same account switching into a real second room does not restore first-room drafts',{timeout:30000},async t=>{
 const page=await fixture(t);await register(page,'rooms@example.invalid');await create(page);
 const firstRoom=new URL(page.url()).searchParams.get('room');await page.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('[data-body]').fill('Private first-room draft');
 const original=await page.evaluate(()=>sessionStorage.getItem('project-room:doc-drafts:v2'));
 await page.locator('#room-docs-close').click();await page.locator('#nav-rooms').click();await page.locator('#account-room-create > summary').click();
 await page.locator('#account-room-title').fill('Second room');await page.locator('#account-room-purpose').fill('Local isolation acceptance');await page.locator('#account-room-name').fill('Fixture owner');await page.locator('#account-room-submit').click();
 await page.waitForFunction(first=>{const room=new URL(location.href).searchParams.get('room');return room&&room!==first;},firstRoom);
 await page.locator('#room-docs-open').click();assert.doesNotMatch(await page.locator('#room-docs-root').innerText(),/Race document|Private first-room draft/);
 await page.evaluate(value=>sessionStorage.setItem('project-room:doc-drafts:v2',value),original);await page.reload();await page.locator('#room-docs-open').click();assert.doesNotMatch(await page.locator('#room-docs-root').innerText(),/Race document|Private first-room draft/);
});


test('recovery capacity refuses a new draft without evicting existing saved drafts',{timeout:30000},async t=>{
 const page=await fixture(t);await register(page,'capacity@example.invalid');await create(page);
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('[data-body]').fill('First retained draft');
 for(let i=0;i<19;i++)await page.getByRole('button',{name:'New document'}).click();
 const before=await page.evaluate(()=>sessionStorage.getItem('project-room:doc-drafts:v2'));
 assert.match(before,/First retained draft/);
 await page.getByRole('button',{name:'New document'}).click();
 assert.match(await page.locator('[data-save-status]').innerText(),/Draft recovery unavailable/);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('project-room:doc-drafts:v2')),before);
});
