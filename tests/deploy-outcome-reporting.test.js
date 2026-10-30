import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
const workflows = Object.fromEntries(['deploy-prod', 'rollback-prod'].map(name => [name,
  parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'))]));
const deploy = workflows['deploy-prod'].jobs.deploy.steps;
const rollback = workflows['rollback-prod'].jobs.rollback.steps;
const runtime = workflows['deploy-prod'].jobs['release-runtime'].steps;
const receipt = steps => steps.find(step => step.name === 'Receipt to muse-room');
function execute(t, step, values = {}, recovery) {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (recovery) writeFileSync(join(dir, 'deploy-recovery.json'), JSON.stringify(recovery));
  const summary = join(dir, 'summary'); writeFileSync(summary, '');
  // Execute the actual workflow body, replacing only transport to capture its
  // posted command. No production credentials, origin, or network are used.
  const run = step.run.replace("node --input-type=module -e '\n", "node --input-type=module -e '\nglobalThis.fetch = async (_url, options) => { console.log(JSON.stringify({ captured: JSON.parse(options.body) })); return {ok:true,status:200}; };\n");
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', run], { cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, ROOM_RECEIPT_TOKEN: 'fixture', RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary,
      SHA: 'a'.repeat(40), PROD_ORIGIN: 'https://example.invalid', RECEIPT_ROOM: 'fixture', REASON: '', ...values } });
  assert.equal(result.status, 0, result.stderr);
  const captured = result.stdout.split('\n').find(line => line.startsWith('{"captured":'));
  return { body: captured ? JSON.parse(captured).captured.data.body : null, summary: readFileSync(summary, 'utf8') };
}
test('literal deploy receipt preserves upload/strict/live outcomes independently of job status', t => {
  const step = receipt(deploy);
  assert.equal(step.env.STRICT_OUTCOME, '${{ steps.smoke.outcome }}');
  assert.equal(step.env.LIVE_OUTCOME, '${{ steps.live.outcome }}');
  assert.equal(step.env.PROD_OUTCOME, '${{ steps.prod.outcome }}');
  assert.equal(step.env.ENTRY_OUTCOME, '${{ steps.entry.outcome }}');
  for (const [prod, entry, strict, live] of [
    ['success', 'success', 'failure', 'skipped'],
    ['success', 'success', 'success', 'failure'],
    ['failure', 'skipped', 'skipped', 'skipped'],
    ['success', 'cancelled', 'skipped', 'skipped'],
    ['success', 'success', 'success', 'success'],
    ['', '', '', ''],
  ]) {
    const { body } = execute(t, step, { OUTCOME: 'success', PROD_OUTCOME: prod, ENTRY_OUTCOME: entry, STRICT_OUTCOME: strict, LIVE_OUTCOME: live });
    for (const [name, value] of [['prod upload step', prod], ['entry upload step', entry], ['strict smoke', strict], ['live smoke', live]])
      assert.ok(body.includes(`${name} ${value || 'unknown'}`), body);
    assert.match(body, /runtime publication not yet observed/);
    assert.doesNotMatch(body, /runtime publication success|smoke ok/);
  }
});
test('rollback receipt cannot report smoke success merely because upload/rollback succeeded', t => {
  const step = receipt(rollback);
  assert.equal(step.env.STRICT_OUTCOME, '${{ steps.smoke.outcome }}');
  const { body, summary } = execute(t, step, { ROLLBACK_OUTCOME: 'success', STRICT_OUTCOME: 'failure', READBACK_OUTCOME: 'skipped', OUTCOME: 'success' });
  assert.match(body, /rollback execution success.*strict smoke failure/);
  assert.match(summary, /strict smoke: failure/);
  assert.match(body, /runtime publication not run/);
});
test('runtime outcome comes from its actual package and publish steps, including skipped publication', t => {
  const step = runtime.find(step => step.name === 'Runtime publication outcome');
  assert.equal(step.if, 'always()');
  assert.equal(step.env.PUBLISH_OUTCOME, '${{ steps.publish.outcome }}');
  assert.ok(runtime.find(step => step.id === 'publish').run.includes('verify_release'));
  for (const [pack, publish] of [['failure', 'skipped'], ['success', 'failure'], ['success', 'success']]) {
    const { body, summary } = execute(t, step, { PACKAGE_OUTCOME: pack, PUBLISH_OUTCOME: publish });
    assert.ok(body.includes(`packaging ${pack}`));
    assert.ok(body.includes(`promotion) ${publish}`));
    assert.ok(summary.includes(`promotion): ${publish}`));
  }
});
test('all three receipt paths visibly warn in summary when token absent and send nothing', t => {
  for (const step of [receipt(deploy), receipt(rollback), runtime.find(step => step.name === 'Runtime publication outcome')]) {
    const { body, summary } = execute(t, step, { ROOM_RECEIPT_TOKEN: '' });
    assert.equal(body, null);
    assert.match(summary, /WARNING: ROOM_RECEIPT_TOKEN not set; no Room receipt posted/);
  }
});

test('recovery report does not erase upload or verification outcomes', t => {
  const { body } = execute(t, receipt(deploy), { PROD_OUTCOME: 'success', ENTRY_OUTCOME: 'success', STRICT_OUTCOME: 'failure', LIVE_OUTCOME: 'skipped' },
    { status: 'held', workers: { prod: { disposition: 'forward-repair-required', reason: 'writer fence changed' } } });
  assert.match(body, /prod upload step success.*strict smoke failure.*live smoke skipped/);
  assert.match(body, /forward-repair-required/);
  assert.doesNotMatch(body, /rolled back/);
});
test('deployment summary uses phase outcomes and does not equate absent version output with no upload', t => {
  const step = deploy.find(step => step.name === 'Summary');
  assert.equal(step.env.LIVE_OUTCOME, '${{ steps.live.outcome }}');
  const { summary } = execute(t, step, { PROD_OUTCOME: 'failure', ENTRY_OUTCOME: 'skipped', STRICT_OUTCOME: 'skipped', LIVE_OUTCOME: 'skipped' });
  assert.match(summary, /version not captured/);
  assert.match(summary, /Strict smoke: skipped; live smoke: skipped/);
  assert.doesNotMatch(summary, /not deployed/);
});
