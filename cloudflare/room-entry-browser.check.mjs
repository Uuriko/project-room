import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { roomEntry } from '../deploy/room-entry.mjs';

// The deployed Worker owns host rewriting; Chromium owns fragment inheritance.
// The destination is the actual app/asset HTTP server, never fabricated auth UI.
test('bundled default doors reach minimal auth and inherit invitation, legacy, and room fragments', { timeout: 60000 }, async t => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./room.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'neutral', keepNames: true,
    external: ['node:*', 'cloudflare:*'] });
  const worker = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ROOM: { className: 'ProjectRoom', useSQLite: true } },
    bindings: { ROOM_ORIGIN: 'https://room.trydemigod.com' } });
  t.after(() => worker.dispose());
  const directory = mkdtempSync(join(tmpdir(), 'room-entry-browser-'));
  const store = new RoomStore(join(directory,'room.sqlite'));
  const server = createRoomServer({store});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {server.closeStreams(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); store.close(); rmSync(directory,{recursive:true,force:true});});
  const browser = await chromium.launch({headless:true});
  t.after(()=>browser.close());
  for (const width of [1280,390]) {
    const context = await browser.newContext({viewport:{width,height:844}});
    t.after(()=>context.close());
    const page = await context.newPage();
    const errors=[]; page.on('pageerror', error=>errors.push(error.stack));
    page.setDefaultTimeout(10000);
    // Playwright skips route interception on the second leg of an HTTP
    // redirect. Assert the production Location, then map only its authority
    // to the real local app server; path/query/status and fragment inheritance
    // remain browser-owned. This prevents mixed live/candidate assets.
    const fulfillDoor = async (route,response) => {
      const headers=Object.fromEntries(response.headers);
      assert.equal(response.status,302);
      const original = new URL(route.request().url());
      assert.equal(headers.location,'https://room.trydemigod.com/'+original.search);
      assert.equal(new URL(headers.location).hash,'');
      headers.location=origin+'/'+original.search;
      await route.fulfill({status:response.status,headers,body:await response.text()});
    };
    await page.route(/^https:\/\/(?:www\.)?getdasha\.com\/room(?:[/?].*)?$/,async route=> {
      const response=await worker.dispatchFetch(route.request().url(),{redirect:'manual',headers:{Accept:'text/html'}});
      await fulfillDoor(route,response);
    });
    await page.route('https://www.trydemigod.com/room**',async route=> {
      const response=roomEntry(new Request(route.request().url(),{headers:{Accept:'text/html'}}));
      await fulfillDoor(route,response);
    });
    for (const host of ['getdasha.com','www.getdasha.com','www.trydemigod.com']) {
      await page.goto(`https://${host}/room/?entry=release&next=%2Fabout`);
      await page.locator('#auth-panel').waitFor({state:'visible'});
      assert.equal(new URL(page.url()).origin,origin);
      assert.equal(new URL(page.url()).search,'?entry=release&next=%2Fabout');
      assert.equal(await page.locator('#auth-title').innerText(),'PROJECT ROOM');
      assert.equal(await page.getByRole('button',{name:'Agent sign in',exact:true}).count(),1);
      assert.equal(await page.getByRole('button',{name:'Create account',exact:true}).isVisible(),true);
      assert.equal(await page.getByRole('button',{name:'Log in',exact:true}).isVisible(),true);
      assert.doesNotMatch(await page.locator('body').innerText(),/A shared place|Conversations, shared work|New here\?|Have an invite\?|Connect an agent|Paste a prompt/);
    }
    // Observe the browser's first destination before app routing handles each
    // fragment. Fragments never reach the HTTP server or the Worker Request.
    for (const hash of ['#join/'+'A'.repeat(43)+'/work/item-1','#invite/'+'B'.repeat(43),'#code/abc-def-ghj','#room/qa-room','#join/']) {
      let arrived;
      const listener=frame=> {if(frame===page.mainFrame() && frame.url().startsWith(origin+'/')) arrived ??= frame.url();};
      page.on('framenavigated',listener);
      await page.goto('https://www.getdasha.com/room?ref=invite&room=qa'+hash);
      page.off('framenavigated',listener);
      assert.equal(arrived,origin+'/?ref=invite&room=qa'+hash);
    }
    assert.deepEqual(errors,[]);
    await context.close();
  }
  const packet=await worker.dispatchFetch('https://www.getdasha.com/room/',{headers:{Accept:'text/plain'}});
  assert.equal(packet.status,200); assert.match(await packet.text(),/Project Room/);
  const discovery=await worker.dispatchFetch('https://www.getdasha.com/room/llms.txt');
  assert.equal(discovery.status,200); assert.match(await discovery.text(),/Project Room/);
});
