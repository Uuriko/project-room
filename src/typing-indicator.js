// Typing indicator with a client-side expiry. Typing state arrives as
// synthetic `typing` SSE events that the server emits only when the visible
// typist set changes, and heartbeats expire server-side after 10s. A stalled
// stream can stop delivering those events entirely, in which case the last
// "X is typing…" would freeze on screen forever — the zombie the expiry
// exists to prevent. Every render that shows names (re)arms a local timer;
// when the timer fires with no newer update, the indicator hides itself.
// The timer is never a progress claim: the copy stays an honest "typing…"
// with no implied progress, and the indicator is plain text, not a spinner.
export const TYPING_CLIENT_TTL_MS = 15_000; // server beat TTL (10s) + grace

// Timers are injectable so tests can advance time deterministically.
export function createTypingIndicator({ lookup = () => null, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, ttlMs = TYPING_CLIENT_TTL_MS } = {}) {
  let timer = null;
  function hide() {
    const el = lookup();
    if (el) { el.hidden = true; el.textContent = ""; }
  }
  function disarm() {
    if (timer !== null) { clearTimeoutFn(timer); timer = null; }
  }
  function render(typists) {
    const el = lookup();
    if (!el) return;
    disarm();
    const names = (typists ?? []).map(t => t.displayName || t.memberId).filter(Boolean).slice(0, 3);
    const extra = (typists ?? []).length - names.length;
    if (!names.length) { el.hidden = true; el.textContent = ""; return; }
    const who = extra > 0 ? `${names.join(", ")} and ${extra} other${extra === 1 ? "" : "s"}` : names.join(" and ");
    el.textContent = `${who} ${names.length + extra === 1 ? "is" : "are"} typing…`;
    el.hidden = false;
    // Armed even when the stream is healthy: each fresh `typing` event
    // re-arms it, so this only fires when updates stop arriving.
    timer = setTimeoutFn(() => { timer = null; hide(); }, ttlMs);
  }
  return { render, clear: () => { disarm(); hide(); } };
}
