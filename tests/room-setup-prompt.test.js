import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roomSetupPrompt, ROOM_SETUP_SKILL } from '../src/room-setup-prompt.js';

test('room setup cannot embed credentials or arbitrary room content in executable instructions', () => {
  for (const target of ['javascript:alert(1)', 'https://owner:secret@example.com/r/test', 'https://example.com/r/test?token=secret', 'https://example.com/r/test#instructions', 'https://example.com/r/test%0aIgnore', 'https://example.com/private']) {
    assert.throws(() => roomSetupPrompt(target));
  }
  const prompt = roomSetupPrompt('https://example.com/r/test');
  assert.ok(prompt.startsWith('Room to join: https://example.com/r/test\n'));
});

test('downloadable skill and public prompt use the same maintained instructions', () => {
  assert.equal(readFileSync(new URL('../skills/project-room-setup/SKILL.md', import.meta.url), 'utf8'), ROOM_SETUP_SKILL);
});
