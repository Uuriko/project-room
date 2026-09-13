import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostedDrill } from '../scripts/hosted-drill.mjs';

test('two-human loopback drill: operator, chat, revoke', async () => {
  const result = await runHostedDrill();
  assert.deepEqual(result, { ok: true, aliceOperator: true, bobRevoked: true });
});

test('hosted drill refuses live Durable Object mode', async () => {
  const prev = process.env.ROOM_DRILL_ALLOW_LIVE;
  process.env.ROOM_DRILL_ALLOW_LIVE = '1';
  try {
    await assert.rejects(runHostedDrill(), /Live drill is not enabled/);
  } finally {
    if (prev === undefined) delete process.env.ROOM_DRILL_ALLOW_LIVE;
    else process.env.ROOM_DRILL_ALLOW_LIVE = prev;
  }
});
