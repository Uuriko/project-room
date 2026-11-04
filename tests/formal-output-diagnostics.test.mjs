import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFormalOutput} from '../room-acp/src/formal-delivery.mjs';

test('formal diagnostics classify failure without retaining output or arbitrary stop text', () => {
  const privateText = 'PRIVATE_OUTPUT_DO_NOT_ECHO';
  const cases = [
    [JSON.stringify({outcome:'answered',body:privateText}), 'end_turn', 'valid'],
    [JSON.stringify({outcome:'pending',body:privateText}), 'end_turn', 'valid'],
    [JSON.stringify({outcome:'answered',body:privateText.repeat(200)}), 'end_turn', 'body_too_long'],
    [JSON.stringify({outcome:'unknown',body:privateText}), 'end_turn', 'invalid_shape'],
    [privateText, 'end_turn', 'invalid_json'],
    [privateText, 'max_tokens', 'interrupted'],
    [privateText, privateText, 'interrupted'],
  ];
  for (const [output, stop, reason] of cases) {
    const value = classifyFormalOutput(output, stop);
    assert.deepEqual(value, {reason, stopReason:stop === privateText ? 'other' : stop, outputChars:output.length});
    assert.ok(!JSON.stringify(value).includes(privateText));
  }
});
