import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostedDrill } from '../scripts/hosted-drill.mjs';

test('two-human loopback drill: operator, chat, revoke', async () => {
  const result = await runHostedDrill();
  assert.deepEqual(result, { ok: true, aliceOperator: true, bobRevoked: true });
});
