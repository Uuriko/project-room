import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobs, execute } from '../scripts/local-test-campaign.mjs';
test('two lanes generate disjoint seeds including suite offsets', () => {
  const a = new Set(jobs(0, 2, 100).flatMap(j => Array.from({ length: 5 }, (_, i) => j.seed + i)));
  for (const j of jobs(1, 2, 100)) for (let i = 0; i < 5; i++) assert.equal(a.has(j.seed + i), false);
  assert.deepEqual(jobs(0, 2, 2), jobs(0, 2, 2));
  for (const invalid of [[2,2,1], [0,0,1], [0,2,0], [0,2,10001]]) assert.throws(() => jobs(...invalid));
});
const options = { cwd: process.cwd(), env: process.env, timeoutMs: 2000 };
test('preserves subprocess assertion failure and evidence', async () => {
  const r = await execute(['-e', 'console.error("counterexample"); process.exit(7)'], options);
  assert.equal(r.code, 7); assert.match(r.log, /counterexample/);
});
test('terminates timed out work', async () => {
  const r = await execute(['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 100 });
  assert.equal(r.reason, 'timeout'); assert.notEqual(r.code, 0);
});
test('stops excessive output', async () => {
  const r = await execute(['-e', 'setInterval(()=>console.log("x".repeat(4096)),1)'], { ...options, logLimit: 100 });
  assert.equal(r.reason, 'output-limit'); assert.ok(r.log.length <= 100);
});
