import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { EVENT_TYPES as T, PERMISSIONS } from '../src/events.js';
import { signInFixture } from './auth-signin.mjs';
import { clickChrome } from './room-chrome.mjs';

for (const theme of ['dark', 'light']) for (const width of [1280, 390]) {
  test(`Muse co-owner invite ${theme} ${width}`, {timeout: 60000}, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'muse-invite-browser-'));
    const store = new RoomStore(join(directory, 'room.sqlite'));
    store.initialize(initialRoom('muse-room'));
    const owner = store.issueAccessKey('muse-room', 'owner');
    store.command(owner, 'muse-room', {id: randomUUID(), type: T.ROOM_DEVELOPMENT_ACCESS_SET, data: {enabled:true}});
    store.command(owner, 'muse-room', {id: randomUUID(), type: T.MEMBER_ADDED,
      data: {memberId:'developer', displayName:'Dev collaborator', kind:'human', permissions:[...PERMISSIONS]}});
    const key = store.issueAccessKey('muse-room', 'developer');
    const server = createRoomServer({store, streamInterval:60});
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async()=>{await browser?.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});});
    browser=await chromium.launch({headless:true,...(process.env.ROOM_TEST_CHROMIUM_PATH?{executablePath:process.env.ROOM_TEST_CHROMIUM_PATH}:{})});
    const context=await browser.newContext({viewport:{width,height:900}, reducedMotion:'reduce',colorScheme:theme});
    await context.addInitScript(theme=>{localStorage.setItem('project-room-theme',theme);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedInvite=value;}}});},theme);
    const page=await context.newPage();page.setDefaultTimeout(12000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await signInFixture(page,key);
    await clickChrome(page,'#invite-people-button');
    await page.locator('#share-link-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#share-link-access').inputValue(),'co_owner');
    assert.equal(await page.locator('#growth-kit').isVisible(),false);
    await page.locator('#share-link-create').click();
    await page.locator('#share-link-result').waitFor({state:'visible'}).catch(async error=>{console.log('INVITE FAILURE',await page.locator('#share-link-dialog').innerText(),errors);throw error;});
    const url=await page.locator('#share-link-url').inputValue();
    assert.ok(url.includes('#join/'));
    assert.match(await page.locator('#share-purpose-note').innerText(),/full room access/);
    const token=url.split('#join/')[1].split('?')[0];
    assert.deepEqual(store.shareLinks.preview(token).link.permissions,PERMISSIONS);
    assert.equal(store.shareLinks.list(owner,'muse-room').links.length,1);
    await page.locator('#growth-kit summary').click();
    await page.locator('#growth-copy-agent').click();
    assert.ok((await page.evaluate(()=>window.copiedInvite)).includes(token));
    mkdirSync('test-results',{recursive:true});
    await page.screenshot({path:`test-results/muse-invite-${theme}-${width}.png`});
    assert.deepEqual(errors,[]);
  });
}
