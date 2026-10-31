import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('initial deploy convergence exceeds DO grace without broadening evidence-gated retries', () => {
  const workflow = parse(read('.github/workflows/deploy-prod.yml'));
  const smoke = workflow.jobs.deploy.steps.find(step => step.id === 'smoke').run;
  const commands = smoke.split('\n').filter(line => line.includes('node scripts/prod-deploy-smoke.mjs'));
  assert.equal(commands.length, 2);
  const waits = commands.map(line => Number(line.match(/--wait-ms (\d+)/)?.[1]));
  assert.ok(waits[0] >= 420000 && waits[0] <= 450000, '300s grace plus bounded operational margin');
  assert.equal(waits[1], 60000, 'existing second strict smoke remains bounded');
  assert.ok(smoke.indexOf('scripts/prod-smoke-retry.mjs') < smoke.indexOf(commands[1]));
  assert.match(smoke, /if ! node scripts\/prod-smoke-retry\.mjs[\s\S]*?exit 1/);
  assert.equal(Number(read('scripts/prod-deploy-smoke.mjs').match(/opt\("wait-ms", "(\d+)"\)/)?.[1]), waits[0]);
  assert.doesNotMatch(smoke, /durable-objects-code-update-mode|wrangler deploy/);
});
