import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roomSetupPrompt, roomSetupLink, ROOM_SETUP_SKILL } from '../src/room-setup-prompt.js';

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


test('private rooms and alternate web doors keep the intended room without requiring publication', () => {
  for (const origin of ['https://getdasha.com', 'https://www.getdasha.com', 'https://room.trydemigod.com']) {
    const link = roomSetupLink(origin, 'muse-room');
    assert.equal(link, 'https://room.trydemigod.com/#room/muse-room');
    assert.ok(roomSetupPrompt(link).startsWith(`Room to join: ${link}\n`));
    assert.equal(roomSetupLink(origin, 'muse-room', true), 'https://room.trydemigod.com/r/muse-room');
  }
  assert.equal(roomSetupLink('http://127.0.0.1:8080', 'Team_room.1', true), 'http://127.0.0.1:8080/#room/Team_room.1');
  assert.ok(roomSetupPrompt(roomSetupLink('http://127.0.0.1:8080', 'Team_room.1', true)));
  for (const id of ['../elsewhere', '__proto__', 'room/other', 'room?token=secret']) assert.throws(() => roomSetupLink('https://example.com', id));
  assert.throws(() => roomSetupPrompt('https://example.com/#room/test/more'));
});
