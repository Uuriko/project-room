// REV-FIXES-1 (from REV-PRS-1 findings F-4296-1 + F-4296-2): the floor
// derivation escaped its own founding specimen classes. Word-count and
// range criteria never became floors (the EXP-13R glossary criterion is
// "300–600 words"), and length floors were gated on the literal noun
// "artifact", so criteria phrased over the submission / response /
// deliverable — this system's own synonyms for the submitted artifact —
// silently bypassed the gate. Both escapes were reproduced at module
// level by REV-PRS-1 (probes A2/A3/A6/A14 and A4/A5). The widened forms
// below floor exactly the stated minimum and invent none elsewhere: the
// negative corpus (criteria stating no artifact length minimum) must
// keep yielding no length floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { statedArtifactFloors, evaluateArtifactFloors } from '../server/artifact-floors.mjs';

const minimumOf = criterion => statedArtifactFloors(criterion).find(f => f.kind === 'minimum_length');

test('word-count minimums become floors, measured in words', () => {
  assert.deepEqual(minimumOf('The artifact is at least 300 words.'), { kind: 'minimum_length', value: 300, unit: 'words' });
  assert.deepEqual(minimumOf('The artifact runs to no fewer than 250 words.'), { kind: 'minimum_length', value: 250, unit: 'words' });
});

test('range criteria floor at the range lower bound, in the stated unit', () => {
  // The EXP-13R glossary specimen form.
  assert.deepEqual(minimumOf('The artifact is a glossary of 300–600 words.'), { kind: 'minimum_length', value: 300, unit: 'words' });
  assert.deepEqual(minimumOf('The artifact is 300-600 words.'), { kind: 'minimum_length', value: 300, unit: 'words' });
  assert.deepEqual(minimumOf('The artifact is between 200 and 400 characters.'), { kind: 'minimum_length', value: 200, unit: 'characters' });
});

test('a decimal minimum floors at the smallest whole unit that satisfies it', () => {
  assert.deepEqual(minimumOf('The artifact is at least 200.5 characters.'), { kind: 'minimum_length', value: 201, unit: 'characters' });
});

test('length floors no longer require the literal noun "artifact"', () => {
  assert.deepEqual(minimumOf('The submission is at least 400 characters long.'), { kind: 'minimum_length', value: 400, unit: 'characters' });
  assert.deepEqual(minimumOf('The response must contain at least 200 characters.'), { kind: 'minimum_length', value: 200, unit: 'characters' });
  assert.deepEqual(minimumOf('The deliverable is at least 150 words.'), { kind: 'minimum_length', value: 150, unit: 'words' });
});

test('through evaluation: word floors count whitespace-separated tokens', () => {
  const words289 = Array.from({ length: 289 }, (_, i) => `term${i}`).join(' ');
  const result = evaluateArtifactFloors(['The artifact is a glossary of 300–600 words.'], words289, {});
  assert.equal(result.checked, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].detail, /at least 300 words; the artifact has 289/);
  const words300 = Array.from({ length: 300 }, (_, i) => `term${i}`).join(' ');
  assert.equal(evaluateArtifactFloors(['The artifact is a glossary of 300–600 words.'], words300, {}).failures.length, 0);
});

test('verbatim founding criterion: a bare length statement floors (REV-FIXES-1-AMEND)', () => {
  // The EXP-13R founding criterion's verbatim text (receipt
  // pwr_7580d250f35a, pw-garden-glossary-20261005-r2, criterion 2) names
  // no subject noun at all — the length IS the subject — so the subject
  // gate never opened for it even after the REV-FIXES-1 widening.
  assert.deepEqual(minimumOf('Total length 300-600 words'), { kind: 'minimum_length', value: 300, unit: 'words' });
  assert.deepEqual(minimumOf('Total length 300–600 words.'), { kind: 'minimum_length', value: 300, unit: 'words' });
  // A length statement about something else is still not bare: other
  // words remain once the cue, numbers, and unit are stripped.
  assert.equal(minimumOf("The summary's length is 200–400 characters."), undefined);
});

test('through evaluation under the verbatim phrasing', () => {
  const criterion = 'Total length 300-600 words';
  const words289 = Array.from({ length: 289 }, (_, i) => `term${i}`).join(' ');
  const result = evaluateArtifactFloors([criterion], words289, {});
  assert.equal(result.checked, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].detail, /at least 300 words; the artifact has 289/);
  const words300 = Array.from({ length: 300 }, (_, i) => `term${i}`).join(' ');
  assert.equal(evaluateArtifactFloors([criterion], words300, {}).failures.length, 0);
});

test('negative corpus: criteria stating no artifact length minimum invent no floor', () => {
  // A minimum stated about something else is still not an artifact floor.
  assert.equal(minimumOf('The summary is at least 200 characters.'), undefined);
  assert.equal(minimumOf('The summary is 200–400 characters.'), undefined);
  // Judgement language and bare counts state no minimum.
  assert.equal(minimumOf('The artifact is a structured census of dispute outcomes.'), undefined);
  assert.equal(minimumOf('The artifact has 5 sections of 100 words each.'), undefined);
  assert.equal(minimumOf('The artifact lists at least 200 entries.'), undefined);
  assert.equal(minimumOf('Correct result'), undefined);
  // Non-length floors are untouched by the widening.
  assert.deepEqual(statedArtifactFloors('The submission cites the file server/bounty-escrow.mjs.'),
    [{ kind: 'file_citation', path: 'server/bounty-escrow.mjs' }]);
});
