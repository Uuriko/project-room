import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentDisplayName, displayNameSkeleton } from '../server/display-name-guard.mjs';
import { isReservedRoleName, assertNotReservedRoleName } from '../server/display-name-guard.mjs';

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

test('integration: identity mint and room link enforce names at the write boundary', async t => {
  const { createAcceptanceFixture } = await import('../scripts/acceptance-fixture.mjs');
  const fixture = createAcceptanceFixture();
  t.after(() => fixture.store.close());
  const store = fixture.store;
  const rows = () => store.db.prepare('SELECT count(*) AS n FROM agent_identities').get().n;
  const before = rows();
  for (const name of ['Instіnct', 'A\u200dgent', 'A\u202egent']) {
    assert.throws(() => store.identities.create(name), { status: 422, code: 'invalid_identity' });
  }
  assert.equal(rows(), before, 'unsafe mints write no identity');
  const ownerKey = store.issueAccessKey('commons', 'owner');
  const latin = store.identities.create('COP');
  assert.throws(() => store.identities.create('СОР'), { status: 422, code: 'invalid_identity' },
    'all-Cyrillic visual clone cannot be minted against an active global name');
  assert.equal(store.identities.create('COP').displayName, latin.displayName,
    'ordinary exact-name duplicates remain supported');
  assert.throws(() => store.identities.create('ＣＯＰ'), { status: 422, code: 'invalid_identity' },
    'fullwidth visual clone cannot bypass mint collision detection');
  const relay = store.identities.create('Relay');
  store.identities.link(ownerKey, 'commons', { identityId: relay.identityId, permissions: [] });
  const second = store.identities.create('Other');
  const count = () => store.db.prepare('SELECT count(*) AS n FROM identity_links WHERE room_id=?').get('commons').n;
  const linkedBefore = count();
  for (const name of ['Ｒｅｌａｙ', 'Rеlay', 'B\u200dot']) {
    assert.throws(() => store.identities.link(ownerKey, 'commons', {
      identityId: second.identityId, displayName: name, permissions: []
    }), { status: 422, code: 'invalid_identity' });
  }
  assert.equal(count(), linkedBefore, 'failed links do not leave a membership');
  const duplicate = store.identities.create('Another');
  assert.throws(() => store.identities.link(ownerKey, 'commons', {
    identityId: duplicate.identityId, displayName: 'Relay', permissions: []
  }), error => error.status === 422 && error.code === 'display_name_unavailable',
  'a live room link refuses an exact display-name duplicate');
  assert.equal(count(), linkedBefore, 'a refused duplicate link writes no membership');
  const linked = store.identities.link(ownerKey, 'commons', {
    identityId: second.identityId, displayName: 'Helpful Agent', permissions: []
  });
  assert.equal(linked.identityId, second.identityId);
  assert.equal(store.room('commons').state.members[linked.memberId].displayName, 'Helpful Agent');
});


test('QA2-SECREG: Latin-script homoglyphs of reserved role words are refused', () => {
  // Small capitals, dotless/turned i, and schwa are Latin script and NFKC-stable,
  // so they pass the mixed-script check; the skeleton must fold them or names
  // like "admın" read as "admin" on every path. Fails pre-fix (mint-safe).
  const impostors = [
    'admın',        // U+0131 dotless i
    'ᴀdmin',        // U+1D00 small capital A
    'ᴏwner',        // U+1D0F small capital O
    'sᴜpport',      // U+1D1C small capital U
    'secᴜrɪty',     // U+1D1C + U+026A small capital I
    'ꜱystem',       // U+A731 small capital S
    'ɐdmin',        // U+0250 turned a
    'səcurity',     // U+0259 schwa
  ];
  for (const name of impostors) {
    assert.equal(isReservedRoleName(name), true, name + ' must read as reserved');
    // The mint path refuses reserved names via assertNotReservedRoleName (the
    // mixed-script rule in checkAgentDisplayName only counts Latin/Greek/Cyrillic).
    assert.throws(() => assertNotReservedRoleName(name),
      error => error.code === 'display_name_unavailable' && error.reason === 'reserved',
      name + ' must not mint');
  }
  // The skeleton folds the whole small-capital series.
  assert.equal(displayNameSkeleton('ᴀʙᴄ'), 'abc');
  assert.equal(displayNameSkeleton('ıɪᴉ'), 'iii');
});
