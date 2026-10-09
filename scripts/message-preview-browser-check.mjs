// Authoring gate: real Chromium owns disclosure accessibility and retained DOM
// during streamed updates. Markdown tests cannot detect paragraph reparsing,
// lost selection/focus, duplicate visible text or theme/mobile layout failures.
// Regression control: baseline has no expandable preview. No production hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { boot } from './browser-harness.mjs';
import { signInFixture } from './auth-signin.mjs';

for (const mobile of [false, true]) test(`long message preview ${mobile ? 'mobile' : 'desktop'}: accessible expansion, complete safe text and retained reading state`, { timeout: 45000 }, async t => {
  const f = await boot(t, { streamInterval: 30, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, pageOptions: { isMobile: mobile, hasTouch: mobile }, reducedMotion: null, defaultTimeout: 7000 }), { page, errors, origin } = f;
  const body = 'A patch to review\n```diff\n' + Array.from({ length: 30 }, (_, i) => `+ line ${i}: <script>window.messageInjection = true</script>`).join('\n') + '\n```\nUNIQUE_END_OF_FULL_PATCH';
  f.store.command(f.keys.owner, 'commons', { id: 'long-patch', type: 'message.posted', data: { messageId: 'long-patch', body } });
  await page.goto(origin); await signInFixture(page, f.keys.owner);
  const message = page.locator('[data-message-record-id="long-patch"]');
  await message.waitFor();
  const details = message.locator('.message-expansion'), summary = details.locator(':scope > summary'), full = details.locator('.message-full');
  assert.equal(await details.count(), 1, 'long content has an expandable preview');
  assert.equal(await details.evaluate(el => el.open), false);
  assert.equal(await full.isVisible(), false);
  assert.equal(await summary.locator('.message-show-more').isVisible(), true);
  assert.ok((await summary.boundingBox()).height >= 44);
  await summary.focus(); await page.keyboard.press('Enter');
  assert.equal(await details.evaluate(el => el.open), true);
  assert.equal(await summary.locator('.message-preview').isVisible(), false, 'preview is not duplicated while expanded');
  assert.equal(await summary.locator('.message-show-less').isVisible(), true);
  assert.ok((await full.textContent()).includes('UNIQUE_END_OF_FULL_PATCH'));
  assert.equal(await page.evaluate(() => Boolean(globalThis.messageInjection)), false);
  assert.equal(await full.locator('script').count(), 0);
  await page.evaluate(() => {
    const full = document.querySelector('[data-message-record-id="long-patch"] .message-full');
    globalThis.previewStable = full;
    const range = document.createRange(); range.selectNodeContents(full); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    globalThis.previewSelection = selection.toString();
    document.querySelector('[data-message-record-id="long-patch"] .message-expansion > summary').focus();
  });
  f.store.command(f.keys.producer, 'commons', { id: 'reaction-update', type: 'message.reaction_set', data: { messageId: 'long-patch', reaction: 'like', active: true } });
  await message.locator('.reaction.used').waitFor();
  const retained = await page.evaluate(() => ({
    node: globalThis.previewStable === document.querySelector('[data-message-record-id="long-patch"] .message-full'),
    selection: getSelection().toString() === globalThis.previewSelection,
    focused: document.activeElement?.dataset.focusKey,
    open: document.querySelector('[data-message-record-id="long-patch"] .message-expansion').open
  }));
  assert.deepEqual(retained, { node: true, selection: true, focused: 'message-expand:long-patch', open: true });
  f.store.command(f.keys.owner, 'commons', { id: 'edit-long', type: 'message.edited', data: { messageId: 'long-patch', body: body + '\nA new review note', expectedMessageRevision: 0 } });
  await full.getByText(/A new review note/).waitFor();
  assert.equal(await details.evaluate(el => el.open), true, 'an edit preserves expanded reading state');
  assert.equal(await summary.evaluate(el => el === document.activeElement), true, 'edited disclosure restores keyboard focus');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(mode => { document.documentElement.dataset.theme = mode; }, theme);
    await summary.click(); assert.equal(await details.evaluate(el => el.open), false);
    await message.scrollIntoViewIfNeeded();
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: `test-results/message-preview-${mobile ? 'mobile' : 'desktop'}-${theme}-collapsed.png` });
    await summary.click(); assert.equal(await details.evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await message.scrollIntoViewIfNeeded();
    mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: `test-results/message-preview-${mobile ? 'mobile' : 'desktop'}-${theme}.png` });
  }
  assert.equal(f.store.snapshot(f.keys.owner, 'commons').state.messages.find(m => m.id === 'long-patch').body, body + '\nA new review note', 'stored/copy source is complete');
  await page.locator('#topbar-search-toggle').click();
  await page.locator('#message-search').fill('UNIQUE_END_OF_FULL_PATCH');
  const result = page.locator('#search-list [data-open-message="long-patch"]');
  await result.waitFor({ state: 'visible' });
  assert.ok((await result.getAttribute('href')).includes('long-patch'), 'full-body search retains the original message link');
  assert.deepEqual(errors, []);
});
