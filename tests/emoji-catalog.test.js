// Historical aliases remain deterministic after retiring emoji product features.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REACTION_IDENTITIES } from '../src/legacy-reaction-aliases.js';
import { canonicalReaction } from '../src/emoji.js';
test('retained historical aliases resolve to their original reaction identity', () => {
  for (const [glyph, aliases] of REACTION_IDENTITIES) {
    assert.equal(canonicalReaction(glyph), glyph);
    for (const alias of aliases.split(' ')) assert.equal(canonicalReaction(alias), glyph);
  }
});
