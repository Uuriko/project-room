// E-H1: needs-attention fetch failure must be visible and retryable.
// Regression test for the bug where refresh()'s catch wrote the error into
// the hidden section (whose Refresh button lives inside it) and scheduled
// no retry — so an owner whose first fetch failed saw nothing all session.
//
// Test audit gate:
// 1. Protects: on fetch failure the section unhides (error + Refresh become
//    visible) and an automatic retry is scheduled.
// 2. Fails when: the catch block no longer unhides the section, or no retry
//    is scheduled (e.g. someone removes scheduleRetry()).
// 3. No existing test covers src/needs-attention.js at all.
// 4. No production seam added: the module already takes { client, section };
//    the test supplies fakes for both, plus a stub document.activeElement.
import test from "node:test";
import assert from "node:assert/strict";
import { createNeedsAttentionCard } from "../src/needs-attention.js";

function stubElement() {
  return {
    hidden: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    addEventListener() {},
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
  };
}

function makeSection() {
  const elements = {
    "#attention-list": stubElement(),
    "#attention-count": stubElement(),
    "#attention-status": stubElement(),
    "#attention-refresh": stubElement(),
    "#attention-pages": stubElement(),
    "#attention-range": stubElement(),
    "#attention-previous": stubElement(),
    "#attention-next": stubElement(),
  };
  return {
    hidden: true, // authored hidden, like index.html
    querySelector: sel => elements[sel] ?? stubElement(),
    _elements: elements,
  };
}

function makeClient({ failWith = null } = {}) {
  let calls = 0;
  return {
    session: { id: "sess-1" },
    generation: 1,
    calls: () => calls,
    needsAttention: async () => {
      calls++;
      if (failWith) throw failWith;
      return { items: [], itemCount: 0, pageOffset: 0 };
    },
  };
}

test("failed refresh unhides the section so the error and Refresh button are visible", async () => {
  const section = makeSection();
  const client = makeClient({ failWith: new Error("network down") });
  const card = createNeedsAttentionCard({ client, section });
  // Stub document.activeElement used by refresh(), and timers so the
  // scheduled retry doesn't fire after the test with a torn-down document.
  const prevDocument = globalThis.document;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.document = { activeElement: null };
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
  try {
    await card.refresh();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  assert.equal(section.hidden, false, "section unhidden on fetch failure");
  const status = section._elements["#attention-status"].textContent;
  assert.match(status, /Could not load: network down/, "error is reported in the status line");
});

test("failed refresh schedules an automatic retry", async () => {
  const section = makeSection();
  const client = makeClient({ failWith: new Error("timeout") });
  const card = createNeedsAttentionCard({ client, section });

  // Capture the scheduled retry instead of waiting 30s.
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const id = timers.length; timers.push({ fn, ms }); return id; };
  globalThis.clearTimeout = id => { if (timers[id]) timers[id] = null; };
  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    await card.refresh();
    assert.equal(timers.filter(Boolean).length, 1, "one retry scheduled after failure");
    assert.ok(timers[0].ms >= 1000, `retry delay is sane (${timers[0].ms}ms)`);

    // Fire the retry: with the client now healthy it succeeds and hides the
    // empty section again (render() hides when there are no items).
    client.needsAttention = async () => { return { items: [], itemCount: 0, pageOffset: 0 }; };
    const retryFn = timers[0].fn;
    timers[0] = null;
    await retryFn();
    assert.equal(section.hidden, true, "section hides again after successful retry with no items");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test("manual refresh supersedes a scheduled retry (no double fetch)", async () => {
  const section = makeSection();
  let calls = 0;
  const client = {
    session: { id: "sess-1" },
    generation: 1,
    needsAttention: async () => { calls++; throw new Error("flaky"); },
  };
  const card = createNeedsAttentionCard({ client, section });

  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const id = timers.length; timers.push({ fn, ms }); return id; };
  globalThis.clearTimeout = id => { if (timers[id]) timers[id] = null; };
  const prevDocument = globalThis.document;
  globalThis.document = { activeElement: null };
  try {
    await card.refresh(); // fails, schedules retry #1
    assert.equal(calls, 1);
    assert.equal(timers.filter(Boolean).length, 1);
    await card.refresh(); // manual retry: must clear the scheduled one first
    assert.equal(calls, 2);
    assert.equal(timers.filter(Boolean).length, 1, "only the latest retry remains scheduled");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});
