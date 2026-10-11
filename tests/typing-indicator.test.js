// Typing indicators must never zombie. The client only clears the indicator
// when a synthetic `typing` SSE event arrives, and a stalled stream can stop
// delivering those events — the server-side beat expiry cannot save the
// client when the event never arrives. Every update that shows names must
// (re)arm a client-side expiry so the indicator hides itself when updates
// stop. Minimal DOM stand-ins; no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { createTypingIndicator, TYPING_CLIENT_TTL_MS } from "../src/typing-indicator.js";

function fakeTimers() {
  let now = 0, seq = 0;
  const pending = new Map();
  return {
    setTimeoutFn(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeoutFn(id) { pending.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = target;
    },
    pendingCount() { return pending.size; },
  };
}

function fakeElement() { return { hidden: true, textContent: "" }; }

function indicator(timers, el, ttlMs = TYPING_CLIENT_TTL_MS) {
  return createTypingIndicator({
    lookup: () => el,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ttlMs,
  });
}

const fo = { memberId: "m-fo", displayName: "Fo" };

test("renders who is typing, honestly", () => {
  const timers = fakeTimers(), el = fakeElement();
  const ti = indicator(timers, el);
  ti.render([fo]);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, "Fo is typing…");
});

test("two typists read as plural", () => {
  const timers = fakeTimers(), el = fakeElement();
  const ti = indicator(timers, el);
  ti.render([{ memberId: "m-a", displayName: "A" }, { memberId: "m-b", displayName: "B" }]);
  assert.equal(el.textContent, "A and B are typing…");
});

test("more than three typists collapse into a count, never fake names", () => {
  const timers = fakeTimers(), el = fakeElement();
  const ti = indicator(timers, el);
  const typists = ["A", "B", "C", "D"].map((name, i) => ({ memberId: `m-${i}`, displayName: name }));
  ti.render(typists);
  assert.equal(el.textContent, "A, B, C and 1 other are typing…");
});

test("an empty update hides the indicator", () => {
  const timers = fakeTimers(), el = fakeElement();
  const ti = indicator(timers, el);
  ti.render([fo]);
  assert.equal(el.hidden, false);
  ti.render([]);
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, "");
});

test("a missing element never throws", () => {
  const timers = fakeTimers();
  const ti = createTypingIndicator({ lookup: () => null, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn });
  ti.render([fo]);
  timers.advance(TYPING_CLIENT_TTL_MS + 1);
  ti.clear();
});

test("the indicator hides itself when updates stop arriving — no zombie", () => {
  const timers = fakeTimers(), el = fakeElement();
  const ti = indicator(timers, el);
  ti.render([fo]);
  assert.equal(el.hidden, false);
  // The server-side beat expiry cannot help: no further event ever arrives.
  timers.advance(TYPING_CLIENT_TTL_MS + 1);
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, "");
});

test("a fresh update re-arms the expiry", () => {
  const timers = fakeTimers(), el = fakeElement();
  const ti = indicator(timers, el);
  ti.render([fo]);
  timers.advance(TYPING_CLIENT_TTL_MS - 1);
  ti.render([fo]); // heartbeat keeps coming: still typing, still shown
  timers.advance(TYPING_CLIENT_TTL_MS - 1);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, "Fo is typing…");
  assert.equal(timers.pendingCount(), 1);
});

test("clear() hides immediately and disarms the timer", () => {
  const timers = fakeTimers(), el = fakeElement();
  const ti = indicator(timers, el);
  ti.render([fo]);
  assert.equal(timers.pendingCount(), 1);
  ti.clear();
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, "");
  assert.equal(timers.pendingCount(), 0);
  timers.advance(TYPING_CLIENT_TTL_MS + 1);
  assert.equal(el.hidden, true);
});
