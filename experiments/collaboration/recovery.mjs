import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createExperimentServer } from './server.mjs';
import { variants } from './scenarios.mjs';

const output = resolve(process.argv[2] ?? 'test-results/collaboration-recovery');
await mkdir(output, { recursive: true });
const server = createExperimentServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const report = { scope: 'Research UI recovery, not production qualification', cases: [], failures: [] };
try {
  for (const variant of variants) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/?variant=${variant}&scenario=writing&task=review`);
    await page.locator('#start:not([disabled])').waitFor();
    await page.locator('[name=basedOn]').selectOption('launch-2');
    const text = 'Atlas launches November 21. Contact Mina.';
    await page.locator('[name=body]').fill(text);
    await page.route('**/api/score', route => route.abort(), { times: 1 });
    await page.getByRole('button', { name: 'Submit answer' }).click();
    await page.locator('#status').filter({ hasText: /fetch/i }).waitFor();
    assert.equal(await page.locator('[name=body]').inputValue(), text);
    assert.equal(await page.locator('[name=basedOn]').inputValue(), 'launch-2');
    await page.getByRole('button', { name: 'Submit answer' }).click();
    await page.locator('#status').filter({ hasText: 'content review is still required' }).waitFor();
    report.cases.push({ variant, width, case: 'failed-score-preserves-answer-and-retries', passed: true });
    let release, arrived;
    const held = new Promise(r => { release = r; });
    const intercepted = new Promise(r => { arrived = r; });
    await page.route('**/api/score', async route => {
      const response = await route.fetch(); arrived(); await held; await route.fulfill({ response });
    }, { times: 1 });
    await page.getByRole('button', { name: 'Submit answer' }).click(); await intercepted;
    await page.locator('#scenario').selectOption('coding');
    await page.locator('#title').filter({ hasText: 'Retry policy' }).waitFor();
    await page.locator('#start:not([disabled])').waitFor();
    const response = page.waitForResponse(r => r.url().endsWith('/api/score'));
    release(); await response;
    await page.getByRole('button', { name: 'Submit answer' }).waitFor({ state: 'visible' });
    // Wait for the response handler through its observable button lifecycle.
    await page.waitForFunction(() => !document.querySelector('#answer button').disabled);
    assert.equal(await page.locator('#status').textContent(), '');
    assert.equal(await page.locator('[name=body]').inputValue(), '');
    assert.equal(await page.locator('[name=basedOn]').inputValue(), '');
    assert.deepEqual(errors, []);
    report.cases.push({ variant, width, case: 'late-score-cannot-contaminate-new-trial', passed: true });
    await page.close();
  }
} catch (error) { report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1; }
finally {
  await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  await writeFile(`${output}/recovery.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
