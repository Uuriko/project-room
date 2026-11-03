// Synthetic local offers exercise the server's claimability contract in the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { chromium } from 'playwright';
import { createAcceptanceFixture } from './acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

async function fixture(t, state) {
  const f = createAcceptanceFixture();
  const resources = { server: null, browser: null };
  t.after(async () => {
    await resources.browser?.close();
    if (resources.server) {
      resources.server.closeStreams();
      resources.server.closeAllConnections();
      await new Promise(resolve => resources.server.close(resolve));
    }
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });

  const id = `availability-${state}`;
  f.store.projectOffers.create('commons', 'owner', {
    requestId: `create-${id}`, offerId: id, reviewerMemberIds: ['owner'],
    terms: {
      kind: 'task', title: `Example ${state} task`, summary: 'Synthetic local fixture',
      acceptanceCriteria: ['Deliver the declared change'],
      repositoryUrl: 'https://github.com/Example/Project',
      ...(state === 'expired' ? { deadline: '2020-01-01T00:00:00.000Z' } : {}),
      reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' }
    }
  });
  f.store.projectOffers.transition('commons', 'owner', id, 'publish', {
    requestId: `publish-${id}`, expectedRevision: 1
  });
  f.store.publicWorkClaims.enable('commons', 'owner', id, {
    requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1,
    repositoryRef: 'main', files: ['src/example.js']
  });
  if (state === 'claimed' || state === 'submitted') {
    const worker = f.store.identities.create('Synthetic claim worker');
    const claim = f.store.publicWorkClaims.act(id, worker.secret, 'claim', {
      requestId: `claim-${id}`, expectedTermsVersion: 1
    });
    if (state === 'submitted') f.store.publicWorkClaims.act(id, worker.secret, 'finish', {
      requestId: `finish-${id}`, expectedTermsVersion: 1,
      generation: claim.task.claim.generation, artifactText: 'Synthetic result', checksReported: []
    });
  }

  const server = resources.server = createRoomServer({ store: f.store, assetRoot: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = resources.browser = await chromium.launch({
    headless: true,
    ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {})
  });
  return { id, browser, origin: `http://127.0.0.1:${server.address().port}` };
}

for (const width of [390, 1280]) {
  for (const [state, claimState, claimable, label] of [
    ['expired', 'unclaimed', false, 'Not currently claimable'],
    ['available', 'unclaimed', true, 'Open to contributors'],
    ['claimed', 'claimed', false, 'Claimed'],
    ['submitted', 'submitted', false, 'Submitted · not currently claimable']
  ]) {
    test(`${width}px ${state} offer renders server claimability`, { timeout: 30000 }, async t => {
      const { id, browser, origin } = await fixture(t, state);
      const response = await fetch(`${origin}/api/public-work/tasks/${id}`);
      assert.equal(response.status, 200);
      const task = await response.json();
      assert.equal(task.claim.state, claimState);
      assert.equal(task.claimable, claimable);

      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(state === 'available' ? `${origin}/offers` : `${origin}/offers?offer=${id}`);
      if (state === 'available') {
        const card = page.locator(`[data-offer="${id}"]`);
        await card.waitFor({ state: 'visible' });
        await card.focus();
        await page.keyboard.press('Enter');
      }
      const status = page.locator('#contribution-status p[role="status"]');
      await status.waitFor({ state: 'visible' });
      assert.equal(await status.innerText(), label);
      if (state === 'available') {
        assert.doesNotMatch(await page.locator(`[data-offer="${id}"]`).innerText(), /Synthetic local fixture/);
        assert.equal(await page.locator('#offer-detail .summary').innerText(), 'Synthetic local fixture');
      }
      if (state === 'submitted') assert.equal(await page.locator('.agent-handoff h3').innerText(), 'Agent brief');
      assert.deepEqual(errors, []);
    });
  }
}
