// G019: event sampling. Pure sampler tests.
import test from "node:test";
import assert from "node:assert/strict";
import { shouldKeep, sampleEvents, SampleError } from "../server/event-sampling.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SampleError && error.code === code);

test("shouldKeep is deterministic and respects boundaries", () => {
  assert.equal(shouldKeep({ eventId: "e1", sampleRate: 1 }), true);
  assert.equal(shouldKeep({ eventId: "e1", sampleRate: 0 }), false);
  const a = shouldKeep({ eventId: "stable-id", sampleRate: 0.5 });
  const b = shouldKeep({ eventId: "stable-id", sampleRate: 0.5 });
  assert.equal(a, b); // deterministic
});
test("sampleEvents keeps a stable subset", () => {
  const events = Array.from({ length: 100 }, (_, i) => ({ eventId: `e${i}` }));
  const first = sampleEvents({ events, sampleRate: 0.2 });
  const second = sampleEvents({ events, sampleRate: 0.2 });
  assert.deepEqual(first.kept.map(e => e.eventId), second.kept.map(e => e.eventId));
  assert.ok(first.keptCount > 0 && first.keptCount < 100);
  assert.equal(first.totalCount, 100);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.kept));
});
test("malformed inputs are refused", () => {
  throwsCode(() => shouldKeep({ eventId: "", sampleRate: 0.5 }), "invalid_sample");
  throwsCode(() => shouldKeep({ eventId: "e", sampleRate: 2 }), "invalid_sample");
  throwsCode(() => sampleEvents({ events: [null], sampleRate: 0.5 }), "invalid_sample");
});
