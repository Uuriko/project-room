// Run with Node and git available; optional first argument is the JSON output.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event } from '../src/events.js';
import { ReplyRequests as Candidate } from '../server/reply-requests.mjs';

const root = new URL('../', import.meta.url), git = process.env.ROOM_BENCH_GIT || 'git';
const baseline = 'ee846dc21f2576e9880b98d88ad2544b0c1288b8';
const source = execFileSync(git, ['show', `${baseline}:server/reply-requests.mjs`], { cwd: root }).toString()
  .replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
    (_, prefix, path, quote) => prefix + new URL(path, new URL('../server/reply-requests.mjs', import.meta.url)).href + quote);
const { ReplyRequests: Baseline } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const raw = [], results = [];
for (const count of [100, 1000, 5000]) {
  const store = new RoomStore(':memory:', { bodiesAtRest: true });
  try {
    const seed = initialRoom();
    seed.push(event({ type: 'member.added', actorId: 'owner', roomId: 'commons',
      data: { memberId: 'reader', displayName: 'Reader', kind: 'human', permissions: [] } }));
    for (let i = 0; i < count; i++) seed.push(event({ type: 'message.posted', actorId: 'owner', roomId: 'commons',
      data: { messageId: `m-${i}`, body: `Unrelated ${i} ` + 'x'.repeat(2000) } }));
    store.initialize(seed);
    const owner = store.issueAccessKey('commons', 'owner'), reader = store.issueAccessKey('commons', 'reader');
    store.dmConsents.request('commons', 'owner', 'reader', 'Test');
    store.dmConsents.decide('commons', 'reader', 'owner', 'approve');
    store.command(owner, 'commons', { id: 'ask', type: 'message.posted',
      data: { messageId: 'ask', body: 'Selected question', toMemberId: 'reader', requestKind: 'reply' } });
    const impl = { baseline: new Baseline(store), candidate: new Candidate(store) };
    for (const phase of ['cold', 'warm']) {
      const times = { baseline: [], candidate: [] };
      for (let round = 0; round < 12; round++) {
        for (const name of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          if (phase === 'cold') {
            store._dropProjectionCache();
            if (name === 'candidate') impl.candidate = new Candidate(store);
          }
          const start = performance.now();
          const result = impl[name].selected(reader, 'commons', 'ask', { limit: 1 });
          const ms = performance.now() - start;
          times[name].push(ms); raw.push({ count, phase, round, name, ms });
          if (result.page.items[0].message.body !== 'Selected question' || !result.current.answerBasis)
            throw new Error('Semantic mismatch');
        }
      }
      results.push({ count, phase, ...Object.fromEntries(Object.entries(times).map(([name, values]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return [name, { medianMs: (sorted[5] + sorted[6]) / 2, maxMs: sorted.at(-1), samples: values.length }];
      })) });
    }
  } finally { store.close(); }
}
const sourceHashes = Object.fromEntries(['server/reply-requests.mjs', 'cloudflare/storage.mjs'].map(path =>
  [path, createHash('sha256').update(fs.readFileSync(new URL(path, root))).digest('hex')]));
const report = { baseline, sourceHashes, raw, results,
  method: '12 alternating samples, identical SQLite store, distinct 2KB bodies. Cold resets projection and integrity caches, not machine cold. Warm retains both. Shared baseline imports use current code. No production latency claim.' };
fs.writeFileSync(process.argv[2] || 'reply-integrity-comparison.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(results));
