import {RETURN_BRIEF_DEFAULT_LIMIT} from '../server/return-brief.mjs';
import test from'node:test';import assert from'node:assert/strict';import{chromium}from'playwright';import{RoomStore}from'../server/store.mjs';import{createRoomServer}from'../server/http.mjs';import{signInFixture}from'./auth-signin.mjs';
for(const width of[1280,390])test('normalized Needs me and catch-up preserve keyboard/privacy at '+width,{timeout:60000},async t=>{
 const store=new RoomStore(':memory:');store.createAccount('attention-owner');const slot=store.createAccountSessionSlot(),session=store.loginAccountSession(slot.token,store.issueAccountAccessKey('attention-owner'),0),made=store.createAccountRoom(slot.token,session.sessionBinding,{roomId:'attention-native',title:'Attention',purpose:'Coordinate',kind:'personal',displayName:'Owner'}),ownerId=made.room.memberId,owner=store.issueAccessKey('attention-native',ownerId);for(const id of['worker','other'])store.command(owner,'attention-native',{id:'add-'+id,type:'member.added',data:{memberId:id,displayName:id==='worker'?'Worker':'Other',kind:'agent',permissions:['accept_work'],accountableHumanId:ownerId}});const worker=store.issueAccessKey('attention-native','worker');let clock=Date.now();store.now=()=>clock;const send=(id,body,extra={})=>{clock+=2100;store.command(worker,'attention-native',{id,type:'message.posted',data:{messageId:id,body,...extra}});};for(let n=0;n<RETURN_BRIEF_DEFAULT_LIMIT;n++)send('older-'+n,'Older public history');send('owner-mention','@Owner please review this visible note');send('private-other','PRIVATE OTHER MEMBERS ONLY',{toMemberId:'other'});for(let n=0;n<24;n++)send('plain-'+n,'Ordinary public context');
 const server=createRoomServer({store,credentialReadBurst:600});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true,...(process.env.ROOM_TEST_CHROMIUM_PATH?{executablePath:process.env.ROOM_TEST_CHROMIUM_PATH}:{})});t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),origin=`http://127.0.0.1:${server.address().port}`,marks=[],errors=[];page.setDefaultTimeout(10000);page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/updates/'))marks.push(r.url());});page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/?room=attention-native');await signInFixture(page,owner);await page.locator('#topbar-updates').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#topbar-updates')?.textContent.includes('Needs me'));await page.locator('#topbar-updates').click();await page.locator('#updates-dialog[open]').waitFor();await page.waitForFunction(()=>document.querySelector('#updates-page-announcement')?.textContent.includes('Page 1'));
 assert.equal(await page.locator('.updates-filters').isVisible(),false);assert.equal(await page.locator('[data-update-action="done"]').count(),0);assert.equal(await page.locator('[data-update-action="clear"]').count(),0);let pages=0;for(;pages<12;pages++){if((await page.locator('.updates-list').innerText()).includes('please review this visible note'))break;const more=page.locator('#updates-load-more');assert.equal(await more.isVisible(),true);await page.waitForFunction(()=>!document.querySelector('#updates-load-more')?.disabled);await more.press('Enter');try{await page.waitForFunction(n=>document.querySelector('#updates-page-announcement')?.textContent.includes('Page '+n),pages+2);}catch(e){t.diagnostic(JSON.stringify(await page.evaluate(()=>({status:document.querySelector('#updates-status')?.textContent,page:document.querySelector('#updates-page-announcement')?.textContent,moreHidden:document.querySelector('#updates-load-more')?.hidden,disabled:document.querySelector('#updates-load-more')?.disabled,focused:document.activeElement?.id}))));throw e;}}
 assert.ok(pages<12);assert.equal((await page.locator('#updates-dialog').innerText()).includes('PRIVATE OTHER MEMBERS ONLY'),false);assert.deepEqual(marks,[]);assert.equal(await page.locator('#updates-dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);await page.locator('.updates-row').filter({hasText:'please review this visible note'}).getByRole('button',{name:/^Open/}).click();await page.locator('#updates-dialog').waitFor({state:'hidden'});assert.deepEqual(marks,[]);await page.keyboard.press('Control+k');await page.locator('#room-actions-query').fill('Catch up');await page.locator('#room-actions-list').getByRole('button',{name:'Catch up',exact:true}).click();await page.locator('#catchup-dialog[open]').waitFor();await page.waitForFunction(()=>document.querySelector('#rb-history-boundary')?.textContent.includes('through'));await page.locator('#rb-history-heading').click();let historyPages=1;while(await page.locator('#rb-more-button').isVisible()){await page.waitForFunction(()=>!document.querySelector('#return-brief-panel')?.getAttribute('aria-busy')?.includes('true'));const before=await page.locator('#rb-history-list').innerText();await page.locator('#rb-more-button').click();await page.waitForFunction(old=>document.querySelector('#rb-history-list')?.innerText!==old||document.querySelector('#rb-more-button')?.hidden,before);assert.ok(++historyPages<20);}assert.equal((await page.locator('#rb-history-list').innerText()).includes('PRIVATE OTHER MEMBERS ONLY'),false);assert.ok(historyPages>1);assert.equal(store.db.prepare('SELECT count(*) n FROM cursors').get().n,0);await page.locator('#rb-ack-button').click();await page.waitForFunction(()=>document.querySelector('#rb-ack-button')?.textContent==='Already caught up');assert.ok(store.db.prepare('SELECT count(*) n FROM cursors').get().n>0);assert.deepEqual(errors,[]);t.diagnostic(JSON.stringify({width,pages:pages+1,noMarks:true,privateHidden:true,keyboardContinuation:true,historyPages,explicitAcknowledgment:true}));
});


