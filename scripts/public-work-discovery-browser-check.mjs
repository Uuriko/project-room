import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {createRoomServer} from '../server/http.mjs';

for(const width of [390,1280])test('published task discovery and keyboard paging at '+width,{timeout:60000},async t=>{
 const store=new RoomStore(':memory:'),roomId='public-work-room';store.initialize(initialRoom(roomId),{representation:'normalized-current-v1'});
 const owner=store.issueAccessKey(roomId,'owner'),send=(id,type,data)=>store.command(owner,roomId,{id,type,data});
 send('page','room.public_page_set',{enabled:true});
 for(let n=0;n<7;n++){
  send('task-'+n,'work.proposed',{workItemId:'task-'+n,title:n===0?'Review agent onboarding':'Task '+n,
   definitionOfDone:n===0?'Check keyboard setup and save a useful result.\nLiteral <task markup>\n'+ 'unbroken'.repeat(70):'Save a useful result '+n,accountableMemberId:'owner'});
  send('publish-'+n,'work.public_set',{workItemId:'task-'+n,enabled:true});
 }
 send('private','work.proposed',{workItemId:'private',title:'PRIVATE TASK',definitionOfDone:'PRIVATE INSTRUCTIONS',accountableMemberId:'owner'});
 const server=createRoomServer({store});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),origin='http://127.0.0.1:'+server.address().port;
 await page.goto(origin+'/r/'+roomId+'?ref=friend');
 assert.equal(await page.locator('.public-tasks li').count(),4);assert.doesNotMatch(await page.locator('main').innerText(),/PRIVATE TASK|PRIVATE INSTRUCTIONS/);
 assert.match(await page.locator('.public-tasks').innerText(),/Literal <task markup>/);assert.equal(await page.locator('task').count(),0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const violations=(await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations;
 assert.deepEqual(violations.map(v=>v.id),[]);
 mkdirSync('/tmp/pr-public-work-1103',{recursive:true});await page.screenshot({path:'/tmp/pr-public-work-1103/public-tasks-'+width+'.png',fullPage:true});
 const more=page.getByRole('link',{name:'More public tasks'}),href=await more.getAttribute('href');assert.match(href,/^\?workAfter=[A-Za-z0-9_-]+&ref=friend$/);assert.doesNotMatch(href,/task-3/);
 await more.focus();await page.keyboard.press('Enter');await page.waitForURL(origin+'/r/'+roomId+href);
 assert.equal(await page.locator('.public-tasks li').count(),3);assert.equal(await page.getByRole('link',{name:'More public tasks'}).count(),0);
 const expired=await page.goto(origin+'/r/'+roomId+'?workAfter=expired');assert.equal(expired.status(),422);
 const reload=page.getByRole('link',{name:'Reload public tasks',exact:true});await reload.focus();await page.keyboard.press('Enter');await page.waitForURL(origin+'/r/'+roomId);
 assert.equal(await page.locator('.public-tasks li').count(),4);
});
