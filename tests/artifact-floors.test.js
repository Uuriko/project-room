// REV-PRS-1 review fix: statedArtifactFloors must take the STRONGEST
// minimum a criterion states. Before this fix each MINIMUM_FORMS regex
// contributed only its first match, so a criterion stating a smaller
// minimum before a larger one ("at least 200 characters ... at least
// 400 characters") floored at the smaller value and a verify PASS could
// be recorded against an artifact the criterion itself forbids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statedArtifactFloors, evaluateArtifactFloors } from '../server/artifact-floors.mjs';

const minimumOf = criterion => statedArtifactFloors(criterion).find(f => f.kind === 'minimum_length');

test('repeated same-form minima: the strongest stated minimum wins', () => {
  assert.equal(minimumOf('The artifact is at least 200 characters and at least 400 characters').value, 400);
  assert.equal(minimumOf('The artifact is at least 400 characters and at least 200 characters').value, 400);
  assert.equal(minimumOf('The artifact is at least 100 characters, at least 900 characters, at least 300 characters').value, 900);
});

test('a single stated minimum is unchanged', () => {
  assert.equal(minimumOf('The artifact is at least 200 characters').value, 200);
  assert.equal(minimumOf('The artifact is at least 1,000 characters').value, 1000);
});

test('cross-form minima still compose to the strongest', () => {
  assert.equal(minimumOf('The artifact is at least 200 characters; a minimum of 400 characters is required').value, 400);
});

test('through evaluation: an artifact between the two stated minima fails the floor', () => {
  const criteria = ['The artifact is at least 200 characters and at least 400 characters'];
  const result = evaluateArtifactFloors(criteria, 'x'.repeat(300), {});
  assert.equal(result.checked, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].detail, /at least 400 characters/);
});