for (const width of [1280,390]) test('normalized join approvals remain visible and reusable in Needs me at '+width,{timeout:60000},async t=>{
 const store=new RoomStore(':memory:');
 store.createAccount('join-owner');
 const slot=store.createAccountSessionSlot();
 const session=store.loginAccountSession(slot.token,store.issueAccountAccessKey('join-owner'),0);
 const made=store.createAccountRoom(slot.token,session.sessionBinding,{roomId:'join-native',title:'Join approval',purpose:'Coordinate',kind:'personal',displayName:'Owner'});
 const owner=store.issueAccessKey('join-native',made.room.memberId);
 const peer=store.identities.create('Grok peer');
 const {AccessRequests}=await import('../server/access-requests.mjs');
 const requests=new AccessRequests(store);
 const request=requests.request('join-native',{identityId:peer.identityId,displayName:'Grok peer',requestedPermissions:['accept_work','complete_work'],requestId:'join-native-peer'},peer.secret);
 assert.equal(request.status,'pending');
 const server=createRoomServer({store,credentialReadBurst:600});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.ROOM_TEST_CHROMIUM_PATH?{executablePath:process.env.ROOM_TEST_CHROMIUM_PATH}:{})});
 t.after(async()=>{await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
 page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/?room=join-native');
 await signInFixture(page,owner);
 await page.waitForFunction(()=>document.querySelector('#updates-count')?.textContent==='1');
 assert.equal(await page.locator('#updates-count').isVisible(),true,'pending join contributes to badge before opening');
 await page.locator('#topbar-updates').click();
 await page.locator('#updates-dialog[open]').waitFor();
 const row=page.locator('[data-access-request-id="join-native-peer"]');
 await row.waitFor({state:'attached'});
 assert.equal(await row.isVisible(),true,'loaded pending requests must not be hidden behind native attention');
 assert.match(await page.locator('.updates-list').innerText(),/No conversation or work/);
 await row.getByRole('button',{name:'Approve — Grok peer asks to join',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[data-access-request-id="join-native-peer"]'));
 await page.waitForFunction(()=>document.querySelector('#updates-count')?.hidden===true);
 const admitted=store.authenticate(peer.secret,'join-native');
 assert.equal(admitted.member.id,peer.identityId,'the existing identity must be reused');
 assert.deepEqual(admitted.member.permissions,['accept_work','complete_work']);
 assert.equal(store.db.prepare("SELECT count(*) n FROM access_requests WHERE request_id='join-native-peer' AND status='approved'").get().n,1);
 assert.deepEqual(errors,[]);
});
