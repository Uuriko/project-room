// Test-only clock (backlog TST-11). Tests that read the wall clock while the
// code under test reads an injected clock drift apart: a slow runner, or an
// advance() between steps, moves one and not the other, and boundary checks
// flake. Give the store and the assertions the same clock instead.
//
//   const clock = createTestClock();                // starts at the real now
//   const store = new RoomStore(file, { now: clock.now });
//   clock.advance(1000);
//   assert.equal(row.expires_at, clock.now() + TTL);
//
// freezeDate(t, at) also pins the global Date for one test (node:test mock
// timers, Date only, so real setTimeout waits still run). Use it when the code
// under test calls Date.now() directly and takes no clock.

export function createTestClock(start = Date.now()) {
  if (!Number.isFinite(start)) throw new TypeError("createTestClock: start must be a finite epoch ms");
  let current = Math.trunc(start);
  return {
    now: () => current,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError("advance: ms must be a finite number >= 0");
      current += Math.trunc(ms);
      return current;
    },
    set(ms) {
      if (!Number.isFinite(ms)) throw new TypeError("set: ms must be a finite epoch ms");
      current = Math.trunc(ms);
      return current;
    },
    iso: (offsetMs = 0) => new Date(current + offsetMs).toISOString(),
  };
}

export function freezeDate(t, at = Date.now()) {
  t.mock.timers.enable({ apis: ["Date"], now: at });
  return {
    now: () => Date.now(),
    advance(ms) { t.mock.timers.tick(ms); return Date.now(); },
  };
}
