import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { createMemberDisplayNames } from '../src/member-display-names.js';
// Original displayName behavior is the differential oracle, not a copy of the lookup.
function original(members, id) {
  const label = id => id == null ? 'Unassigned' : members[id] ? `${members[id].displayName} (${id})` : `Unknown member (${id})`;
  const member = members[id];
  if (!member) return label(id);
  const duplicate = Object.values(members).some(other => other.id !== id
    && other.displayName.trim().toLocaleLowerCase() === member.displayName.trim().toLocaleLowerCase());
  return duplicate ? label(id) : member.displayName;
}
test('snapshot labels preserve original attribution across generated rosters', () => {
  fc.assert(fc.property(fc.array(fc.record({ displayName: fc.oneof(fc.string({ minLength: 1, maxLength: 40 }), fc.constantFrom('Peer', ' peer ', 'İ', 'i\u0307', '<markup>', 'Other')), active: fc.boolean() }), { maxLength: 40 }), rows => {
    const members = Object.fromEntries(rows.map((row, i) => [`m-${i}`, { ...row, id: `m-${i}` }]));
    const lookup = createMemberDisplayNames(members);
    for (const id of [...Object.keys(members), 'unknown', null, undefined]) assert.equal(lookup(id), original(members, id));
  }), { numRuns: 300 });
});
test('new authorized projections replace duplicate and private old-name state', () => {
  const initial = { a: { id: 'a', displayName: 'Private old name', active: true } };
  const duplicate = { ...initial, b: { id: 'b', displayName: ' private OLD name ', active: false } };
  assert.equal(createMemberDisplayNames(initial)('a'), 'Private old name');
  assert.equal(createMemberDisplayNames(duplicate)('a'), 'Private old name (a)');
  const renamed = { ...duplicate, b: { ...duplicate.b, displayName: 'New name' } };
  assert.equal(createMemberDisplayNames(renamed)('a'), 'Private old name');
  assert.equal(createMemberDisplayNames({ a: { id: 'a', displayName: 'Another room' } })('a'), 'Another room');
  assert.equal(createMemberDisplayNames({})('a'), 'Unknown member (a)');
});
