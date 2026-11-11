// Frozen synthetic output of the genuine schema44 producer, not a current
// snapshot with a relabeled watermark. Provenance is beside the fixture.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
let saved;
export function legacy44RestoreSource() {
  if (saved !== undefined) return saved;
  const bytes = readFileSync(new URL('../fixtures/legacy44-restore-source.ndjson', import.meta.url));
  const provenance = JSON.parse(readFileSync(new URL('../fixtures/legacy44-restore-source.provenance.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256);
  assert.equal(bytes.length, provenance.bytes);
  const text = bytes.toString('utf8');
  assert.equal(JSON.parse(text.split('\n')[0]).sourceSchemaVersion, 44);
  return saved = text;
}
