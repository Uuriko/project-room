// The search refine debounce (NEXT-7): a keystroke must restart the 500ms
// window, so the network refine fires 500ms after the LAST keystroke. The
// first-key-only version let a keystroke at t=400 leave the t=0 timer
// firing at t=500, refining mid-typing.
import test from "node:test";
import assert from "node:assert/strict";
import { createDebounce } from "../src/debounce.js";

test("the debounce fires 500ms after the last call, not the first", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const d = createDebounce(() => { fired += 1; }, 500);
  d.schedule(); // key at t=0
  t.mock.timers.tick(400);
  d.schedule(); // key at t=400: restarts the window
  t.mock.timers.tick(100); // t=500: the first-key bug fired here
  assert.equal(fired, 0);
  t.mock.timers.tick(400); // t=900: 500ms after the last keystroke
  assert.equal(fired, 1);
  // Rapid typing keeps pushing the window back; one fire per quiet gap.
  d.schedule();
  d.schedule();
  d.schedule();
  t.mock.timers.tick(499);
  assert.equal(fired, 1);
  t.mock.timers.tick(1);
  assert.equal(fired, 2);
});

test("cancel stops a pending fire without running fn", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const d = createDebounce(() => { fired += 1; }, 500);
  d.schedule();
  assert.equal(d.pending(), true);
  d.cancel();
  assert.equal(d.pending(), false);
  t.mock.timers.tick(1000);
  assert.equal(fired, 0);
});
