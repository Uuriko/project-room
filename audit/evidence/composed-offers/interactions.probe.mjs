// Actual owner enable → anonymous suggestions → outside-agent claim. No live services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from '../../../scripts/acceptance-fixture.mjs';
import { signInFixtureInPlace } from '../../../scripts/in-place-fixture-signin.mjs';
import { initialRoom } from '../../../server/bootstrap.mjs';
import { createRoomServer } from '../../../server/http.mjs';
import { createAgentIdentity } from '../../../client/room-agent.mjs';
import { PublicWorkClaimsClient } from '../../../client/public-work-claims.mjs';
async function setup(t, width) {
  const fixture = createAcceptanceFixture();
  const server = createRoomServer({ store: fixture.store, assetRoot: new URL('../../../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 320, hasTouch: width === 320 });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fixture.store.close(); assert.deepEqual(errors, []); });
  await page.goto(`${origin}/?room=commons`); await signInFixtureInPlace(page, fixture.store, fixture.keys.owner);
  return { ...fixture, page, browser, origin };
}
function preferenceTask(f) {
  f.store.projectOffers.create('commons', 'owner', { requestId: 'preference-create', offerId: 'preference-task', reviewerMemberIds: ['owner'], terms: { kind: 'task', title: 'JavaScript keyboard task', summary: 'A small volunteer contribution', acceptanceCriteria: ['Keyboard access'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  f.store.projectOffers.transition('commons', 'owner', 'preference-task', 'publish', { requestId: 'preference-publish', expectedRevision: 1 });
  f.store.publicWorkClaims.enable('commons', 'owner', 'preference-task', { requestId: 'preference-enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['src/preference.js'] });
}

const active = page => page.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName,match:document.activeElement.getAttribute('data-match-offer')}));
for (const width of [1280,320]) test(`delayed copy survives detail and return ${width}`, {timeout:30000}, async t=>{
 const f=await setup(t,width); preferenceTask(f); const p=f.page;
 await p.goto(f.origin+'/offers'); await p.locator('#find-work-form [type=submit]').click(); await p.locator('[data-match-offer]').waitFor();
 await p.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise((_,reject)=>window.rejectCopy=reject)}}));
 await p.locator('[data-copy-claim]').click(); const before=await active(p); await p.locator('[data-match-offer]').click();await p.locator('#copy-offer:not(:disabled)').waitFor();const detail=await active(p);
 await p.evaluate(()=>window.rejectCopy(new Error('synthetic denied')));await p.locator('#find-work-status').filter({hasText:'Copy the instructions under Read claim instructions'}).waitFor({state:'attached'});
 assert.deepEqual(await active(p),detail,'late copy must preserve detail focus');
 if(width===1280) await p.locator('[data-close]').click();else await p.goBack();
 await p.locator('.find-work').waitFor();const after=await active(p);assert.equal(after.match,'preference-task');assert.equal(await p.locator('#find-work-results textarea').isVisible(),true);
 await p.keyboard.press('Tab');const nextTab=await active(p);console.log(JSON.stringify({width,before,detail,after,nextTab}));assert.equal(await p.locator('[data-copy-claim]').isEnabled(),true);
});
test('empty published list direct link returns to visible search heading',{timeout:30000},async t=>{
 const f=await setup(t,320);preferenceTask(f);const p=f.page;await p.route('**/api/project-offers?*',route=>route.fulfill({status:200,json:{offers:[],nextCursor:null}}));
 await p.goto(f.origin+'/offers?offer=preference-task');await p.locator('#copy-offer:not(:disabled)').waitFor();await p.locator('#list-status').filter({hasText:'No open tasks'}).waitFor({state:'attached'});
 await p.locator('[data-close]').press('Enter');await p.locator('.find-work').waitFor();assert.equal((await active(p)).id,'find-work-title');await p.keyboard.press('Tab');console.log(JSON.stringify({directNextTab:await active(p)}));assert.equal(await p.locator('.match-filters summary').evaluate(el=>el===document.activeElement),true);
});
