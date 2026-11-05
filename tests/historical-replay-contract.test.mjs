import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../server/historical-replay-contract.mjs');
const raw = rows => rows.map(row => ({ ...row, id: typeof row.id === 'string' ? Buffer.from(row.id) : row.id, body: typeof row.body === 'string' ? Buffer.from(row.body) : row.body }));
const rows = [{ sequence: 1, id: 'a', body: 'bc' }];
test('historical prefix is versioned and bound to room, exact bytes and row framing', async () => {
  const codec = await load();
  assert.equal(codec.HISTORICAL_REPLAY_CONTRACT_VERSION, 1);
  assert.equal(codec.HISTORICAL_REPLAY_KIND, 'pre749-sessions');
  assert.equal(codec.PRE749_ADAPTER_VERSION, 1);
  const hash = codec.pre749PrefixDigest('room', raw(rows));
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(codec.pre749PrefixDigest('other', raw(rows)), hash);
  assert.notEqual(codec.pre749PrefixDigest('room', raw([{ sequence: 1, id: 'ab', body: 'c' }])), hash, 'length frames prevent concatenation ambiguity');
  assert.notEqual(codec.pre749PrefixDigest('room', raw([{ ...rows[0], body: 'bc ' }])), hash, 'raw source bytes are evidence');
  assert.notEqual(codec.pre749PrefixDigest('room', raw([...rows, { sequence: 2, id: 'next', body: 'source' }])), hash);
  assert.equal(codec.pre749PrefixDigest('room', raw(rows)), hash);
});
for (const malformed of [[], [{ sequence: 0, id: 'a', body: 'bc' }], [{ sequence: 2, id: 'a', body: 'bc' }],
  [...rows, { sequence: 1, id: 'a', body: 'bc' }], [{ sequence: Number.MAX_SAFE_INTEGER + 1, id: 'a', body: 'bc' }],
  [{ sequence: 1, id: null, body: 'bc' }], [{ sequence: 1, id: 'a', body: {} }]])
  test('malformed prefix cannot mint a digest: ' + JSON.stringify(malformed), async () => {
    const { pre749PrefixDigest } = await load();
    assert.throws(() => pre749PrefixDigest('room', raw(malformed)), TypeError);
  });
