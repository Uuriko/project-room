// A real local reviewer journey: the mirrored board activity must not claim
// that a reviewer delivered a result that someone else delivered earlier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { textVersion } from '../server/text-results.mjs';
import { signInFixture } from './auth-signin.mjs';

test('reviewing a delivered result does not attribute delivery to the reviewer', {timeout: 30000}, async t => {
  const f = createAcceptanceFixture();
  const send = (actor, type, data) => f.store.command(f.keys[actor], 'commons', {id: crypto.randomUUID(), type, data});
  send('owner', T.MEMBER_ADDED, {memberId:'reviewer-test', displayName:'Test checker', kind:'human', permissions:['verify']});
  f.keys['reviewer-test'] = f.store.issueAccessKey('commons', 'reviewer-test');
  const workItemId = 'review-activity', body = 'Agenda\n1. Milestones — Avery\n2. Owners — Sam';
  send('owner', T.WORK_PROPOSED, {workItemId, title:'Prepare the agenda', definitionOfDone:'Every agenda item has an owner.', mode:'read', accountableMemberId:'owner', verifierMemberId:'reviewer-test', independentVerificationRequired:true, ownerDecisionRequired:true, humanDecisionMakerId:'owner'});
  const item = () => f.store.room('commons').state.workItems[workItemId];
  send('owner', T.WORK_ACCEPTED, {workItemId, expectedRevision:item().revision});
  const posted = send('owner', T.MESSAGE_POSTED, {messageId:'review-activity-draft', workItemId, packetId:'review-activity-packet', basisRevision:1, body});
  send('owner', T.WORK_COMPLETED, {workItemId, expectedRevision:item().revision, evidenceKind:'room_text', evidenceMessageId:'review-activity-draft', evidenceMessageEventId:posted.event.id, evidenceVersion:textVersion(body), previousCompletionEventId:null, producerId:'owner', summary:'Agenda ready', nextAction:'Review owners'});
  const server = createRoomServer({store:f.store, streamInterval:40});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? {executablePath:process.env.ROOM_TEST_CHROMIUM_PATH} : {})});
  t.after(async () => {await browser.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  const page = await browser.newPage({viewport:{width:1280,height:720},serviceWorkers:'block'});
  const errors=[]; page.on('pageerror',error=>errors.push(error.message)); page.setDefaultTimeout(10000);
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(origin); await signInFixture(page,f.keys['reviewer-test']);
  await page.goto(`${origin}/?room=commons#pr-record/work/${workItemId}`);
  const card=page.locator(`[data-work-record-id="${workItemId}"]`);
  await card.getByRole('button',{name:'Record independent check'}).click();
  await page.locator('#action-text-body').getByText(body,{exact:true}).waitFor();
  await page.locator('#action-fields [name=result]').selectOption('pass');
  await page.locator('#action-fields [name=summary]').fill('Both items name an owner.');
  await page.getByRole('button',{name:'Save record',exact:true}).click();
  await page.locator('#action-dialog').waitFor({state:'hidden'});
  await page.locator('[data-claim-update]').filter({hasText:'Test checker updated Prepare the agenda'}).waitFor();
  assert.equal(item().verification.result,'pass'); assert.equal(item().decision,null);
  assert.equal(await page.getByText('Test checker marked Prepare the agenda delivered',{exact:true}).count(),0);
  assert.match(await card.innerText(),/Awaiting decision/);
  await page.reload(); await card.waitFor();
  await page.locator('[data-claim-update]').filter({hasText:'Test checker updated Prepare the agenda'}).waitFor();
  assert.deepEqual(errors,[]);
});
