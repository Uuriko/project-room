import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {initialReplayHash, advanceReplayHash, finishReplayHash,
  encodeReplayHash, decodeReplayHash, REPLAY_HASH_INPUT_LIMIT} from '../server/replay-sha256.mjs';
const native = bytes => createHash('sha256').update(bytes).digest('hex');
function stream(bytes, size) {
  let state = initialReplayHash();
  for (let offset = 0; offset < bytes.length; offset += size) {
    state = advanceReplayHash(decodeReplayHash(encodeReplayHash(state)), bytes.subarray(offset, offset + size));
    assert.ok(encodeReplayHash(state).length <= 1024);
  }
  return finishReplayHash(state);
}
for (const [text, expected] of [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['a'.repeat(1000000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0']
]) test(`standard SHA-256 vector of ${text.length} bytes`, () => {
  assert.equal(stream(Buffer.from(text), 4093), expected);
});

for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 4097]) {
  test(`all padding and block boundaries at ${length} bytes`, () => {
    const bytes = randomBytes(length);
    for (const size of [1, 7, 63, 64, 65, 257]) assert.equal(stream(bytes, size), native(bytes));
  });
}

test('UTF-8 codepoints split at every byte and invalid UTF-8 remain exact bytes', () => {
  const bytes = Buffer.concat([Buffer.from('🦉é中\u0000\n\r\t"\\'.repeat(97)), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x80])]);
  for (const size of [1, 2, 3, 4, 5, 63, 64]) assert.equal(stream(bytes, size), native(bytes));
});

test('admission rejects oversized input and malformed controls before parsing or iteration', () => {
  assert.throws(() => advanceReplayHash(initialReplayHash(), new Uint8Array(REPLAY_HASH_INPUT_LIMIT + 1)), /input limit/);
  assert.throws(() => advanceReplayHash(initialReplayHash(), 'abc'), /input limit/);
  assert.throws(() => decodeReplayHash('x'.repeat(2 * 1024 * 1024)), /control limit/);
  assert.throws(() => decodeReplayHash('中'.repeat(500)), /control limit/);
  for (const changed of [
    {version: 2}, {bytes: -1}, {bytes: 8388609}, {bytes: '1'}, {pending: [1]},
    {words: [0]}, {words: Array(8)}, {words: [...Array(7).fill(0), -1]},
    {words: [...Array(7).fill(0), 0x100000000]}, {extra: true}
  ]) assert.throws(() => encodeReplayHash({...initialReplayHash(), ...changed}), /invalid/);
});

test('structurally valid state tamper cannot qualify against independent expected bytes', () => {
  const bytes = Buffer.from('Independently captured expected content.');
  const state = advanceReplayHash(initialReplayHash(), bytes);
  state.words[0] ^= 1;
  assert.notEqual(finishReplayHash(decodeReplayHash(encodeReplayHash(state))), native(bytes));
  // A hash state alone has no independent row authenticity. The lifecycle
  // must validate its separately protected checkpoint before resuming it.
});

test('fresh Node processes resume serialized partial blocks without retained prefix', () => {
  const bytes = Buffer.from('A🦉B'.repeat(1000));
  const moduleUrl = new URL('../server/replay-sha256.mjs', import.meta.url).href;
  for (const offset of [1, 63, 64, 65, 1023]) {
    const state = encodeReplayHash(advanceReplayHash(initialReplayHash(), bytes.subarray(0, offset)));
    const script = `import {decodeReplayHash,advanceReplayHash,finishReplayHash} from ${JSON.stringify(moduleUrl)};
      let input='';for await(const part of process.stdin)input+=part;
      const request=JSON.parse(input);console.log(finishReplayHash(advanceReplayHash(decodeReplayHash(request.state),Buffer.from(request.tail,'base64'))));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      input: JSON.stringify({state, tail: bytes.subarray(offset).toString('base64')}), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), native(bytes));
  }
});

test('8 MiB input retains only eight words and at most 63 bytes; each update is admitted', () => {
  const bytes = randomBytes(8 * 1024 * 1024);
  let state = initialReplayHash();
  for (let offset = 0; offset < bytes.length; offset += REPLAY_HASH_INPUT_LIMIT) {
    state = advanceReplayHash(state, bytes.subarray(offset, offset + REPLAY_HASH_INPUT_LIMIT));
    assert.equal(state.words.length, 8); assert.ok(state.pending.length <= 63);
    state = decodeReplayHash(encodeReplayHash(state));
  }
  assert.equal(finishReplayHash(state), native(bytes));
  assert.equal(finishReplayHash(advanceReplayHash(state,new Uint8Array([1]))),native(Buffer.concat([bytes,Buffer.from([1])])));
});

test('update, finish and serialization preserve the caller state',()=>{
  const state=advanceReplayHash(initialReplayHash(),Buffer.from('partial'));const before=structuredClone(state);
  advanceReplayHash(state,Buffer.from('next'));finishReplayHash(state);encodeReplayHash(state);
  assert.deepEqual(state,before);assert.equal(finishReplayHash(advanceReplayHash(state,new Uint8Array())),native(Buffer.from('partial')));
});

test('stream exceeds former8MiB capture-only ceiling with native digest equivalence',()=>{
 const block=Buffer.alloc(65536,0x61),nativeHash=createHash('sha256');let state=initialReplayHash();
 for(let n=0;n<145;n++){nativeHash.update(block);state=advanceReplayHash(decodeReplayHash(encodeReplayHash(state)),block);}
 assert.ok(state.bytes>8*1024*1024);assert.equal(finishReplayHash(state),nativeHash.digest('hex'));
});
test('safe byte counters cross32-bit and SHA length-high-word boundaries without wrap',()=>{
 for(const bytes of [0x20000000-64,0x100000000-64]){
  const base={...initialReplayHash(),bytes,pending:[]};const next=advanceReplayHash(decodeReplayHash(encodeReplayHash(base)),Buffer.alloc(64));
  assert.equal(next.bytes,bytes+64);assert.equal(decodeReplayHash(encodeReplayHash(next)).bytes,bytes+64);assert.match(finishReplayHash(next),/^[a-f0-9]{64}$/);
 }
 const last={...initialReplayHash(),bytes:Number.MAX_SAFE_INTEGER,pending:new Array(63).fill(0)};
 assert.throws(()=>advanceReplayHash(last,Buffer.alloc(1)),/input limit/);
});
