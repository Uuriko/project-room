import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentDisplayName, displayNameSkeleton } from '../server/display-name-guard.mjs';

const check = (name, activeNames = []) => checkAgentDisplayName(name, { activeNames });

test('NFKC folds compatibility glyphs and width, case and repeated whitespace', () => {
  assert.equal(displayNameSkeleton(' Ｉｎｓｔｉｎｃｔ   Bot '), 'instinct bot');
  assert.deepEqual(check('Ｉｎｓｔｉｎｃｔ Bot', ['Instinct Bot']), { safe: false, reason: 'name_collision' });
});

test('mixed-script impersonation is rejected without relying on an existing record', () => {
  for (const name of ['Instіnct', 'AΑgent', 'AСode']) {
    assert.deepEqual(check(name), { safe: false, reason: 'mixed_script' }, name);
  }
});

test('all-Cyrillic and all-Greek common visual clones collide with Latin names', () => {
  assert.deepEqual(check('СОР', [{ displayName: 'COP', identityId: 'ai_existing' }]), { safe: false, reason: 'name_collision' });
  assert.deepEqual(check('ΡΟΡ', ['POP']), { safe: false, reason: 'name_collision' });
});

test('room member display names and global identity records are accepted as inputs', () => {
  const members = [{ memberId: 'member_1', displayName: 'Relay' }, { identity_id: 'ai_2', display_name: 'Muse' }];
  assert.equal(check('Rеlay', members).reason, 'mixed_script');
  assert.equal(check('Ｍｕｓｅ', members).reason, 'name_collision');
});

test('same identity can retry without allowing another record to collide', () => {
  const names = [{ identityId: 'ai_self', displayName: 'Relay' }, { identityId: 'ai_other', displayName: 'Muse' }];
  assert.equal(checkAgentDisplayName('Relay', { activeNames: names, excludeId: 'ai_self' }).safe, true);
  assert.equal(checkAgentDisplayName('Muse', { activeNames: names, excludeId: 'ai_self' }).reason, 'name_collision');
});

test('invisible controls and malformed names fail safely', () => {
  for (const name of ['', ' ', 'A\u200dgent', 'A\u202egent', 'a\n', 'a'.repeat(81), null]) {
    assert.equal(check(name).safe, false, String(name));
  }
});

test('unrelated ordinary names and non-Latin names are not globally blocked', () => {
  assert.equal(check('Relay 2', ['Relay']).safe, true);
  assert.equal(check('東京', ['Relay']).safe, true);
  assert.equal(check('Κόσμος', ['Relay']).safe, true);
});

test('the guard does not mistake two unrelated non-mapped scripts for Latin', () => {
  assert.notEqual(displayNameSkeleton('東京'), displayNameSkeleton('Relay'));
  assert.equal(check('Музей', ['Museum']).safe, true);
});
