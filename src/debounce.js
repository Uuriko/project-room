// A true debounce: every call (or schedule()) clears any pending timer and
// restarts the window, so fn fires delayMs after the LAST call, never after
// the first (the first-key-only version let a refine land 100ms after a late
// keystroke). Returned as a callable with cancel()/pending() so existing
// call sites that invoke it directly keep working, and the timer stays
// testable with fake timers (tests/debounce.test.js).
export function createDebounce(fn, delayMs) {
  let timer = 0;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      fn(...args);
    }, delayMs);
  };
  debounced.schedule = debounced;
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = 0;
  };
  debounced.pending = () => timer !== 0;
  return debounced;
}
