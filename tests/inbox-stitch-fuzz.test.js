// REL-17: inbox stitch correctness under out-of-order and duplicate input.
// A stitched timeline must not depend on the order the importer saw the
// messages, and a message delivered twice must appear once.
import test from "node:test";
import assert from "node:assert/strict";
import { stitchThreads } from "../server/inbox-stitch.mjs";

// Small deterministic PRNG so a failure is reproducible from its seed.
const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const shuffle = (list, rand) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const CHANNELS = ["email", "telegram", "x"];
function corpus(rand) {
  const keys = ["k1", "k2", "k3"];
  const link = new Map(); const chan = new Map(); const threads = [];
  let n = 0;
  for (let t = 0; t < 6; t++) {
    const channel = CHANNELS[t % CHANNELS.length];
    const entries = [];
    for (let e = 0; e < 5; e++) {
      const id = `src-${n++}`;
      link.set(id, keys[Math.floor(rand() * keys.length)]);
      chan.set(id, channel);
      // Coarse minutes force timestamp ties across channels.
      const minute = Math.floor(rand() * 6);
      entries.push({ sourceId: id, occurredAt: `2026-10-01T10:0${minute}:00.000Z` });
    }
    threads.push({ threadId: `${channel}-t${t}`, entries });
  }
  return { threads, linkOf: id => link.get(id) ?? null, channelOf: id => chan.get(id) ?? null };
}
const view = result => result.map(g => ({ key: g.stitchKey, channels: g.channels, sources: g.sources }));

test("stitched timelines do not depend on input order (200 seeds)", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed);
    const { threads, linkOf, channelOf } = corpus(rand);
    const base = view(stitchThreads(threads, { linkOf, channelOf }));
    const shuffled = shuffle(threads, rand).map(th => ({ ...th, entries: shuffle(th.entries, rand) }));
    assert.deepEqual(view(stitchThreads(shuffled, { linkOf, channelOf })), base, `seed ${seed}`);
  }
});

test("a message delivered twice appears once in its stitched timeline (200 seeds)", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed);
    const { threads, linkOf, channelOf } = corpus(rand);
    const base = view(stitchThreads(threads, { linkOf, channelOf }));
    // Duplicate some entries inside their thread, and re-deliver one whole thread.
    const dup = threads.map(th => ({ ...th, entries: th.entries.flatMap(e => (rand() < 0.3 ? [e, { ...e }] : [e])) }));
    dup.push({ ...dup[0], entries: dup[0].entries.map(e => ({ ...e })) });
    const got = view(stitchThreads(dup, { linkOf, channelOf }));
    for (const g of got) assert.equal(new Set(g.sources).size, g.sources.length, `seed ${seed}: duplicate source in ${g.key}`);
    assert.deepEqual(got, base, `seed ${seed}`);
  }
});

test("equal instants in different ISO forms order by time, not by string", () => {
  const link = () => "k";
  const chan = id => (id.startsWith("e") ? "email" : "telegram");
  const threads = [
    { threadId: "a", entries: [{ sourceId: "e1", occurredAt: "2026-10-01T10:00:00.500Z" }] },
    { threadId: "b", entries: [{ sourceId: "t1", occurredAt: "2026-10-01T10:00:00Z" }] },
    { threadId: "c", entries: [{ sourceId: "t2", occurredAt: "2026-10-01T03:00:01-07:00" }] }
  ];
  const [g] = stitchThreads(threads, { linkOf: link, channelOf: chan });
  assert.deepEqual(g.sources, ["t1", "e1", "t2"]);
});
