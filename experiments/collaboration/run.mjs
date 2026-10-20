// Deterministic harness qualification, NOT simulated evidence of human preference.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createExperimentServer } from './server.mjs';
import { scenarios, variants } from './scenarios.mjs';
import { score } from './oracle.mjs';

const output = resolve(process.argv[2] ?? 'test-results/collaboration-experiments');
await mkdir(output, { recursive: true });
const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
  capturedAt: new Date().toISOString(), scope: 'Deterministic synthetic harness qualification',
  limitations: ['No human participants or live model calls.', 'Script knows fixture facts; navigation counts cannot rank usability.', 'Context comparison contains an intentionally incomplete control; results do not estimate real summarizer reliability.', 'Elapsed time excludes human thinking and includes test automation.'],
  browser: [], handoffs: [], negativeControls: [], failures: [] };
report.sourceFiles = Object.fromEntries(await Promise.all(['scenarios.mjs', 'oracle.mjs', 'server.mjs', 'ui.js', 'style.css', 'index.html', 'run.mjs'].map(async name => [name, createHash('sha256').update(await readFile(new URL(name, import.meta.url))).digest('hex')])));
const server = createExperimentServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  // The HTTP boundary must not expose evaluator files or accept foreign writes.
  assert.equal((await fetch(`${origin}/oracle.mjs`)).status, 404);
  assert.equal((await fetch(`${origin}/api/score`, { method: 'POST', headers: { Origin: 'https://example.invalid' }, body: '{}' })).status, 403);
  for (const s of scenarios) {
    const correction = s.messages.at(-1)[1].replace(/^Correction: /, '');
    for (const [label, task, answer] of [
      ['stale-version', 'review', { basedOn: s.versions[0].id, body: correction }],
      ['uncorrected-result', 'review', { basedOn: s.versions[1].id, body: s.versions[1].body }],
      ['wrong-owner', 'resume', { current: s.versions[1].id, accepted: s.versions[0].id, owner: 'Someone else', blocker: s.blocker }]
    ]) {
      const result = score(s.id, task, answer);
      assert.equal(result.passed, false, `${s.id}/${label} must fail`);
      report.negativeControls.push({ scenario: s.id, label, rejected: true });
    }
    for (const mode of ['full', 'compact', 'retrievable']) {
      const packet = await fetch(`${origin}/api/scenario/${s.id}/context?mode=${mode}`).then(r => r.json());
      let messages = packet.messages ?? [], retrievalBytes = 0, retrievals = 0;
      if (packet.read) {
        const text = await fetch(origin + packet.read).then(r => r.text()); retrievals++; retrievalBytes = Buffer.byteLength(text); messages = JSON.parse(text).messages;
      }
      // A transparent scripted stand-in copies the latest explicit correction.
      // No model and no oracle access in this transformation.
      const correction = messages.filter(([, body]) => body.startsWith('Correction:')).at(-1)?.[1];
      const answer = { basedOn: packet.currentVersion, body: correction?.replace(/^Correction: /, '') ?? packet.result };
      const result = score(s.id, 'handoff', answer);
      assert.equal(result.passed, mode !== 'compact');
      report.handoffs.push({ scenario: s.id, mode, packetBytes: Buffer.byteLength(JSON.stringify(packet)), retrievalBytes, retrievals, result, model: null, tokens: null, cost: null });
    }
  }
  browser = await chromium.launch({ headless: true });
  for (const s of scenarios) for (const variant of variants) for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    for (const task of ['resume', 'review']) {
      const started = performance.now(); let requests = 0;
      const count = () => { requests++; }; page.on('request', count);
      await page.goto(`${origin}/?${new URLSearchParams({ variant, scenario: s.id, task })}`);
      await page.locator('#title').filter({ hasText: s.title }).waitFor();
      await page.locator('#start:not([disabled])').waitFor();
      if (task === 'resume') {
        await page.locator('[name=current]').selectOption(s.versions[1].id);
        await page.locator('[name=accepted]').selectOption(s.versions[0].id);
        await page.locator('[name=owner]').fill(s.owner);
        await page.locator('[name=blocker]').fill(s.blocker);
      } else {
        if (variant === 'conversation') await page.getByRole('button', { name: `View ${s.versions[1].id}`, exact: true }).click();
        await page.locator('[name=body]').fill(s.messages.at(-1)[1].replace(/^Correction: /, ''));
        // A plausible correct text on the wrong version must fail at HTTP boundary.
        await page.locator('[name=basedOn]').selectOption(s.versions[0].id);
        await page.getByRole('button', { name: 'Submit answer' }).click();
        await page.getByRole('status').filter({ hasText: 'not met' }).waitFor();
        await page.locator('[name=basedOn]').selectOption(s.versions[1].id);
        // Viewing another revision must not overwrite the correction draft.
        const before = await page.locator('[name=body]').inputValue();
        await page.locator('#version').selectOption(s.versions[0].id);
        assert.equal(await page.locator('[name=body]').inputValue(), before);
        await page.locator('#version').selectOption(s.versions[1].id);
      }
      await page.getByRole('button', { name: 'Submit answer' }).click();
      await page.getByRole('status').filter({ hasText: 'requirements met.' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal page overflow');
      assert.deepEqual(errors, []);
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export trial' }).click();
      const download = await downloadPromise;
      const filename = `${s.id}-${variant}-${width}-${task}`;
      await download.saveAs(`${output}/${filename}.json`);
      if (s.id === 'writing' && task === 'review') {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: `${output}/${filename}.png`, fullPage: true });
      }
      report.browser.push({ scenario: s.id, variant, width, task, passed: true, requests, elapsedMs: Math.round(performance.now() - started), record: `${filename}.json` });
      page.off('request', count);
    }
    await context.tracing.stop({ path: `${output}/${s.id}-${variant}-${width}.zip` });
    await context.close();
  }
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack }); process.exitCode = 1;
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, browserTrials: report.browser.length, handoffs: report.handoffs.length, negativeControls: report.negativeControls.length, failures: report.failures }, null, 2));
}
